package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/server"
)

func TestValidateKeyExpiry(t *testing.T) {
	now := time.Now()
	at := func(d time.Duration) *time.Time { x := now.Add(d); return &x }
	cases := []struct {
		name    string
		in      *time.Time
		wantErr bool
	}{
		{"none", nil, false},
		{"tomorrow", at(24 * time.Hour), false},
		{"just under max", at(364 * 24 * time.Hour), false},
		{"past", at(-time.Second), true},
		{"now", &now, true},
		{"beyond a year", at(400 * 24 * time.Hour), true},
	}
	for _, tc := range cases {
		if err := validateKeyExpiry(tc.in, now); (err != nil) != tc.wantErr {
			t.Errorf("%s: err=%v wantErr=%v", tc.name, err, tc.wantErr)
		}
	}
}

func TestIsAPIKeyPrefixes(t *testing.T) {
	for tok, want := range map[string]bool{
		"pal_live_abc": true, "hlx_live_abc": true, "eyJhbGciOi": false, "pal_test_x": false, "": false,
	} {
		if isAPIKey(tok) != want {
			t.Errorf("isAPIKey(%q) != %v", tok, want)
		}
	}
}

type keyFixture struct {
	t        *testing.T
	h        *ApiKeyHandler
	auth     *AuthHandler
	tenantID string
	userID   string
	jwt      string
}

func newKeyFixture(t *testing.T) *keyFixture {
	t.Helper()
	pool := gdprTestDB(t)
	srv := &server.Server{Pool: pool, Logger: zap.NewNop()}
	auth := NewAuthHandler(srv, testJWTSecret)
	ctx := context.Background()
	email := uniqueEmail(t)
	slug := strings.Split(email, "@")[0]
	f := &keyFixture{t: t, auth: auth, h: NewApiKeyHandler(srv, auth)}
	if err := pool.QueryRow(ctx, `INSERT INTO tenants (slug,name,tier,k8s_namespace) VALUES ($1,$1,'personal',$2) RETURNING id`, slug, "pal-t-"+slug).Scan(&f.tenantID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (tenant_id,email,display_name,auth_provider,auth_subject,role) VALUES ($1,$2,'k','local',$2,'owner') RETURNING id`, f.tenantID, email).Scan(&f.userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM tenants WHERE id=$1`, f.tenantID) })
	var err error
	if f.jwt, err = auth.generateToken(f.userID, f.tenantID, email, "k", "owner"); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *keyFixture) call(fn http.HandlerFunc, method, path, bearer string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(method, path, bytes.NewReader(b))
	req.SetPathValue("id", strings.TrimSuffix(strings.TrimPrefix(path, "/v1/api-keys/"), "/rotate"))
	req.Header.Set("Authorization", "Bearer "+bearer)
	rr := httptest.NewRecorder()
	fn(rr, req)
	return rr
}

type keyResp struct {
	Key struct {
		ID, Prefix string
		Scopes     []string
	}
	RawKey string
}

func (f *keyFixture) create(bearer string, body map[string]any) (*httptest.ResponseRecorder, keyResp) {
	rr := f.call(f.h.CreateApiKey, "POST", "/v1/api-keys", bearer, body)
	var kr keyResp
	_ = json.Unmarshal(rr.Body.Bytes(), &kr)
	return rr, kr
}

// insertKey writes a key row directly (legacy prefix, expired, etc).
func (f *keyFixture) insertKey(raw string, scopes []string, expires *time.Time) string {
	sum := sha256.Sum256([]byte(raw))
	var id string
	if err := f.h.srv.Pool.QueryRow(context.Background(), `
		INSERT INTO api_keys (tenant_id,name,key_hash,key_prefix,scopes,expires_at) VALUES ($1,'t',$2,$3,$4,$5) RETURNING id`,
		f.tenantID, hex.EncodeToString(sum[:]), raw[:16], scopes, expires).Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *keyFixture) valid(raw string) bool {
	_, err := f.auth.validateAPIKey(context.Background(), raw)
	return err == nil
}

