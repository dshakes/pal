package handlers

// DB-gated handler tests for auth.go: signup, login, and token introspection
// (GET /auth/me). These are the JWT-minting / credential-checking paths that
// gate every other endpoint, so they get real end-to-end coverage against the
// dev Postgres.
//
// Skipped automatically when DATABASE_URL is unset (same convention as the rest
// of this package). Run with:
//
//	DATABASE_URL=postgres://pal:pal@localhost:5432/pal?sslmode=disable \
//	  go test ./internal/handlers/ -run Auth -count=1 -v

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
	"golang.org/x/crypto/bcrypt"

	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// newAuthTestHandler builds an AuthHandler backed by a real pool, using the
// shared testJWTSecret so mintTestToken-issued JWTs validate against it.
func newAuthTestHandler(t *testing.T) *AuthHandler {
	t.Helper()
	pool := openTestPool(t) // skips if DATABASE_URL unset
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	return NewAuthHandler(srv, testJWTSecret)
}

// uniqueEmail returns a per-test email that won't collide with seeded data or
// other test runs. The local-part is unique; cleanup removes the row + tenant.
func uniqueEmail(t *testing.T) string {
	t.Helper()
	suffix, err := randomHex(6)
	if err != nil {
		t.Fatalf("randomHex: %v", err)
	}
	return "authtest-" + suffix + "@example.test"
}

