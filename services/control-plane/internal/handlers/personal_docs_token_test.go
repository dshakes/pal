package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestPersonalDocsTokenFor(t *testing.T) {
	env := map[string]string{"PAL_BRIDGE_TOKEN": "wa-tok", "PAL_IMESSAGE_BRIDGE_TOKEN": "im-tok"}
	get := func(k string) string { return env[k] }
	if got := personalDocsTokenFor(true, get); got != "wa-tok" {
		t.Fatalf("WA-bound call must use PAL_BRIDGE_TOKEN, got %q", got)
	}
	if got := personalDocsTokenFor(false, get); got != "im-tok" {
		t.Fatalf("iMessage-bound call must use PAL_IMESSAGE_BRIDGE_TOKEN, got %q", got)
	}
	// No cross-fallback: the other bridge's token is a guaranteed 401.
	if got := personalDocsTokenFor(true, func(k string) string {
		if k == "PAL_IMESSAGE_BRIDGE_TOKEN" {
			return "im-tok"
		}
		return ""
	}); got != "" {
		t.Fatalf("WA-bound call must not fall back to the iMessage token, got %q", got)
	}
}

// Each bridge only accepts its own token: prove the real call path sends the right one.
func TestPersonalDocsToolSendsDestinationBridgeToken(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]string{}
	mk := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			seen[name] = r.Header.Get("Authorization")
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"results":[]}`))
		}))
	}
	im, wa := mk("imessage"), mk("whatsapp")
	defer im.Close()
	defer wa.Close()
	t.Setenv("PAL_PERSONAL_DOCS_BRIDGE_URL", im.URL)
	t.Setenv("PAL_WHATSAPP_BRIDGE_URL", wa.URL)
	t.Setenv("PAL_BRIDGE_TOKEN", "wa-tok")
	t.Setenv("PAL_IMESSAGE_BRIDGE_TOKEN", "im-tok")

	ctx := context.Background()
	if _, err := executePersonalDocsTool(ctx, "tenant-1", personalDocsSearchTool, map[string]any{"query": "passport"}); err != nil {
		t.Fatalf("iMessage tool: %v", err)
	}
	if _, err := executePersonalDocsTool(ctx, "tenant-1", whatsappHistorySearchTool, map[string]any{"query": "dinner"}); err != nil {
		t.Fatalf("whatsapp tool: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if seen["imessage"] != "Bearer im-tok" {
		t.Errorf("iMessage bridge got %q, want Bearer im-tok", seen["imessage"])
	}
	if seen["whatsapp"] != "Bearer wa-tok" {
		t.Errorf("WhatsApp bridge got %q, want Bearer wa-tok", seen["whatsapp"])
	}
}
