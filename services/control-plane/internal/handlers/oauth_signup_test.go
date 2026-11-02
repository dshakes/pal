package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// TestOAuthCallback_SignupPolicy drives the real OAuth callback (DB + Redis,
// fake Google endpoints): a NEW user arriving via OAuth is a sign-up and gets
// the same PAL_SIGNUP_MODE + rate-limit policy as POST /auth/signup, while an
// EXISTING user always signs in.
func TestOAuthCallback_SignupPolicy(t *testing.T) {
	h, _ := newLifecycleHandler(t) // skips without DATABASE_URL
	rc := maybeRedis(t)
	if rc == nil {
		t.Skip("needs Redis (REDIS_URL) for OAuth state")
	}
	h.srv.Redis = rc

	var profileEmail string
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			fmt.Fprint(w, `{"access_token":"tok"}`)
		case "/userinfo":
			_ = json.NewEncoder(w).Encode(map[string]any{"email": profileEmail, "name": "OAuth User", "verified_email": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer idp.Close()
	orig := oauthLoginProviders["google"]
	p := orig
	p.TokenURL, p.UserInfoURL = idp.URL+"/token", idp.URL+"/userinfo"
	oauthLoginProviders["google"] = p
	t.Cleanup(func() { oauthLoginProviders["google"] = orig })
	t.Setenv("GOOGLE_CLIENT_ID", "cid")
	t.Setenv("GOOGLE_CLIENT_SECRET", "csecret")

	// callback runs one OAuth round trip for email and returns the redirect.
	callback := func(t *testing.T, email, invite string) string {
		t.Helper()
		profileEmail = email
		state, _ := randomHex(12)
		sd, _ := json.Marshal(map[string]string{"provider": "google", "pkce_verifier": "v", "invite": invite})
		if err := rc.Set(context.Background(), "oauth_login_state:"+state, string(sd), time.Minute).Err(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodGet, "/auth/oauth/google/callback?code=c&state="+state, nil)
		req.SetPathValue("provider", "google")
		req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: oauthStateDigest(state)})
		rr := httptest.NewRecorder()
		h.OAuthCallback(rr, req)
		return rr.Header().Get("Location")
	}
	userExists := func(t *testing.T, email string) bool {
		var n int
		if err := h.srv.Pool.QueryRow(context.Background(), `SELECT count(*) FROM users WHERE email = $1`, email).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n > 0
	}
	const ok = "/auth/callback?code="

	cases := []struct {
		name, env, mode string
		invite          func(email string) string
		prefillLimit    bool
		wantOK          bool
		wantErr         string
	}{
		{name: "closed refuses new user", mode: "closed", wantErr: "Sign-up+is+closed"},
		{name: "prod default (closed) refuses new user", env: "production", wantErr: "Sign-up+is+closed"},
		{name: "invite without code refused", mode: "invite", wantErr: "invite"},
		{name: "invite for another email refused", mode: "invite",
			invite: func(string) string { return mintInvite("inv", "other@example.test", time.Now().Add(time.Hour)) }, wantErr: "invite"},
		{name: "invite with valid code admitted", mode: "invite",
			invite: func(e string) string { return mintInvite("inv", e, time.Now().Add(time.Hour)) }, wantOK: true},
		{name: "open admitted", mode: "open", wantOK: true},
		{name: "open over the per-IP limit refused", mode: "open", prefillLimit: true, wantErr: "Too+many"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setSignupEnv(t, tc.env, tc.mode, "")
			t.Setenv("PAL_SIGNUP_INVITE_SECRET", "inv")
			h.rl = newFakeRedis()
			if tc.prefillLimit {
				for i := 0; i < signupPerIPHour; i++ {
					h.rl.Incr(context.Background(), "auth_rl:signup:ip:192.0.2.1")
				}
			}
			email := uniqueEmail(t)
			t.Cleanup(func() { cleanupUserByEmail(t, h, email) })
			inv := ""
			if tc.invite != nil {
				inv = tc.invite(email)
			}
			loc := callback(t, email, inv)
			if tc.wantOK {
				if !strings.Contains(loc, ok) || !userExists(t, email) {
					t.Fatalf("want sign-up, got redirect %q (user created=%v)", loc, userExists(t, email))
				}
				return
			}
			if !strings.Contains(loc, "/login?error=") || !strings.Contains(loc, tc.wantErr) {
				t.Fatalf("want refusal ~%q, got %q", tc.wantErr, loc)
			}
			if userExists(t, email) {
				t.Fatal("refused OAuth sign-up still created a user")
			}
		})
	}

	t.Run("existing user signs in even when sign-up is closed", func(t *testing.T) {
		setSignupEnv(t, "", "open", "")
		h.rl = newFakeRedis()
		email := uniqueEmail(t)
		t.Cleanup(func() { cleanupUserByEmail(t, h, email) })
		if loc := callback(t, email, ""); !strings.Contains(loc, ok) {
			t.Fatalf("setup sign-up failed: %q", loc)
		}
		setSignupEnv(t, "production", "closed", "")
		h.rl = nil // even with no limiter: sign-in is not sign-up
		if loc := callback(t, email, ""); !strings.Contains(loc, ok) {
			t.Fatalf("existing user must sign in with sign-up closed, got %q", loc)
		}
	})
}