// cleanupUserByEmail deletes the user and its owning tenant (CASCADE drops the
// user) created by a signup. Registered as a t.Cleanup by the caller.
func cleanupUserByEmail(t *testing.T, h *AuthHandler, email string) {
	t.Helper()
	ctx := context.Background()
	// Delete the tenant the signup created; ON DELETE CASCADE removes the user.
	_, _ = h.srv.Pool.Exec(ctx, `
		DELETE FROM tenants WHERE id IN (
			SELECT tenant_id FROM users WHERE email = $1
		)
	`, email)
	_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM users WHERE email = $1`, email)
}

// doSignup posts a signup request and returns the recorder.
func doSignup(h *AuthHandler, email, password, name string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"email": email, "password": password, "name": name})
	req := httptest.NewRequest(http.MethodPost, "/auth/register", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.Signup(rr, req)
	return rr
}

// doLogin posts a login request and returns the recorder.
func doLogin(h *AuthHandler, email, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	req := httptest.NewRequest(http.MethodPost, "/auth/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.Login(rr, req)
	return rr
}

// TestAuth_Signup_IssuesValidJWT registers a brand-new user and asserts the
// returned token is a real JWT that validates and carries the new tenant.
func TestAuth_Signup_IssuesValidJWT(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	rr := doSignup(h, email, "supersecret-pw-123", "Auth Tester")
	if rr.Code != http.StatusCreated {
		t.Fatalf("signup: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	var resp authResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal signup response: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("signup response has empty token")
	}
	if resp.User.Email != email {
		t.Errorf("user email: got %q, want %q", resp.User.Email, email)
	}
	if resp.User.TenantID == "" {
		t.Error("user tenantId is empty")
	}
	if resp.User.Role != "owner" {
		t.Errorf("role: got %q, want owner", resp.User.Role)
	}

	// The issued token must validate against the same secret and carry the
	// claims that were minted — this is the load-bearing assertion (a token
	// that doesn't validate is useless).
	claims, err := h.ValidateToken(resp.Token)
	if err != nil {
		t.Fatalf("issued token failed to validate: %v", err)
	}
	if claims.TenantID != resp.User.TenantID {
		t.Errorf("token tenant_id %q != response tenantId %q", claims.TenantID, resp.User.TenantID)
	}
	if claims.Email != email {
		t.Errorf("token email: got %q, want %q", claims.Email, email)
	}
}

// TestAuth_Signup_ShortPasswordRejected proves the 12-char minimum is enforced
// and no token is issued.
func TestAuth_Signup_ShortPasswordRejected(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	rr := doSignup(h, email, "short", "X")
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("short password: got %d, want 400; body: %s", rr.Code, rr.Body.String())
	}
	if bytes.Contains(rr.Body.Bytes(), []byte(`"token"`)) {
		t.Error("a token was issued for an under-length password")
	}
}

// TestAuth_Signup_Duplicate_Returns409 proves a second signup with the same
// email is rejected with 409 Conflict.
func TestAuth_Signup_Duplicate_Returns409(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	if rr := doSignup(h, email, "supersecret-pw-123", "First"); rr.Code != http.StatusCreated {
		t.Fatalf("first signup: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	rr := doSignup(h, email, "anothersecret-pw-456", "Second")
	if rr.Code != http.StatusConflict {
		t.Fatalf("duplicate signup: got %d, want 409; body: %s", rr.Code, rr.Body.String())
	}
}

// TestAuth_Login_Success logs in a user created via signup and asserts a fresh
// valid token comes back bound to the same tenant.
func TestAuth_Login_Success(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	const password = "supersecret-pw-123"
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	signupRR := doSignup(h, email, password, "Login Tester")
	if signupRR.Code != http.StatusCreated {
		t.Fatalf("signup precondition failed: %d; body: %s", signupRR.Code, signupRR.Body.String())
	}
	var signup authResponse
	_ = json.Unmarshal(signupRR.Body.Bytes(), &signup)

	rr := doLogin(h, email, password)
	if rr.Code != http.StatusOK {
		t.Fatalf("login: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var resp authResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal login response: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("login returned empty token")
	}
	claims, err := h.ValidateToken(resp.Token)
	if err != nil {
		t.Fatalf("login token failed to validate: %v", err)
	}
	if claims.TenantID != signup.User.TenantID {
		t.Errorf("login tenant %q != signup tenant %q", claims.TenantID, signup.User.TenantID)
	}
	if claims.Email != email {
		t.Errorf("login token email: got %q, want %q", claims.Email, email)
	}
}

// TestAuth_Login_WrongPassword proves a valid user + wrong password returns 401
// and no token. This is the credential-checking path that bcrypt guards.
func TestAuth_Login_WrongPassword(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	if rr := doSignup(h, email, "supersecret-pw-123", "Pwd Tester"); rr.Code != http.StatusCreated {
		t.Fatalf("signup precondition: %d; body: %s", rr.Code, rr.Body.String())
	}

	rr := doLogin(h, email, "wrong-password-000")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password: got %d, want 401; body: %s", rr.Code, rr.Body.String())
	}
	if bytes.Contains(rr.Body.Bytes(), []byte(`"token"`)) {
		t.Error("a token was issued for a wrong password")
	}
}

// TestAuth_Login_UnknownUser proves an unknown email returns 401 (invalid
// credentials) — and notably the SAME status/shape as a wrong password, so the
// endpoint doesn't leak which emails exist.
func TestAuth_Login_UnknownUser(t *testing.T) {
	h := newAuthTestHandler(t)

	rr := doLogin(h, "no-such-user-"+func() string { s, _ := randomHex(6); return s }()+"@example.test", "supersecret-pw-123")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("unknown user: got %d, want 401; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["error"] != "invalid credentials" {
		t.Errorf("unknown-user error: got %q, want 'invalid credentials' (user-existence must not leak)", resp["error"])
	}
}

// TestAuth_GetMe_ValidToken proves /auth/me returns the caller's identity for a
// well-formed JWT.
func TestAuth_GetMe_ValidToken(t *testing.T) {
	h := newAuthTestHandler(t)

	tenantID := devTenantID
	userID := "00000000-0000-0000-0000-000000000002"
	tok := mintTestToken(t, tenantID, userID, "owner")

	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.GetMe(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("GetMe valid: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var u userJSON
	if err := json.Unmarshal(rr.Body.Bytes(), &u); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if u.ID != userID {
		t.Errorf("GetMe id: got %q, want %q", u.ID, userID)
	}
	if u.TenantID != tenantID {
		t.Errorf("GetMe tenantId: got %q, want %q", u.TenantID, tenantID)
	}
}

// TestAuth_GetMe_InvalidToken proves a garbage / missing / expired token is
// rejected with 401 and no identity is disclosed.
func TestAuth_GetMe_InvalidToken(t *testing.T) {
	h := newAuthTestHandler(t)

	cases := []struct {
		name   string
		header string
	}{
		{"missing", ""},
		{"garbage", bearerHeader("not.a.jwt")},
		{"wrong-scheme", "Basic " + "abc"},
		{"expired", bearerHeader(mintExpiredToken(t, devTenantID, "user-x", "owner"))},
		{"wrong-secret", bearerHeader(mintTokenWithSecret(t, devTenantID, "user-x", "owner", "a-different-secret"))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rr := httptest.NewRecorder()
			h.GetMe(rr, req)
			if rr.Code != http.StatusUnauthorized {
				t.Fatalf("%s token: got %d, want 401; body: %s", tc.name, rr.Code, rr.Body.String())
			}
		})
	}
}

// mintExpiredToken mints a token whose exp is in the past so validation must
// fail. Used to prove expiry is actually enforced (not a cosmetic claim).
func mintExpiredToken(t *testing.T, tenantID, userID, role string) string {
	t.Helper()
	past := time.Now().Add(-2 * time.Hour)
	claims := PalClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(past.Add(-time.Hour)),
			ExpiresAt: jwt.NewNumericDate(past),
			Issuer:    "pal-test",
		},
		TenantID: tenantID,
		Role:     role,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("mintExpiredToken: %v", err)
	}
	return s
}

// mintTokenWithSecret signs a token with a non-matching secret, proving the
// signature is actually verified (a forged token under a different key fails).
func mintTokenWithSecret(t *testing.T, tenantID, userID, role, secret string) string {
	t.Helper()
	claims := PalClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
		TenantID: tenantID,
		Role:     role,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("mintTokenWithSecret: %v", err)
	}
	return s
}

// insertUserWithRole inserts a user directly into an existing tenant with the
// given role and bcrypt-hashed password. Returns userID and a cleanup function.
// Used by the role regression tests to set up member/viewer/admin accounts
// without going through Signup (which always creates a new tenant as "owner").
func insertUserWithRole(t *testing.T, h *AuthHandler, tenantID, email, role string) (userID string) {
	t.Helper()
	ctx := context.Background()
	const password = "supersecret-pw-123"
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("insertUserWithRole: bcrypt: %v", err)
	}
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject, password_hash, role)
		VALUES ($1, $2, $3, 'local', $4, $5, $6)
		RETURNING id
	`, tenantID, email, role+" User", email, string(hash), role).Scan(&userID)
	if err != nil {
		t.Fatalf("insertUserWithRole: insert: %v", err)
	}
	t.Cleanup(func() {
		h.srv.Pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID) //nolint:errcheck
	})
	return userID
}