func (f *keyFixture) introspect(raw string) int {
	b, _ := json.Marshal(map[string]string{"key": raw})
	rr := httptest.NewRecorder()
	f.auth.IntrospectKey(rr, httptest.NewRequest("POST", "/internal/auth/introspect-key", bytes.NewReader(b)))
	return rr.Code
}

func TestAPIKey_CreateAttributesUserNewPrefixAndExpiry(t *testing.T) {
	f := newKeyFixture(t)
	exp := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	rr, kr := f.create(f.jwt, map[string]any{"name": "ci", "scopes": []string{"runs:read"}, "expiresAt": exp})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rr.Code, rr.Body)
	}
	if !strings.HasPrefix(kr.RawKey, "pal_live_") || !strings.HasPrefix(kr.Key.Prefix, "pal_live_") {
		t.Fatalf("new key prefix: %q / %q", kr.RawKey, kr.Key.Prefix)
	}
	var createdBy string
	var gotExp *time.Time
	if err := f.h.srv.Pool.QueryRow(context.Background(), `SELECT created_by, expires_at FROM api_keys WHERE id=$1`, kr.Key.ID).Scan(&createdBy, &gotExp); err != nil {
		t.Fatal(err)
	}
	if createdBy != f.userID {
		t.Fatalf("created_by=%q, want user %q (not tenant %q)", createdBy, f.userID, f.tenantID)
	}
	if gotExp == nil || !gotExp.Equal(exp) {
		t.Fatalf("expires_at=%v want %v", gotExp, exp)
	}
	if !f.valid(kr.RawKey) || f.introspect(kr.RawKey) != 200 {
		t.Fatal("fresh key should validate and introspect")
	}
	// Key-created key is attributed to the minting key, not a user.
	_, child := f.create(kr.RawKey, map[string]any{"name": "child", "scopes": []string{"runs:read"}})
	var cb string
	_ = f.h.srv.Pool.QueryRow(context.Background(), `SELECT created_by FROM api_keys WHERE id=$1`, child.Key.ID).Scan(&cb)
	if cb != "apikey:"+kr.Key.ID {
		t.Fatalf("child created_by=%q", cb)
	}
}

func TestAPIKey_CreateRejectsBadExpiry(t *testing.T) {
	f := newKeyFixture(t)
	for name, exp := range map[string]time.Time{
		"past": time.Now().Add(-time.Hour), "too far": time.Now().Add(800 * 24 * time.Hour),
	} {
		if rr, _ := f.create(f.jwt, map[string]any{"name": "x", "scopes": []string{"read"}, "expiresAt": exp}); rr.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", name, rr.Code)
		}
	}
}

func TestAPIKey_ExpiredIs401EverywhereAndLegacyPrefixStillWorks(t *testing.T) {
	f := newKeyFixture(t)
	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(time.Hour)
	expired := "pal_live_expiredexpired" + f.userID[:8]
	live := "hlx_live_legacylegacy" + f.userID[:8]
	f.insertKey(expired, []string{"read"}, &past)
	f.insertKey(live, []string{"read"}, &future)

	if f.valid(expired) || f.introspect(expired) != http.StatusUnauthorized {
		t.Fatal("expired key must be refused by validate AND introspect")
	}
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer "+expired)
	if _, err := f.auth.validateRequest(req); err == nil {
		t.Fatal("expired key accepted by validateRequest")
	}
	// Legacy prefix still authenticates through the request path and introspection.
	req.Header.Set("Authorization", "Bearer "+live)
	if c, err := f.auth.validateRequest(req); err != nil || c.TenantID != f.tenantID {
		t.Fatalf("legacy hlx_live_ key rejected: %v", err)
	}
	if f.introspect(live) != 200 {
		t.Fatal("legacy key must introspect")
	}
}