// TestOAuthStart_CarriesInviteInState: the invite code reaches the callback
// only through the server-side state, never the provider round trip.
func TestOAuthStart_CarriesInviteInState(t *testing.T) {
	rc := maybeRedis(t)
	if rc == nil {
		t.Skip("needs Redis (REDIS_URL) for OAuth state")
	}
	h := noDBAuthHandler()
	h.srv.Redis = rc
	t.Setenv("GOOGLE_CLIENT_ID", "cid")
	t.Setenv("GOOGLE_CLIENT_SECRET", "csecret")
	req := httptest.NewRequest(http.MethodGet, "/auth/oauth/google/start?invite=INV-123", nil)
	req.SetPathValue("provider", "google")
	rr := httptest.NewRecorder()
	h.OAuthStart(rr, req)
	var out struct {
		RedirectURL string `json:"redirect_url"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.RedirectURL, "INV-123") {
		t.Fatal("invite code leaked into the provider redirect URL")
	}
	u, _ := url.Parse(out.RedirectURL)
	raw, err := rc.Get(context.Background(), "oauth_login_state:"+u.Query().Get("state")).Result()
	if err != nil {
		t.Fatal(err)
	}
	var st map[string]string
	_ = json.Unmarshal([]byte(raw), &st)
	if st["invite"] != "INV-123" {
		t.Fatalf("state invite = %q, want INV-123", st["invite"])
	}
}

// ---------- OAuth hardening: verified email, linking, browser binding ----------

// fakeIdP serves Google (v2 userinfo) and GitHub (/user + /user/emails).
type fakeIdP struct {
	mu           sync.Mutex
	googleUser   map[string]any
	githubUser   map[string]any
	githubEmails []map[string]any
}

func (f *fakeIdP) set(fn func(*fakeIdP)) { f.mu.Lock(); fn(f); f.mu.Unlock() }

type oauthFixture struct {
	h   *AuthHandler
	rc  *redis.Client
	idp *fakeIdP
}

func newOAuthFixture(t *testing.T) *oauthFixture {
	t.Helper()
	h, _ := newLifecycleHandler(t) // skips without DATABASE_URL
	rc := maybeRedis(t)
	if rc == nil {
		t.Skip("needs Redis (REDIS_URL) for OAuth state")
	}
	h.srv.Redis = rc
	f := &fakeIdP{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/token":
			fmt.Fprint(w, `{"access_token":"tok"}`)
		case "/google/userinfo":
			_ = json.NewEncoder(w).Encode(f.googleUser)
		case "/github/user":
			_ = json.NewEncoder(w).Encode(f.githubUser)
		case "/github/emails":
			_ = json.NewEncoder(w).Encode(f.githubEmails)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	for name, path := range map[string]string{"google": "/google/userinfo", "github": "/github/user"} {
		orig := oauthLoginProviders[name]
		p := orig
		p.TokenURL, p.UserInfoURL = srv.URL+"/token", srv.URL+path
		if name == "github" {
			p.EmailsURL = srv.URL + "/github/emails"
		}
		oauthLoginProviders[name] = p
		t.Cleanup(func() { oauthLoginProviders[name] = orig })
	}
	for _, k := range []string{"GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"} {
		t.Setenv(k, "x")
	}
	setSignupEnv(t, "", "open", "")
	h.rl = nil // dev: no limiter, fails open
	return &oauthFixture{h: h, rc: rc, idp: f}
}

// verifiedEverywhere makes both providers report email as verified.
func (o *oauthFixture) verifiedEverywhere(email string) {
	o.idp.set(func(f *fakeIdP) {
		f.googleUser = map[string]any{"email": email, "name": "G", "verified_email": true}
		f.githubUser = map[string]any{"login": "gh", "email": email}
		f.githubEmails = []map[string]any{{"email": email, "primary": true, "verified": true}}
	})
}

// mint stores a fresh state for provider and returns it.
func (o *oauthFixture) mint(t *testing.T, provider string) string {
	t.Helper()
	state, _ := randomHex(12)
	sd, _ := json.Marshal(map[string]string{"provider": provider, "pkce_verifier": "v"})
	if err := o.rc.Set(context.Background(), "oauth_login_state:"+state, string(sd), time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	return state
}

// callback runs the callback with an explicit cookie value ("" = no cookie)
// and returns the redirect Location.
func (o *oauthFixture) callback(provider, state, cookie string) string {
	req := httptest.NewRequest(http.MethodGet, "/auth/oauth/"+provider+"/callback?code=c&state="+state, nil)
	req.SetPathValue("provider", provider)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: cookie})
	}
	rr := httptest.NewRecorder()
	o.h.OAuthCallback(rr, req)
	return rr.Header().Get("Location")
}

// signIn is one well-formed round trip (fresh state, matching cookie).
func (o *oauthFixture) signIn(t *testing.T, provider string) string {
	t.Helper()
	s := o.mint(t, provider)
	return o.callback(provider, s, oauthStateDigest(s))
}

func (o *oauthFixture) countRows(t *testing.T, email string) (users, tenants int) {
	t.Helper()
	err := o.h.srv.Pool.QueryRow(context.Background(),
		`SELECT count(*), count(DISTINCT tenant_id) FROM users WHERE lower(email) = lower($1)`, email).Scan(&users, &tenants)
	if err != nil {
		t.Fatal(err)
	}
	return users, tenants
}

const oauthOK = "/auth/callback?code="

func TestOAuthCallback_RequiresProviderVerifiedEmail(t *testing.T) {
	o := newOAuthFixture(t)
	cases := []struct {
		name     string
		provider string
		setup    func(f *fakeIdP, email string)
		wantOK   bool
	}{
		{"google verified_email=false refused", "google", func(f *fakeIdP, e string) {
			f.googleUser = map[string]any{"email": e, "verified_email": false}
		}, false},
		{"google flag missing refused", "google", func(f *fakeIdP, e string) {
			f.googleUser = map[string]any{"email": e}
		}, false},
		{"google OIDC email_verified accepted", "google", func(f *fakeIdP, e string) {
			f.googleUser = map[string]any{"email": e, "email_verified": true}
		}, true},
		{"github profile email ignored when primary unverified", "github", func(f *fakeIdP, e string) {
			f.githubUser = map[string]any{"login": "x", "email": e}
			f.githubEmails = []map[string]any{{"email": e, "primary": true, "verified": false}}
		}, false},
		{"github verified non-primary is not enough", "github", func(f *fakeIdP, e string) {
			f.githubUser = map[string]any{"login": "x"}
			f.githubEmails = []map[string]any{{"email": "other@example.test", "primary": true, "verified": false}, {"email": e, "primary": false, "verified": true}}
		}, false},
		{"github primary verified accepted", "github", func(f *fakeIdP, e string) {
			f.githubUser = map[string]any{"login": "x", "email": "public-unverified@example.test"}
			f.githubEmails = []map[string]any{{"email": e, "primary": true, "verified": true}}
		}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			email := uniqueEmail(t)
			t.Cleanup(func() { cleanupUserByEmail(t, o.h, email) })
			o.idp.set(func(f *fakeIdP) { tc.setup(f, email) })
			loc := o.signIn(t, tc.provider)
			users, _ := o.countRows(t, email)
			if tc.wantOK {
				if !strings.Contains(loc, oauthOK) || users != 1 {
					t.Fatalf("want sign-up, got %q (users=%d)", loc, users)
				}
				return
			}
			if !strings.Contains(loc, "not+verified") || users != 0 {
				t.Fatalf("want unverified refusal and no user, got %q (users=%d)", loc, users)
			}
		})
	}
}

func TestOAuthCallback_LinkPolicy(t *testing.T) {
	o := newOAuthFixture(t)
	ctx := context.Background()

	cases := []struct {
		name         string
		authProvider string // existing account's provider
		verified     bool   // existing account's email_verified_at set
		signInWith   string
		wantOK       bool
	}{
		{"unverified password account is not linkable", "local", false, "google", false},
		{"unverified password account refuses github too", "local", false, "github", false},
		{"verified password account links (provider-verified email)", "local", true, "google", true},
		{"same provider signs in", "google", true, "google", true},
		{"other provider links to verified oauth account", "google", true, "github", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			email := uniqueEmail(t)
			t.Cleanup(func() { cleanupUserByEmail(t, o.h, email) })
			// The existing account: a tenant + one user, mixed-case email to
			// prove the match is case-insensitive.
			stored := strings.ToUpper(email[:1]) + email[1:]
			var tenantID, userID string
			slug, _ := randomHex(6)
			if err := o.h.srv.Pool.QueryRow(ctx, `INSERT INTO tenants (slug, name, tier, k8s_namespace) VALUES ($1,$1,'personal',$1) RETURNING id`, "lt-"+slug).Scan(&tenantID); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _, _ = o.h.srv.Pool.Exec(ctx, `DELETE FROM tenants WHERE id = $1`, tenantID) })
			verifiedAt := "NULL"
			if tc.verified {
				verifiedAt = "now()"
			}
			if err := o.h.srv.Pool.QueryRow(ctx, `INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject, role, email_verified_at)
				VALUES ($1, $2, 'Existing', $3, $2, 'owner', `+verifiedAt+`) RETURNING id`, tenantID, stored, tc.authProvider).Scan(&userID); err != nil {
				t.Fatal(err)
			}
			o.verifiedEverywhere(email)

			loc := o.signIn(t, tc.signInWith)
			users, tenants := o.countRows(t, email)
			if users != 1 || tenants != 1 {
				t.Fatalf("OAuth sign-in must never create a second account: users=%d tenants=%d", users, tenants)
			}
			if !tc.wantOK {
				if !strings.Contains(loc, "Sign+in+with+your+password") {
					t.Fatalf("want link refusal, got %q", loc)
				}
				return
			}
			if !strings.Contains(loc, oauthOK) {
				t.Fatalf("want sign-in, got %q", loc)
			}
			code, _ := url.Parse(loc)
			tok, err := o.rc.Get(ctx, "oauth_code:"+code.Query().Get("code")).Result()
			if err != nil {
				t.Fatal(err)
			}
			claims, err := o.h.ValidateToken(tok)
			if err != nil || claims.Subject != userID {
				t.Fatalf("signed in as %+v (err %v), want existing user %s", claims, err, userID)
			}
		})
	}
}

func TestOAuthCallback_StateBoundToBrowser(t *testing.T) {
	o := newOAuthFixture(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, o.h, email) })
	o.verifiedEverywhere(email)

	t.Run("missing cookie refused and state not consumed", func(t *testing.T) {
		s := o.mint(t, "google")
		if loc := o.callback("google", s, ""); !strings.Contains(loc, "not+started+in+this+browser") {
			t.Fatalf("got %q", loc)
		}
		if loc := o.callback("google", s, oauthStateDigest(s)); !strings.Contains(loc, oauthOK) {
			t.Fatalf("the owning browser must still complete: %q", loc)
		}
	})
	t.Run("mismatched cookie refused (login CSRF)", func(t *testing.T) {
		attacker := o.mint(t, "google")
		victim := o.mint(t, "google")
		if loc := o.callback("google", attacker, oauthStateDigest(victim)); !strings.Contains(loc, "not+started+in+this+browser") {
			t.Fatalf("got %q", loc)
		}
		if loc := o.callback("google", attacker, attacker); !strings.Contains(loc, "not+started+in+this+browser") {
			t.Fatalf("raw state as cookie must not match: %q", loc)
		}
	})
	t.Run("replay refused", func(t *testing.T) {
		s := o.mint(t, "google")
		if loc := o.callback("google", s, oauthStateDigest(s)); !strings.Contains(loc, oauthOK) {
			t.Fatalf("first: %q", loc)
		}
		if loc := o.callback("google", s, oauthStateDigest(s)); !strings.Contains(loc, "Invalid+or+expired+state") {
			t.Fatalf("replay: %q", loc)
		}
	})
	t.Run("concurrent double callback: exactly one succeeds", func(t *testing.T) {
		for i := 0; i < 5; i++ {
			s := o.mint(t, "google")
			const n = 8
			locs := make([]string, n)
			var wg sync.WaitGroup
			for j := 0; j < n; j++ {
				wg.Add(1)
				go func(j int) { defer wg.Done(); locs[j] = o.callback("google", s, oauthStateDigest(s)) }(j)
			}
			wg.Wait()
			ok := 0
			for _, l := range locs {
				if strings.Contains(l, oauthOK) {
					ok++
				}
			}
			if ok != 1 {
				t.Fatalf("round %d: %d callbacks succeeded with one state, want 1: %v", i, ok, locs)
			}
		}
	})
}

// Concurrent FIRST sign-ins for one email (different providers, so the
// (auth_provider, auth_subject) unique does not save us) create one account.
func TestOAuthCallback_ConcurrentFirstSignInOneTenant(t *testing.T) {
	o := newOAuthFixture(t)
	for i := 0; i < 5; i++ {
		email := uniqueEmail(t)
		t.Cleanup(func() { cleanupUserByEmail(t, o.h, email) })
		o.verifiedEverywhere(email)
		providers := []string{"google", "github", "google", "github"}
		locs := make([]string, len(providers))
		var wg sync.WaitGroup
		for j, p := range providers {
			s := o.mint(t, p)
			wg.Add(1)
			go func(j int, p, s string) { defer wg.Done(); locs[j] = o.callback(p, s, oauthStateDigest(s)) }(j, p, s)
		}
		wg.Wait()
		users, tenants := o.countRows(t, email)
		if users != 1 || tenants != 1 {
			t.Fatalf("round %d: users=%d tenants=%d, want 1/1 (locs %v)", i, users, tenants, locs)
		}
		for _, l := range locs {
			if !strings.Contains(l, oauthOK) {
				t.Fatalf("round %d: a concurrent first sign-in failed: %v", i, locs)
			}
		}
	}
}

// OAuthStart binds the state to the browser with a hashed, HttpOnly, Lax,
// path-scoped cookie (Secure in prod); redirect=1 navigates to the provider.
func TestOAuthStart_SetsBrowserBindingCookie(t *testing.T) {
	rc := maybeRedis(t)
	if rc == nil {
		t.Skip("needs Redis (REDIS_URL) for OAuth state")
	}
	h := noDBAuthHandler()
	h.srv.Redis = rc
	t.Setenv("GOOGLE_CLIENT_ID", "cid")
	t.Setenv("GOOGLE_CLIENT_SECRET", "csecret")
	for _, tc := range []struct {
		env        string
		navigate   bool
		wantSecure bool
	}{{"", false, false}, {"", true, false}, {"production", true, true}} {
		t.Setenv("PAL_ENV", tc.env)
		target := "/auth/oauth/google/start"
		if tc.navigate {
			target += "?redirect=1"
		}
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.SetPathValue("provider", "google")
		rr := httptest.NewRecorder()
		h.OAuthStart(rr, req)
		var authURL string
		if tc.navigate {
			if rr.Code != http.StatusFound {
				t.Fatalf("redirect=1: status %d", rr.Code)
			}
			authURL = rr.Header().Get("Location")
		} else {
			var out struct {
				RedirectURL string `json:"redirect_url"`
			}
			_ = json.NewDecoder(rr.Body).Decode(&out)
			authURL = out.RedirectURL
		}
		u, err := url.Parse(authURL)
		if err != nil || u.Query().Get("state") == "" || u.Query().Get("code_challenge_method") != "S256" {
			t.Fatalf("bad provider URL %q", authURL)
		}
		var c *http.Cookie
		for _, ck := range rr.Result().Cookies() {
			if ck.Name == oauthStateCookie {
				c = ck
			}
		}
		if c == nil {
			t.Fatal("no browser-binding cookie set")
		}
		if c.Value != oauthStateDigest(u.Query().Get("state")) || c.Value == u.Query().Get("state") {
			t.Fatal("cookie must hold the state digest, not the state")
		}
		if !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Path != "/auth/oauth/" || c.MaxAge <= 0 || c.MaxAge > 600 || c.Secure != tc.wantSecure {
			t.Fatalf("cookie attrs wrong (env %q): %+v", tc.env, c)
		}
	}

	t.Run("redirect=1 errors go back to the dashboard", func(t *testing.T) {
		t.Setenv("GOOGLE_CLIENT_ID", "")
		req := httptest.NewRequest(http.MethodGet, "/auth/oauth/google/start?redirect=1", nil)
		req.SetPathValue("provider", "google")
		rr := httptest.NewRecorder()
		h.OAuthStart(rr, req)
		if rr.Code != http.StatusFound || !strings.Contains(rr.Header().Get("Location"), "/login?error=") {
			t.Fatalf("got %d %q", rr.Code, rr.Header().Get("Location"))
		}
	})
}
