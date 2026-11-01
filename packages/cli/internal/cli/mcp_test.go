package cli

// mcp_test.go — `pal mcp …` against a mock control-plane mirroring the real
// /v1/mcp/* and /v1/agents/{name}/mcp-servers shapes.

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMCPCommands(t *testing.T) {
	var gotMethod, gotPath, gotBody string
	mux := http.NewServeMux()
	reply := func(status int, body string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			gotMethod, gotPath, gotBody = r.Method, r.URL.Path, string(b)
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
		}
	}
	mux.HandleFunc("GET /v1/mcp/servers", reply(200, `[{"slug":"github","name":"GitHub","transport":"streamable-http","authType":"oauth"}]`))
	mux.HandleFunc("POST /v1/mcp/tenant-servers", reply(201, `{"slug":"acme","url":"https://x.test/mcp","authType":"bearer"}`))
	mux.HandleFunc("DELETE /v1/mcp/tenant-servers/{slug}", reply(204, ``))
	mux.HandleFunc("POST /v1/agents/{name}/mcp-servers", reply(201, `{"status":"attached"}`))
	mux.HandleFunc("DELETE /v1/agents/{name}/mcp-servers/{slug}", reply(204, ``))
	mux.HandleFunc("GET /v1/agents/{name}/mcp-servers/{slug}/tools", reply(200,
		`{"server":"acme","tools":[{"name":"ping","toolName":"mcp__acme__ping","description":"Ping","allowedByPolicy":false}]}`))
	mux.HandleFunc("PUT /v1/mcp/credentials/{slug}", reply(200, `{"status":"stored","kind":"bearer"}`))
	mux.HandleFunc("GET /v1/mcp/credentials", reply(200, `[{"serverSlug":"acme","kind":"bearer","updatedAt":"now"}]`))
	mux.HandleFunc("POST /v1/mcp/oauth/start", reply(200, `{"authorizationUrl":"https://as.test/auth?x=1","redirectUri":"r","expiresAt":"e"}`))
	mux.HandleFunc("POST /v1/mcp/oauth/callback", reply(200, `{"status":"connected","serverSlug":"acme"}`))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	withAPIURL(t, srv.URL)

	tests := []struct {
		name               string
		args               []string
		stdin              string
		wantErr            string
		wantOut            []string
		wantMethod, wantPa string
		wantBody           string
	}{
		{"servers", []string{"servers"}, "", "", []string{"github", "oauth"}, "GET", "/v1/mcp/servers", ""},
		{"add", []string{"add", "acme", "--url", "https://x.test/mcp", "--auth", "bearer", "--name", "Acme"}, "", "", []string{"Registered acme"},
			"POST", "/v1/mcp/tenant-servers", `{"authType":"bearer","name":"Acme","slug":"acme","url":"https://x.test/mcp"}`},
		{"add needs url", []string{"add", "acme"}, "", "--url is required", nil, "", "", ""},
		{"add bad auth", []string{"add", "acme", "--url", "u", "--auth", "basic"}, "", "--auth must be", nil, "", "", ""},
		{"remove", []string{"remove", "acme"}, "", "", []string{"removed"}, "DELETE", "/v1/mcp/tenant-servers/acme", ""},
		{"attach with vm", []string{"attach", "triage", "fs", "--vm", "vm-1"}, "", "", []string{"Attached fs"},
			"POST", "/v1/agents/triage/mcp-servers", `{"config":{"vmId":"vm-1"},"serverSlug":"fs"}`},
		{"detach", []string{"detach", "triage", "fs"}, "", "", []string{"Detached"}, "DELETE", "/v1/agents/triage/mcp-servers/fs", ""},
		{"tools", []string{"tools", "triage", "acme"}, "", "", []string{"mcp__acme__ping", "blocked by policy"},
			"GET", "/v1/agents/triage/mcp-servers/acme/tools", ""},
		{"token from stdin", []string{"token", "acme"}, "s3cret-token\n", "", []string{"Token stored"},
			"PUT", "/v1/mcp/credentials/acme", `{"token":"s3cret-token"}`},
		{"token empty", []string{"token", "acme"}, "", "no token", nil, "", "", ""},
		{"creds", []string{"creds"}, "", "", []string{"acme", "bearer"}, "GET", "/v1/mcp/credentials", ""},
		{"login no-wait", []string{"login", "acme", "--no-wait", "--scope", "read"}, "", "", []string{"https://as.test/auth?x=1"},
			"POST", "/v1/mcp/oauth/start", `{"scope":"read","serverSlug":"acme"}`},
		{"login paste redirect", []string{"login", "acme"}, "https://pal.test/settings/mcp/callback?code=abc&state=xyz\n", "", []string{"Connected acme"},
			"POST", "/v1/mcp/oauth/callback", `{"code":"abc","state":"xyz"}`},
		{"login paste code state", []string{"login", "acme"}, "abc xyz\n", "", []string{"Connected acme"},
			"POST", "/v1/mcp/oauth/callback", `{"code":"abc","state":"xyz"}`},
		{"login AS error", []string{"login", "acme"}, "https://pal.test/cb?error=access_denied\n", "access_denied", nil, "POST", "/v1/mcp/oauth/start", `{"serverSlug":"acme"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotMethod, gotPath, gotBody = "", "", ""
			cmd := newMCPCommand()
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(io.Discard)
			cmd.SetIn(strings.NewReader(tc.stdin))
			cmd.SetArgs(tc.args)
			err := cmd.ExecuteContext(context.Background())
			if tc.wantErr == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
			}
			for _, w := range tc.wantOut {
				if !strings.Contains(out.String(), w) {
					t.Errorf("output missing %q:\n%s", w, out.String())
				}
			}
			if strings.Contains(out.String(), "s3cret-token") {
				t.Errorf("token echoed:\n%s", out.String())
			}
			if gotMethod != tc.wantMethod || gotPath != tc.wantPa || gotBody != tc.wantBody {
				t.Errorf("request = %s %s %s, want %s %s %s", gotMethod, gotPath, gotBody, tc.wantMethod, tc.wantPa, tc.wantBody)
			}
		})
	}
}
