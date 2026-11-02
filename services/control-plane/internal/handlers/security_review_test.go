package handlers

// PR #474 security-review fixes: config redaction, kiosk client IP, SSE
// revocation, session provenance. DB-backed tests skip without DATABASE_URL.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
	"golang.org/x/crypto/bcrypt"

	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// ---------- config redaction ----------

func TestRedactConfig(t *testing.T) {
	in := map[string]any{
		"authToken": "tw-secret", "apiKey": "sk-live-1", "secretKey": "sk_stripe", "botToken": "xoxb-1",
		"webhookUrl": "https://hooks.slack.com/services/T/B/X", // a credential, not an identifier
		"accountSid": "AC123", "phoneNumber": "+15550100", "smtp_port": 587, "region": "us-east-1",
		"empty":      "",
		"nested":     map[string]any{"password": "p", "email": "a@b.test"},
		"newFieldXY": "unknown-is-secret",
	}
	out := redactConfig(in)
	for _, k := range []string{"authToken", "apiKey", "secretKey", "botToken", "webhookUrl", "newFieldXY"} {
		if out[k] != RedactedValue {
			t.Errorf("%s: got %v, want masked", k, out[k])
		}
	}
	for k, want := range map[string]any{"accountSid": "AC123", "phoneNumber": "+15550100", "smtp_port": 587, "region": "us-east-1", "empty": ""} {
		if out[k] != want {
			t.Errorf("%s: got %v, want %v", k, out[k], want)
		}
	}
	nested := out["nested"].(map[string]any)
	if nested["password"] != RedactedValue || nested["email"] != "a@b.test" {
		t.Errorf("nested: %v", nested)
	}
	if in["apiKey"] != "sk-live-1" {
		t.Fatal("redactConfig mutated its input")
	}
}

func TestMergeRedacted(t *testing.T) {
	stored := map[string]any{"botToken": "real-token", "chatId": "1", "inner": map[string]any{"pass": "real-pass"}}
	got := mergeRedacted(map[string]any{
		"botToken": RedactedValue,                         // unchanged → keep stored
		"chatId":   "2",                                   // edited
		"newKey":   RedactedValue,                         // mask with nothing behind it → dropped
		"inner":    map[string]any{"pass": RedactedValue}, // nested
	}, stored)
	if got["botToken"] != "real-token" || got["chatId"] != "2" {
		t.Fatalf("merge: %v", got)
	}
	if _, ok := got["newKey"]; ok {
		t.Fatal("a bare mask was stored")
	}
	if got["inner"].(map[string]any)["pass"] != "real-pass" {
		t.Fatalf("nested merge: %v", got["inner"])
	}
}

// roleUser adds a user with a role to the owner's tenant and returns its token.
func roleUser(t *testing.T, h *AuthHandler, ownerEmail, role string) string {
	t.Helper()
	ctx := context.Background()
	var tenantID string
	if err := h.srv.Pool.QueryRow(ctx, `SELECT tenant_id::text FROM users WHERE email = $1`, ownerEmail).Scan(&tenantID); err != nil {
		t.Fatal(err)
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte("correct-horse-battery"), bcrypt.MinCost)
	email := role + "-" + ownerEmail
	if _, err := h.srv.Pool.Exec(ctx, `INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject, password_hash, role, email_verified_at)
		VALUES ($1, $2, $3, 'local', $2, $4, $3, now())`, tenantID, email, role, string(hash)); err != nil {
		t.Fatal(err)
	}
	return tokenOf(t, doLogin(h, email, "correct-horse-battery"))
}

func authedJSON(fn http.HandlerFunc, method, path, token string, body any, pathValues map[string]string) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range pathValues {
		req.SetPathValue(k, v)
	}
	rr := httptest.NewRecorder()
	fn(rr, req)
	return rr
}