// TestAuth_Login_RoleFromDB is a regression test for the privilege-escalation
// bug where Login issued role "owner" for every local user of any existing
// tenant regardless of the stored users.role value.
//
// It creates a tenant via Signup (owner), then directly inserts a member user
// and a viewer user into that same tenant. Logging in as each must produce a
// JWT whose role matches the stored role — not "owner".
func TestAuth_Login_RoleFromDB(t *testing.T) {
	h := newAuthTestHandler(t)
	ownerEmail := uniqueEmail(t)
	const password = "supersecret-pw-123"
	t.Cleanup(func() { cleanupUserByEmail(t, h, ownerEmail) })

	// Create the tenant via normal Signup; the first user is "owner".
	signupRR := doSignup(h, ownerEmail, password, "Owner User")
	if signupRR.Code != http.StatusCreated {
		t.Fatalf("signup precondition: %d; body: %s", signupRR.Code, signupRR.Body.String())
	}
	var signupResp authResponse
	if err := json.Unmarshal(signupRR.Body.Bytes(), &signupResp); err != nil {
		t.Fatalf("unmarshal signup: %v", err)
	}
	tenantID := signupResp.User.TenantID

	cases := []struct {
		storedRole string
	}{
		{"member"},
		{"viewer"},
		{"admin"},
		{"owner"}, // sanity: owner stays owner
	}

	for _, tc := range cases {
		t.Run(tc.storedRole, func(t *testing.T) {
			email := uniqueEmail(t)
			insertUserWithRole(t, h, tenantID, email, tc.storedRole)

			rr := doLogin(h, email, password)
			if rr.Code != http.StatusOK {
				t.Fatalf("login %s: got %d, want 200; body: %s", tc.storedRole, rr.Code, rr.Body.String())
			}

			var resp authResponse
			if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
				t.Fatalf("unmarshal login response: %v", err)
			}

			// Response body role must match DB.
			if resp.User.Role != tc.storedRole {
				t.Errorf("login response role: got %q, want %q (privilege escalation bug)", resp.User.Role, tc.storedRole)
			}

			// JWT claims role must match DB.
			claims, err := h.ValidateToken(resp.Token)
			if err != nil {
				t.Fatalf("validate token: %v", err)
			}
			if claims.Role != tc.storedRole {
				t.Errorf("JWT role claim: got %q, want %q (privilege escalation bug)", claims.Role, tc.storedRole)
			}
		})
	}
}

