package handlers

// S-2/E5 revocable sessions + S-4/S-5 role enforcement. Pure tests run
// anywhere; DB-backed ones skip without DATABASE_URL (point it at a scratch DB).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
	"golang.org/x/crypto/bcrypt"

	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// stubTokenVersion is the package-wide test lookup (installed by TestMain):
// the real token_version when the user row exists, 0 for the synthetic users
// most tests mint tokens for.
func stubTokenVersion(ctx context.Context, h *AuthHandler, userID string) (int, error) {
	if h.srv == nil || h.srv.Pool == nil {
		return 0, nil
	}
	if tv, err := dbTokenVersion(ctx, h, userID); err == nil {
		return tv, nil
	}
	return 0, nil
}

// useRealSessionLookup turns the production lookup back on for one test.
func useRealSessionLookup(t *testing.T) {
	t.Helper()
	prev := tokenVersionLookup
	tokenVersionLookup = dbTokenVersion
	t.Cleanup(func() { tokenVersionLookup = prev })
}

func signClaims(t *testing.T, c PalClaims) string {
	t.Helper()
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// sess builds user-session claims (a Subject, no APIKeyID) for a role.
func sess(role string) *PalClaims {
	return &PalClaims{RegisteredClaims: jwt.RegisteredClaims{Subject: "u-" + role}, Role: role}
}

func sessionClaims(role string, lifetime time.Duration) PalClaims {
	now := time.Now()
	return PalClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject: "u-ttl", IssuedAt: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(lifetime)), Issuer: "pal",
		},
		TenantID: devTenantID, Role: role,
	}
}

// ---------- pure ----------

func TestParseJWTTTL(t *testing.T) {
	cases := []struct {
		in      string
		want    time.Duration
		wantErr bool
	}{
		{"", 12 * time.Hour, false},
		{"8h", 8 * time.Hour, false},
		{"5m", 5 * time.Minute, false},
		{"24h", 24 * time.Hour, false},
		{"25h", 0, true},    // above the max
		{"4m", 0, true},     // below the min
		{"720h", 0, true},   // the old 30-day lifetime
		{"twelve", 0, true}, // not a duration
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, err := parseJWTTTL(tc.in)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("parseJWTTTL(%q) = %v, %v; want %v, err=%v", tc.in, got, err, tc.want, tc.wantErr)
			}
			t.Setenv("PAL_JWT_TTL", tc.in)
			if (CheckJWTTTL() != nil) != tc.wantErr {
				t.Fatalf("CheckJWTTTL disagrees with parseJWTTTL for %q", tc.in)
			}
		})
	}
}

// TestValidateToken_LifetimeCappedByTTL: a token whose lifetime exceeds
// PAL_JWT_TTL is refused even when unexpired, which retires every 30-day
// token minted before this change. Kiosk keeps its own TTL (unchanged).
func TestValidateToken_LifetimeCappedByTTL(t *testing.T) {
	h := NewAuthHandler(&server.Server{Logger: zap.NewNop()}, testJWTSecret)
	cases := []struct {
		name, ttl, role string
		lifetime        time.Duration
		ok              bool
	}{
		{"default 12h accepts 1h", "", "owner", time.Hour, true},
		{"default 12h accepts 12h", "", "owner", 12 * time.Hour, true},
		{"legacy 30-day token refused", "", "owner", 30 * 24 * time.Hour, false},
		{"13h refused under 12h", "", "member", 13 * time.Hour, false},
		{"configured 1h refuses 2h", "1h", "owner", 2 * time.Hour, false},
		{"kiosk exempt", "1h", kioskRole, 3 * time.Hour, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PAL_JWT_TTL", tc.ttl)
			_, err := h.ValidateToken(context.Background(), signClaims(t, sessionClaims(tc.role, tc.lifetime)))
			if (err == nil) != tc.ok {
				t.Fatalf("ok=%v, err=%v", tc.ok, err)
			}
		})
	}
	// No iat → no provable lifetime → refused.
	c := sessionClaims("owner", time.Hour)
	c.IssuedAt = nil
	if _, err := h.ValidateToken(context.Background(), signClaims(t, c)); err == nil {
		t.Fatal("token without iat accepted")
	}
}