// TestConnectorAndSurfaceConfigNeverReturnsSecrets: a viewer (coarse read ⇒
// connectors:read) and even the owner get masks, never the stored credentials.
func TestConnectorAndSurfaceConfigNeverReturnsSecrets(t *testing.T) {
	h, _, ownerEmail, ownerTok := signedUp(t)
	viewerTok := roleUser(t, h, ownerEmail, "viewer")
	conn := NewConnectorHandler(h.srv, h)

	rr := authedJSON(conn.InstallConnector, http.MethodPost, "/v1/connectors/install", ownerTok, map[string]any{
		"connectorId": "twilio", "displayName": "Twilio",
		"config": map[string]any{"accountSid": "AC-redact-test", "authToken": "tw-SECRET-123", "phoneNumber": "+15550100"},
	}, nil)
	if rr.Code/100 != 2 {
		t.Fatalf("install: %d %s", rr.Code, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "tw-SECRET-123") {
		t.Fatal("install response echoed the secret")
	}
	var installed struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &installed)

	for name, tok := range map[string]string{"viewer": viewerTok, "owner": ownerTok} {
		list := authedJSON(conn.ListConnectors, http.MethodGet, "/v1/connectors", tok, nil, nil)
		get := authedJSON(conn.GetConnector, http.MethodGet, "/v1/connectors/"+installed.ID, tok, nil, map[string]string{"id": installed.ID})
		for label, res := range map[string]*httptest.ResponseRecorder{"list": list, "get": get} {
			body := res.Body.String()
			if res.Code != 200 || strings.Contains(body, "tw-SECRET-123") || !strings.Contains(body, RedactedValue) || !strings.Contains(body, "+15550100") {
				t.Errorf("%s %s: %d %s", name, label, res.Code, body)
			}
		}
	}

	surf := NewSurfaceHandler(h.srv, h)
	rr = authedJSON(surf.ConfigureSurface, http.MethodPost, "/v1/surfaces", ownerTok, map[string]any{
		"surfaceId": "telegram", "displayName": "TG",
		"config": map[string]any{"botToken": "tg-SECRET-456", "botUsername": "palbot"},
	}, nil)
	if rr.Code != http.StatusCreated || strings.Contains(rr.Body.String(), "tg-SECRET-456") {
		t.Fatalf("configure: %d %s", rr.Code, rr.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &created)
	list := authedJSON(surf.ListSurfaces, http.MethodGet, "/v1/surfaces", viewerTok, nil, nil)
	if strings.Contains(list.Body.String(), "tg-SECRET-456") || !strings.Contains(list.Body.String(), "palbot") {
		t.Fatalf("surface list leaked or lost data: %s", list.Body.String())
	}
	// Saving the prefilled (masked) form keeps the stored token.
	up := authedJSON(surf.UpdateSurface, http.MethodPut, "/v1/surfaces/"+created.ID, ownerTok, map[string]any{
		"config": map[string]any{"botToken": RedactedValue, "botUsername": "palbot2"},
	}, map[string]string{"id": created.ID})
	if up.Code != 200 {
		t.Fatalf("update: %d %s", up.Code, up.Body.String())
	}
	var stored string
	_ = h.srv.Pool.QueryRow(context.Background(), `SELECT config::text FROM surface_configs WHERE id = $1`, created.ID).Scan(&stored)
	if !strings.Contains(stored, "tg-SECRET-456") || !strings.Contains(stored, "palbot2") || strings.Contains(stored, RedactedValue) {
		t.Fatalf("stored config after masked save: %s", stored)
	}
}

// ---------- kiosk: per real client ----------

func TestKioskAllowIP_PerRealClient(t *testing.T) {
	k := &KioskHandler{perIPPerHour: 1, hitsByIP: map[string][]time.Time{}, now: time.Now}
	req := func(peer, xff string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/v1/kiosk/session", nil)
		r.RemoteAddr = peer + ":5555"
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}
	// Untrusted peer: a forged X-Forwarded-For is ignored, so rotating it
	// does not buy a new quota.
	t.Setenv("PAL_TRUSTED_PROXIES", "")
	if !k.allowIP(req("203.0.113.9", "1.1.1.1")) || k.allowIP(req("203.0.113.9", "2.2.2.2")) {
		t.Fatal("spoofed X-Forwarded-For from an untrusted peer changed the bucket")
	}
	// Trusted peer (the dashboard's /api/pal proxy): two visitors behind it
	// get separate buckets instead of sharing one.
	t.Setenv("PAL_TRUSTED_PROXIES", "10.0.0.0/8")
	if !k.allowIP(req("10.1.2.3", "198.51.100.1")) || !k.allowIP(req("10.1.2.3", "198.51.100.2")) {
		t.Fatal("visitors behind the trusted dashboard share one bucket")
	}
	if k.allowIP(req("10.1.2.3", "198.51.100.1")) {
		t.Fatal("the same real client got a second session")
	}
}

// ---------- SSE revocation ----------

func TestGuardStream_EndsAtExpiry(t *testing.T) {
	h := NewAuthHandler(&server.Server{Logger: zap.NewNop()}, testJWTSecret)
	// NumericDate has second precision: +2s truncates to at least +1s.
	c := &PalClaims{RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(2 * time.Second))}, APIKeyID: "k"}
	ctx, cancel := h.guardStream(context.Background(), c)
	defer cancel()
	select {
	case <-ctx.Done():
		t.Fatal("stream closed before its token expired")
	case <-time.After(300 * time.Millisecond):
	}
	select {
	case <-ctx.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("stream outlived its token")
	}
}