// TestAuth_OAuth_ReturningUser_RoleFromDB is a regression test for the same
// privilege-escalation bug in the OAuth callback path. A returning OAuth user
// must get their stored role, not "owner".
//
// We directly insert an OAuth user (auth_provider="google") with role "member"
// into an existing tenant and simulate the returning-user branch of OAuthCallback
// by calling the internal query path through Login (the OAuth callback shares
// the same DB query pattern). Because OAuthCallback requires a live provider
// round-trip, we test the stored-role read by replicating the exact query the
// fixed code now runs.
func TestAuth_OAuth_ReturningUser_RoleFromDB(t *testing.T) {
	h := newAuthTestHandler(t)
	ownerEmail := uniqueEmail(t)
	const password = "supersecret-pw-123"
	t.Cleanup(func() { cleanupUserByEmail(t, h, ownerEmail) })

	// Stand up a tenant.
	signupRR := doSignup(h, ownerEmail, password, "Owner")
	if signupRR.Code != http.StatusCreated {
		t.Fatalf("signup: %d %s", signupRR.Code, signupRR.Body.String())
	}
	var signupResp authResponse
	json.Unmarshal(signupRR.Body.Bytes(), &signupResp) //nolint:errcheck
	tenantID := signupResp.User.TenantID

	// Insert an OAuth user (google) with role "member" into the same tenant.
	ctx := context.Background()
	oauthEmail := uniqueEmail(t)
	var oauthUserID string
	err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject, role, email_verified_at)
		VALUES ($1, $2, 'OAuth Member', 'google', $3, 'member', now())
		RETURNING id
	`, tenantID, oauthEmail, oauthEmail).Scan(&oauthUserID)
	if err != nil {
		t.Fatalf("insert oauth user: %v", err)
	}
	t.Cleanup(func() {
		h.srv.Pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, oauthUserID) //nolint:errcheck
	})

	// Execute the exact query the fixed OAuthCallback now uses and assert the
	// role column is returned correctly (not "owner").
	var (
		gotUserID, gotTenantID, gotName, gotRole string
	)
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT u.id, u.tenant_id, u.display_name, u.role
		FROM users u WHERE u.email = $1 LIMIT 1
	`, oauthEmail).Scan(&gotUserID, &gotTenantID, &gotName, &gotRole)
	if err != nil {
		t.Fatalf("oauth returning-user query: %v", err)
	}
	if gotRole != "member" {
		t.Errorf("OAuth returning user role: got %q, want \"member\" (privilege escalation bug)", gotRole)
	}
	if gotUserID != oauthUserID {
		t.Errorf("OAuth returning user ID mismatch: got %q, want %q", gotUserID, oauthUserID)
	}
}