func TestSessionCache_ExpiresAndDrops(t *testing.T) {
	var c sessionCache
	now := time.Now()
	c.put("u", 3, now, c.currentEpoch())
	if tv, ok := c.get("u", now.Add(sessionCacheTTL-time.Second)); !ok || tv != 3 {
		t.Fatalf("fresh entry: got %d %v", tv, ok)
	}
	if _, ok := c.get("u", now.Add(sessionCacheTTL)); ok {
		t.Fatal("entry served past sessionCacheTTL")
	}
	c.put("u", 3, now, c.currentEpoch())
	c.drop("u")
	if _, ok := c.get("u", now); ok {
		t.Fatal("dropped entry still served")
	}
}

// TestHasScope_Roles pins the role→scope map (S-4/E4).
func TestHasScope_Roles(t *testing.T) {
	all := []Scope{ScopeRead, ScopeWrite, ScopeAdmin, ScopeAgentsRead, ScopeAgentsWrite,
		ScopeRunsRead, ScopeRunsWrite, ScopeRunsExecute, ScopeConnectorsRead, ScopeConnectorsWrite,
		ScopeBudgetsRead, ScopeBudgetsWrite, ScopeSettingsRead, ScopeSettingsWrite}
	allow := map[string][]Scope{
		"owner":  all,
		"admin":  all,
		"member": {ScopeRead, ScopeAgentsRead, ScopeAgentsWrite, ScopeRunsRead, ScopeRunsWrite, ScopeRunsExecute, ScopeConnectorsRead, ScopeBudgetsRead, ScopeSettingsRead},
		"viewer": {ScopeRead, ScopeAgentsRead, ScopeRunsRead, ScopeConnectorsRead, ScopeBudgetsRead, ScopeSettingsRead},
		// Unknown roles get viewer.
		"intern": {ScopeRead, ScopeAgentsRead, ScopeRunsRead, ScopeConnectorsRead, ScopeBudgetsRead, ScopeSettingsRead},
	}
	for role, want := range allow {
		for _, s := range all {
			exp := false
			for _, w := range want {
				exp = exp || w == s
			}
			if got := HasScope(sess(role), s); got != exp {
				t.Errorf("role %s scope %s: got %v, want %v", role, s, got, exp)
			}
		}
	}
	// Kiosk is unchanged: only its token scopes, and none without them.
	k := &PalClaims{Role: kioskRole, Scopes: kioskScopes}
	for s, want := range map[Scope]bool{ScopeAgentsWrite: true, ScopeRunsExecute: true, ScopeSettingsWrite: false, ScopeBudgetsWrite: false, ScopeBudgetsRead: true} {
		if HasScope(k, s) != want {
			t.Errorf("kiosk %s: want %v", s, want)
		}
	}
	if HasScope(&PalClaims{Role: kioskRole}, ScopeRead) {
		t.Error("scopeless kiosk granted read")
	}
	// API keys are unchanged: an unscoped key is unrestricted, a scoped key holds its scopes.
	if !HasScope(&PalClaims{Role: "service"}, ScopeAdmin) || HasScope(&PalClaims{Role: "service", Scopes: []string{ScopeRead}}, ScopeAgentsWrite) {
		t.Error("API-key scope semantics changed")
	}
}

func TestCanManageBilling_OwnerOnly(t *testing.T) {
	for role, want := range map[string]bool{"owner": true, "admin": false, "member": false, "viewer": false, kioskRole: false} {
		if canManageBilling(&PalClaims{Role: role}) != want {
			t.Errorf("%s: want %v", role, want)
		}
	}
	if !canManageBilling(&PalClaims{Role: "service", Scopes: []string{ScopeSettingsWrite}}) {
		t.Error("settings:write key lost billing")
	}
}

// matrixLine matches one role row of apps/web/lib/rbac.ts MATRIX.
var matrixLine = regexp.MustCompile(`^\s*(owner|admin|member|viewer|kiosk):\s*\[([^\]]*)\]`)