func TestAPIKey_RotateAtomicOldDeadNewLive(t *testing.T) {
	f := newKeyFixture(t)
	_, old := f.create(f.jwt, map[string]any{"name": "ci", "scopes": []string{"runs:read", "agents:read"}})
	rr := f.call(f.h.RotateApiKey, "POST", "/v1/api-keys/"+old.Key.ID+"/rotate", f.jwt, map[string]any{})
	if rr.Code != http.StatusCreated {
		t.Fatalf("rotate: %d %s", rr.Code, rr.Body)
	}
	var nk keyResp
	_ = json.Unmarshal(rr.Body.Bytes(), &nk)
	if f.valid(old.RawKey) || f.introspect(old.RawKey) != 401 {
		t.Fatal("old key still valid after rotate")
	}
	if !f.valid(nk.RawKey) || nk.RawKey == old.RawKey || !strings.HasPrefix(nk.RawKey, "pal_live_") {
		t.Fatal("new key not usable")
	}
	if strings.Join(nk.Key.Scopes, ",") != "runs:read,agents:read" {
		t.Fatalf("scopes not preserved: %v", nk.Key.Scopes)
	}
	var cb string
	_ = f.h.srv.Pool.QueryRow(context.Background(), `SELECT created_by FROM api_keys WHERE id=$1`, nk.Key.ID).Scan(&cb)
	if cb != f.userID {
		t.Fatalf("rotated key created_by=%q", cb)
	}
	// Already revoked -> 404; unknown / cross-tenant id -> 404.
	if rr := f.call(f.h.RotateApiKey, "POST", "/v1/api-keys/"+old.Key.ID+"/rotate", f.jwt, nil); rr.Code != http.StatusNotFound {
		t.Fatalf("re-rotate revoked: %d", rr.Code)
	}
	other := newKeyFixture(t)
	if rr := other.call(other.h.RotateApiKey, "POST", "/v1/api-keys/"+nk.Key.ID+"/rotate", other.jwt, nil); rr.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant rotate: %d", rr.Code)
	}
	if !f.valid(nk.RawKey) {
		t.Fatal("cross-tenant rotate attempt revoked the key")
	}
}

func TestAPIKey_RotateSubsetRuleAndRollback(t *testing.T) {
	f := newKeyFixture(t)
	// Target holds admin; caller key only holds runs:read -> cannot rotate it.
	_, target := f.create(f.jwt, map[string]any{"name": "big", "scopes": []string{"admin"}})
	_, weak := f.create(f.jwt, map[string]any{"name": "weak", "scopes": []string{"runs:read"}})
	rr := f.call(f.h.RotateApiKey, "POST", "/v1/api-keys/"+target.Key.ID+"/rotate", weak.RawKey, nil)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("subset violation: %d %s, want 403", rr.Code, rr.Body)
	}
	if !f.valid(target.RawKey) {
		t.Fatal("failed rotate must roll back the revoke (old key must stay live)")
	}
	if n := countRows(t, f.h.srv.Pool, `SELECT count(*) FROM api_keys WHERE tenant_id='`+f.tenantID+`'`); n != 2 {
		t.Fatalf("rows=%d, a failed rotate left a replacement key", n)
	}
}

func TestAPIKey_RotateExpiredNeedsNewExpiryAndRollsBack(t *testing.T) {
	f := newKeyFixture(t)
	past := time.Now().Add(-time.Hour)
	id := f.insertKey("pal_live_oldexpired0000"+f.userID[:8], []string{"read"}, &past)
	rr := f.call(f.h.RotateApiKey, "POST", "/v1/api-keys/"+id+"/rotate", f.jwt, map[string]any{})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("got %d %s", rr.Code, rr.Body)
	}
	var revoked *time.Time
	_ = f.h.srv.Pool.QueryRow(context.Background(), `SELECT revoked_at FROM api_keys WHERE id=$1`, id).Scan(&revoked)
	if revoked != nil {
		t.Fatal("rejected rotate must not revoke")
	}
	rr = f.call(f.h.RotateApiKey, "POST", "/v1/api-keys/"+id+"/rotate", f.jwt, map[string]any{"expiresAt": time.Now().Add(time.Hour)})
	if rr.Code != http.StatusCreated {
		t.Fatalf("rotate with new expiry: %d %s", rr.Code, rr.Body)
	}
}