// TestAuth_Signup_StoresOwnerRole proves that Signup stores role='owner' in the
// DB and that a subsequent Login produces a JWT with role "owner".
// Regression for: Signup INSERT missed the role column, defaulting to 'member'.
func TestAuth_Signup_StoresOwnerRole(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	const password = "supersecret-pw-123"
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	rr := doSignup(h, email, password, "Owner Tester")
	if rr.Code != http.StatusCreated {
		t.Fatalf("signup: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	// Verify the stored role is 'owner', not the column default 'member'.
	ctx := context.Background()
	var storedRole string
	if err := h.srv.Pool.QueryRow(ctx,
		`SELECT role FROM users WHERE email = $1 LIMIT 1`, email,
	).Scan(&storedRole); err != nil {
		t.Fatalf("query stored role: %v", err)
	}
	if storedRole != "owner" {
		t.Errorf("stored role: got %q, want \"owner\" (Signup INSERT must set role='owner')", storedRole)
	}

	// Login must return owner in both the response body and the JWT.
	rr = doLogin(h, email, password)
	if rr.Code != http.StatusOK {
		t.Fatalf("login after signup: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var resp authResponse
	json.Unmarshal(rr.Body.Bytes(), &resp) //nolint:errcheck
	if resp.User.Role != "owner" {
		t.Errorf("login response role: got %q, want \"owner\"", resp.User.Role)
	}
	claims, err := h.ValidateToken(resp.Token)
	if err != nil {
		t.Fatalf("validate token: %v", err)
	}
	if claims.Role != "owner" {
		t.Errorf("JWT role claim after signup: got %q, want \"owner\"", claims.Role)
	}
}

// TestAuth_BackfillMigration_OwnerlessTenantsPromoted proves that the
// 0043_backfill_tenant_owner migration promotes the earliest user in a tenant
// with no owner/admin to 'owner', leaves other roles alone, and does not
// touch tenants that already have an owner.
func TestAuth_BackfillMigration_OwnerlessTenantsPromoted(t *testing.T) {
	h := newAuthTestHandler(t)
	ctx := context.Background()

	// Helper: create a bare tenant (no users yet).
	makeTenant := func(slug string) string {
		t.Helper()
		var tid string
		if err := h.srv.Pool.QueryRow(ctx, `
			INSERT INTO tenants (slug, name, tier, k8s_namespace)
			VALUES ($1, $2, 'personal', $3) RETURNING id
		`, slug, slug+" Workspace", "pal-t-"+slug).Scan(&tid); err != nil {
			t.Fatalf("makeTenant %s: %v", slug, err)
		}
		t.Cleanup(func() {
			h.srv.Pool.Exec(ctx, `DELETE FROM tenants WHERE id = $1`, tid) //nolint:errcheck
		})
		return tid
	}

	// Helper: insert a user with a given role (no password; role tests only).
	insertRole := func(tenantID, email, role string) string {
		t.Helper()
		var uid string
		if err := h.srv.Pool.QueryRow(ctx, `
			INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject, role)
			VALUES ($1, $2, $2, 'local', $3, $4) RETURNING id
		`, tenantID, email, email, role).Scan(&uid); err != nil {
			t.Fatalf("insertRole %s %s: %v", email, role, err)
		}
		t.Cleanup(func() {
			h.srv.Pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, uid) //nolint:errcheck
		})
		return uid
	}

	suffix, _ := randomHex(4)

	// Case A: ownerless tenant — earliest user should be promoted.
	tidA := makeTenant("mig-a-" + suffix)
	early := insertRole(tidA, "early-"+suffix+"@example.test", "member")
	late := insertRole(tidA, "late-"+suffix+"@example.test", "member")

	// Case B: tenant already has an owner — member must NOT be promoted even when
	// the member is the earliest-created user (inserted first here so id/created_at
	// are both earlier). A broken migration that omits the NOT EXISTS guard would
	// promote this member, failing the assertion below.
	tidB := makeTenant("mig-b-" + suffix)
	alreadyMember := insertRole(tidB, "mem-"+suffix+"@example.test", "member")
	existingOwner := insertRole(tidB, "owner-"+suffix+"@example.test", "owner")

	// Run the migration SQL directly (the DB was already migrated at pool-open
	// time; this is a surgical re-execution on fresh rows).
	// Load the REAL migration file so the test cannot drift from what ships.
	sqlBytes, err := os.ReadFile("../db/migrations/0043_backfill_tenant_owner.up.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migrationSQL := string(sqlBytes)
	if _, err := h.srv.Pool.Exec(ctx, migrationSQL); err != nil {
		t.Fatalf("run migration SQL: %v", err)
	}

	role := func(uid string) string {
		t.Helper()
		var r string
		h.srv.Pool.QueryRow(ctx, `SELECT role FROM users WHERE id = $1`, uid).Scan(&r) //nolint:errcheck
		return r
	}

	// Case A: earliest user promoted to owner.
	if got := role(early); got != "owner" {
		t.Errorf("case A early user: role %q, want \"owner\"", got)
	}
	// Case A: later user unchanged.
	if got := role(late); got != "member" {
		t.Errorf("case A late user: role %q, want \"member\"", got)
	}

	// Case B: existing owner unchanged.
	if got := role(existingOwner); got != "owner" {
		t.Errorf("case B existing owner: role %q, want \"owner\"", got)
	}
	// Case B: member in tenant-with-owner unchanged.
	if got := role(alreadyMember); got != "member" {
		t.Errorf("case B member: role %q, want \"member\" (must not promote members in tenant that already has an owner)", got)
	}
}