// TestRoleScopesMatchDashboardMatrix keeps the dashboard's role matrix (the
// UI's single source, apps/web/lib/rbac.ts) and the server's roleScopes from
// drifting: for every dashboard capability the server also knows as a scope,
// "the UI offers it" must equal "the server allows it".
func TestRoleScopesMatchDashboardMatrix(t *testing.T) {
	src, err := os.ReadFile("../../../../apps/web/lib/rbac.ts")
	if err != nil {
		t.Fatalf("read rbac.ts: %v", err)
	}
	body := string(src)
	start := strings.Index(body, "const MATRIX")
	if start < 0 {
		t.Fatal("rbac.ts: MATRIX not found")
	}
	body = body[start:]
	body = body[:strings.Index(body, "\n};")]
	matrix := map[string]map[string]bool{}
	for _, line := range strings.Split(body, "\n") {
		m := matrixLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		caps := map[string]bool{}
		for _, c := range regexp.MustCompile(`"([^"]+)"`).FindAllStringSubmatch(m[2], -1) {
			caps[c[1]] = true
		}
		matrix[m[1]] = caps
	}
	if len(matrix) != 5 {
		t.Fatalf("parsed %d roles from MATRIX, want 5 — has its shape changed?", len(matrix))
	}
	// Capabilities that are server scopes ("write" is the coarse scope the
	// personal/owner-life routes use). Others (runtime:*, promotions:*,
	// audit:read, owner) are role checks in handlers, pinned elsewhere.
	shared := []Scope{ScopeAgentsRead, ScopeAgentsWrite, ScopeRunsExecute, ScopeBudgetsRead,
		ScopeBudgetsWrite, ScopeSettingsWrite, ScopeConnectorsWrite, ScopeWrite}
	for role, caps := range matrix {
		c := sess(role)
		if role == kioskRole {
			c.Scopes = kioskScopes
		}
		for _, s := range shared {
			if ui, srv := caps[s], HasScope(c, s); ui != srv {
				t.Errorf("role %s, %s: dashboard offers=%v, server allows=%v", role, s, ui, srv)
			}
		}
		// "owner" capability = workspace erase/export/billing: owner only.
		if caps["owner"] != (role == "owner") {
			t.Errorf("role %s: owner capability mismatch", role)
		}
	}
}

// TestRequireSessionRole: sessions outside the list get 403; API keys and
// listed roles reach the handler.
func TestRequireSessionRole(t *testing.T) {
	h := NewAuthHandler(&server.Server{Logger: zap.NewNop()}, testJWTSecret)
	next := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) }
	for _, tc := range []struct {
		c    *PalClaims
		want int
	}{
		{sess("owner"), http.StatusTeapot},
		{sess("admin"), http.StatusTeapot},
		{sess("member"), http.StatusForbidden},
		{sess("viewer"), http.StatusForbidden},
		{&PalClaims{Role: "service", Scopes: []string{ScopeAgentsWrite}}, http.StatusTeapot},
	} {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/x", nil)
		h.RequireSessionRole(AdminRoles, next)(rr, req.WithContext(storeClaimsInCtx(req.Context(), tc.c)))
		if rr.Code != tc.want {
			t.Errorf("role %s: got %d, want %d", tc.c.Role, rr.Code, tc.want)
		}
	}
}

// ---------- DB-backed ----------

func getMe(h *AuthHandler, token string) int {
	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.GetMe(rr, req)
	return rr.Code
}

func tokenOf(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	var resp authResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil || resp.Token == "" {
		t.Fatalf("no token in %d %s", rr.Code, rr.Body.String())
	}
	return resp.Token
}

func callAuthed(fn http.HandlerFunc, method, token string) int {
	req := httptest.NewRequest(method, "/x", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	fn(rr, req)
	return rr.Code
}

// signedUp creates a dev owner and returns (handler, email, owner token).
func signedUp(t *testing.T) (*AuthHandler, *captureMailer, string, string) {
	t.Helper()
	setSignupEnv(t, "", "open", "")
	useRealSessionLookup(t)
	h, m := newLifecycleHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })
	rr := doSignup(h, email, "correct-horse-battery", "Owner")
	return h, m, email, tokenOf(t, rr)
}

