package pal

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// mcpServer records the last request and replies with body.
func mcpServer(t *testing.T, body string, got *struct {
	Method, Path string
	Body         map[string]any
}) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.Method, got.Path = r.Method, r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		got.Body = nil
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &got.Body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return New(WithBaseURL(srv.URL))
}

func TestMCP_AttachUsesServerSlugAndVMID(t *testing.T) {
	var got struct {
		Method, Path string
		Body         map[string]any
	}
	c := mcpServer(t, `{"status":"attached"}`, &got)
	if err := c.AttachMCPServer(context.Background(), "triage", "acme", map[string]any{"vmId": "vm-1"}); err != nil {
		t.Fatal(err)
	}
	if got.Method != "POST" || got.Path != "/v1/agents/triage/mcp-servers" || got.Body["serverSlug"] != "acme" {
		t.Fatalf("unexpected request: %+v", got)
	}
	if cfg, _ := got.Body["config"].(map[string]any); cfg["vmId"] != "vm-1" {
		t.Fatalf("config lost: %+v", got.Body)
	}
}

func TestMCP_TenantServers(t *testing.T) {
	var got struct {
		Method, Path string
		Body         map[string]any
	}
	c := mcpServer(t, `{"slug":"acme","name":"acme","url":"https://x.test/mcp","authType":"bearer"}`, &got)
	s, err := c.CreateMCPTenantServer(context.Background(), MCPTenantServerSpec{Slug: "acme", URL: "https://x.test/mcp", AuthType: "bearer"})
	if err != nil || s.Slug != "acme" {
		t.Fatalf("create: %v %+v", err, s)
	}
	if got.Method != "POST" || got.Path != "/v1/mcp/tenant-servers" || got.Body["authType"] != "bearer" {
		t.Fatalf("unexpected request: %+v", got)
	}
	c = mcpServer(t, `[{"slug":"acme","name":"acme","url":"u","authType":"none"}]`, &got)
	list, err := c.ListMCPTenantServers(context.Background())
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %+v", err, list)
	}
	if err := c.DeleteMCPTenantServer(context.Background(), "acme"); err != nil {
		t.Fatal(err)
	}
	if got.Method != "DELETE" || got.Path != "/v1/mcp/tenant-servers/acme" {
		t.Fatalf("unexpected request: %+v", got)
	}
}

func TestMCP_Credentials(t *testing.T) {
	var got struct {
		Method, Path string
		Body         map[string]any
	}
	c := mcpServer(t, `[{"serverSlug":"acme","kind":"bearer","updatedAt":"now"}]`, &got)
	creds, err := c.ListMCPCredentials(context.Background())
	if err != nil || len(creds) != 1 || creds[0].Kind != "bearer" {
		t.Fatalf("list: %v %+v", err, creds)
	}
	if err := c.PutMCPBearer(context.Background(), "acme", "s3cret"); err != nil {
		t.Fatal(err)
	}
	if got.Method != "PUT" || got.Path != "/v1/mcp/credentials/acme" || got.Body["token"] != "s3cret" {
		t.Fatalf("unexpected request: %+v", got)
	}
	if err := c.DeleteMCPCredential(context.Background(), "acme"); err != nil {
		t.Fatal(err)
	}
	if got.Method != "DELETE" || got.Path != "/v1/mcp/credentials/acme" {
		t.Fatalf("unexpected request: %+v", got)
	}
}

func TestMCP_OAuthAndTools(t *testing.T) {
	var got struct {
		Method, Path string
		Body         map[string]any
	}
	c := mcpServer(t, `{"authorizationUrl":"https://as.test/auth","redirectUri":"r","expiresAt":"e"}`, &got)
	st, err := c.MCPOAuthStart(context.Background(), MCPOAuthStartRequest{ServerSlug: "acme", Scope: "read"})
	if err != nil || st.AuthorizationURL != "https://as.test/auth" {
		t.Fatalf("start: %v %+v", err, st)
	}
	if got.Path != "/v1/mcp/oauth/start" || got.Body["serverSlug"] != "acme" {
		t.Fatalf("unexpected request: %+v", got)
	}
	if err := c.MCPOAuthCallback(context.Background(), "c", "s"); err != nil {
		t.Fatal(err)
	}
	if got.Path != "/v1/mcp/oauth/callback" || got.Body["code"] != "c" || got.Body["state"] != "s" {
		t.Fatalf("unexpected request: %+v", got)
	}
	c = mcpServer(t, `{"server":"acme","tools":[{"name":"ping","toolName":"mcp__acme__ping","description":"d"}]}`, &got)
	res, err := c.ListMCPAttachmentTools(context.Background(), "triage", "acme")
	if err != nil || len(res.Tools) != 1 || res.Tools[0].ToolName != "mcp__acme__ping" {
		t.Fatalf("tools: %v %+v", err, res)
	}
	if got.Path != "/v1/agents/triage/mcp-servers/acme/tools" {
		t.Fatalf("unexpected path: %s", got.Path)
	}
}