// TestRunEventsStream_LogoutTerminates opens a real run-events SSE stream and
// logs the user out on another request: the stream ends.
func TestRunEventsStream_LogoutTerminates(t *testing.T) {
	setSignupEnv(t, "", "open", "")
	useRealSessionLookup(t)
	prev := streamRecheckInterval
	streamRecheckInterval = 50 * time.Millisecond
	t.Cleanup(func() { streamRecheckInterval = prev })

	rh := newRESTHandlerForRunEventsTest(t)
	ctx := context.Background()
	email := uniqueEmail(t)
	hash, _ := bcrypt.GenerateFromPassword([]byte("correct-horse-battery"), bcrypt.MinCost)
	var userID string
	if err := rh.srv.Pool.QueryRow(ctx, `INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject, password_hash, role, email_verified_at)
		VALUES ($1, $2, 'sse', 'local', $2, $3, 'owner', now()) RETURNING id`, devTenantID, email, string(hash)).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = rh.srv.Pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID) })
	token, err := rh.auth.generateToken(ctx, userID, devTenantID, email, "sse", "owner")
	if err != nil {
		t.Fatal(err)
	}
	runID := insertRunForEvents(t, rh, devTenantID, "running")

	req := httptest.NewRequest(http.MethodGet, "/v1/runs/"+runID+"/events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.SetPathValue("id", runID)
	done := make(chan struct{})
	go func() {
		defer close(done)
		rh.GetRunEvents(httptest.NewRecorder(), req)
	}()
	select {
	case <-done:
		t.Fatal("stream ended before logout")
	case <-time.After(300 * time.Millisecond):
	}
	logout := rh.auth.WithScope(ScopeRead, rh.auth.Logout)
	if code := callAuthed(logout, http.MethodPost, token); code != http.StatusNoContent {
		t.Fatalf("logout: %d", code)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("open SSE stream survived logout")
	}
}

// ---------- provenance ----------

// A signed JWT that merely claims role "service" (no API key behind it) is a
// session of an unknown role: viewer scopes, never the unrestricted key path.
func TestServiceRoleJWTIsNotAnAPIKey(t *testing.T) {
	forged := &PalClaims{RegisteredClaims: jwt.RegisteredClaims{Subject: "someone"}, Role: "service"}
	if HasScope(forged, ScopeAdmin) || HasScope(forged, ScopeAgentsWrite) || !HasScope(forged, ScopeRead) {
		t.Fatal("a service-claiming JWT was treated as an unrestricted API key")
	}
	key := &PalClaims{APIKeyID: "k1", Role: "service"}
	if !HasScope(key, ScopeAdmin) {
		t.Fatal("a real unscoped API key lost its legacy access")
	}
}

// TestLogoutRacingLookupCannotRecache: a lookup that read the old version
// before a logout's drop must not re-cache it afterwards.
func TestLogoutRacingLookupCannotRecache(t *testing.T) {
	var c sessionCache
	now := time.Now()
	epoch := c.currentEpoch() // a lookup starts and reads tv=0 from the DB...
	c.drop("u")               // ...logout bumps and drops meanwhile...
	c.put("u", 0, now, epoch) // ...and the stale result arrives.
	if _, ok := c.get("u", now); ok {
		t.Fatal("stale pre-logout version was re-cached")
	}
}