func TestSessions_LogoutRevokesEverySession(t *testing.T) {
	h, _, email, first := signedUp(t)
	second := tokenOf(t, doLogin(h, email, "correct-horse-battery"))
	if getMe(h, first) != 200 || getMe(h, second) != 200 {
		t.Fatal("fresh sessions refused")
	}
	// Another replica that has already cached this user's version.
	h2 := NewAuthHandler(h.srv, testJWTSecret)
	if getMe(h2, first) != 200 {
		t.Fatal("replica refused a fresh session")
	}

	logout := h.WithScope(ScopeRead, h.Logout)
	if code := callAuthed(logout, http.MethodPost, first); code != http.StatusNoContent {
		t.Fatalf("logout: got %d", code)
	}
	// Same replica: both sessions (all devices) die at once.
	if getMe(h, first) != 401 || getMe(h, second) != 401 {
		t.Fatal("session survived logout on the replica that handled it")
	}
	// Other replica: the documented window — honored until its cache entry
	// ages out, refused after.
	if getMe(h2, second) != 200 {
		t.Fatal("replica cache not exercised")
	}
	h2.sessions.mu.Lock()
	for k, e := range h2.sessions.m {
		e.at = e.at.Add(-sessionCacheTTL)
		h2.sessions.m[k] = e
	}
	h2.sessions.mu.Unlock()
	if getMe(h2, second) != 401 {
		t.Fatal("replica honored a revoked session past sessionCacheTTL")
	}
	// A new login works.
	if getMe(h, tokenOf(t, doLogin(h, email, "correct-horse-battery"))) != 200 {
		t.Fatal("re-login after logout refused")
	}
	// An API key cannot "log out".
	if code := callAuthed(h.Logout, http.MethodPost, first); code != http.StatusBadRequest {
		t.Fatalf("logout without session claims: got %d", code)
	}
}

