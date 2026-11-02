package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
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
			_ = json.NewEncoder(w).Encode(map[string]string{"email": profileEmail, "name": "OAuth User"})
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