func TestSessions_PasswordResetRevokes(t *testing.T) {
	h, m, email, tok := signedUp(t)
	m.waitFor(t, email) // verification mail
	callJSON(h.ForgotPassword, "/auth/forgot", map[string]string{"email": email})
	var reset string
	deadline := time.Now().Add(2 * time.Second)
	for reset == "" && time.Now().Before(deadline) {
		m.mu.Lock()
		for _, msg := range m.msgs {
			if msg.To == email && strings.Contains(msg.Subject, "Reset") {
				reset = tokenInLink.FindStringSubmatch(msg.Text)[1]
			}
		}
		m.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	if reset == "" {
		t.Fatal("no reset mail")
	}
	if rr := callJSON(h.ResetPassword, "/auth/reset", map[string]string{"token": reset, "password": "brand-new-password-1"}); rr.Code != 200 {
		t.Fatalf("reset: %d %s", rr.Code, rr.Body.String())
	}
	if getMe(NewAuthHandler(h.srv, testJWTSecret), tok) != 401 {
		t.Fatal("pre-reset session survived the password reset")
	}
	if getMe(h, tokenOf(t, doLogin(h, email, "brand-new-password-1"))) != 200 {
		t.Fatal("post-reset login refused")
	}
}

func TestSessions_RoleChangeRevokes(t *testing.T) {
	h, _, email, tok := signedUp(t)
	replica := NewAuthHandler(h.srv, testJWTSecret)
	if getMe(replica, tok) != 200 { // the replica caches the pre-change version
		t.Fatal("fresh session refused")
	}
	if _, err := h.srv.Pool.Exec(context.Background(), `UPDATE users SET role = 'viewer' WHERE email = $1`, email); err != nil {
		t.Fatal(err)
	}
	if getMe(NewAuthHandler(h.srv, testJWTSecret), tok) != 401 {
		t.Fatal("owner token survived a demotion")
	}
	// The re-login after the change is honored at once even by the replica
	// whose cache still holds the old version (it is stale, not a revocation).
	if code := getMe(replica, tokenOf(t, doLogin(h, email, "correct-horse-battery"))); code != 200 {
		t.Fatalf("post-change login refused by a replica with a stale cache: %d", code)
	}
	if getMe(replica, tok) != 401 {
		t.Fatal("replica accepted the pre-change token after refreshing")
	}
	// A touch that changes neither role nor password keeps sessions alive.
	fresh := tokenOf(t, doLogin(h, email, "correct-horse-battery"))
	if _, err := h.srv.Pool.Exec(context.Background(), `UPDATE users SET last_seen_at = now(), role = role WHERE email = $1`, email); err != nil {
		t.Fatal(err)
	}
	if getMe(NewAuthHandler(h.srv, testJWTSecret), fresh) != 200 {
		t.Fatal("no-op update revoked the session")
	}
}

func TestSessions_WorkspaceDeletionRevokes(t *testing.T) {
	h, _, _, tok := signedUp(t)
	if getMe(h, tok) != 200 { // warm the cache
		t.Fatal("fresh session refused")
	}
	gdpr := NewGDPRHandler(h.srv, h)
	var tenantID string
	claims, err := h.ValidateToken(context.Background(), tok)
	if err != nil {
		t.Fatal(err)
	}
	tenantID = claims.TenantID
	req := httptest.NewRequest(http.MethodDelete, "/v1/tenants/"+tenantID, nil)
	req.SetPathValue("id", tenantID)
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	gdpr.DeleteTenant(rr, req)
	if rr.Code != 200 {
		t.Fatalf("delete tenant: %d %s", rr.Code, rr.Body.String())
	}
	if getMe(h, tok) != 401 {
		t.Fatal("session survived workspace erasure")
	}
}

// TestRoles_EnforcedOnRoutes drives real tokens of every role through the
// route wrappers for a sample of each S-5 class (the full route list is pinned
// statically in cmd/server/routes_role_test.go).
func TestRoles_EnforcedOnRoutes(t *testing.T) {
	h, _, ownerEmail, ownerTok := signedUp(t)
	t.Setenv("PAL_AUTHZ_ENFORCE", "0") // role enforcement must not depend on it
	ctx := context.Background()
	var tenantID string
	if err := h.srv.Pool.QueryRow(ctx, `SELECT tenant_id::text FROM users WHERE email = $1`, ownerEmail).Scan(&tenantID); err != nil {
		t.Fatal(err)
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte("correct-horse-battery"), bcrypt.MinCost)
	tokens := map[string]string{"owner": ownerTok}
	for _, role := range []string{"admin", "member", "viewer"} {
		email := role + "-" + ownerEmail
		if _, err := h.srv.Pool.Exec(ctx, `INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject, password_hash, role, email_verified_at)
			VALUES ($1, $2, $3, 'local', $2, $4, $3, now())`, tenantID, email, role, string(hash)); err != nil {
			t.Fatal(err)
		}
		tokens[role] = tokenOf(t, doLogin(h, email, "correct-horse-battery"))
	}

	ok := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	admin := func(s Scope) http.HandlerFunc { return h.WithScope(s, h.RequireSessionRole(AdminRoles, ok)) }
	cases := []struct {
		route   string
		fn      http.HandlerFunc
		allowed []string
	}{
		{"GET /v1/agents (viewer)", h.WithScope(ScopeAgentsRead, ok), []string{"owner", "admin", "member", "viewer"}},
		{"GET /v1/budgets", h.WithScope(ScopeBudgetsRead, ok), []string{"owner", "admin", "member", "viewer"}},
		{"POST /v1/agents (member)", h.WithScope(ScopeAgentsWrite, ok), []string{"owner", "admin", "member"}},
		{"POST /v1/runs (member)", h.WithScope(ScopeRunsExecute, ok), []string{"owner", "admin", "member"}},
		{"POST /v1/marketplace/{slug}/star", h.WithScope(ScopeAgentsWrite, ok), []string{"owner", "admin", "member"}},
		{"POST /v1/api-keys", h.WithScope(ScopeAdmin, ok), []string{"owner", "admin"}},
		{"POST /v1/data-planes", h.WithScope(ScopeAdmin, ok), []string{"owner", "admin"}},
		{"POST /v1/settings/llm-providers", h.WithScope(ScopeSettingsWrite, ok), []string{"owner", "admin"}},
		{"PUT /v1/budgets/tenant", h.WithScope(ScopeBudgetsWrite, ok), []string{"owner", "admin"}},
		{"POST /v1/connectors/install", h.WithScope(ScopeConnectorsWrite, ok), []string{"owner", "admin"}},
		{"POST /v1/life-events (coarse write)", h.WithScope(ScopeWrite, ok), []string{"owner", "admin"}},
		{"PUT /v1/agents/{name}/policy", admin(ScopeAgentsWrite), []string{"owner", "admin"}},
		{"POST /v1/agents/{name}/identity/rotate", admin(ScopeAgentsWrite), []string{"owner", "admin"}},
	}
	for _, tc := range cases {
		for role, tok := range tokens {
			want := http.StatusForbidden
			for _, a := range tc.allowed {
				if a == role {
					want = http.StatusOK
				}
			}
			if got := callAuthed(tc.fn, http.MethodPost, tok); got != want {
				t.Errorf("%s as %s: got %d, want %d", tc.route, role, got, want)
			}
		}
	}

	// Owner-only handlers keep their explicit checks: an admin cannot erase.
	gdpr := NewGDPRHandler(h.srv, h)
	req := httptest.NewRequest(http.MethodDelete, "/v1/tenants/"+tenantID, nil)
	req.SetPathValue("id", tenantID)
	req.Header.Set("Authorization", "Bearer "+tokens["admin"])
	rr := httptest.NewRecorder()
	gdpr.DeleteTenant(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("admin erase: got %d, want 403", rr.Code)
	}
}
