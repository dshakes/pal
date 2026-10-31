package mcp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeServer is a minimal Streamable HTTP MCP server used to pin client
// behaviour. Interop with the reference SDKs is proven separately (ADR 0058).
type fakeServer struct {
	t           *testing.T
	sse         bool
	version     string
	token       string // required bearer, "" = none
	expireOnce  atomic.Bool
	sessions    atomic.Int32
	cancelled   atomic.Value // string
	slowCall    chan struct{}
	mu          sync.Mutex
	sawVersions []string
}

func (f *fakeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if f.token != "" && r.Header.Get("Authorization") != "Bearer "+f.token {
		w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="http://`+r.Host+`/.well-known/oauth-protected-resource/mcp", scope="tools"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if r.Method == http.MethodDelete {
		w.WriteHeader(http.StatusOK)
		return
	}
	var m rpcMessage
	_ = json.NewDecoder(r.Body).Decode(&m)
	sid := r.Header.Get("Mcp-Session-Id")
	f.mu.Lock()
	f.sawVersions = append(f.sawVersions, m.Method+"="+r.Header.Get("MCP-Protocol-Version"))
	f.mu.Unlock()
	if m.Method != "initialize" && sid == "" {
		http.Error(w, "missing session", http.StatusBadRequest)
		return
	}
	if m.Method != "initialize" && m.ID != nil && f.expireOnce.CompareAndSwap(true, false) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if m.ID == nil { // notification
		if m.Method == "notifications/cancelled" {
			p, _ := json.Marshal(m.Params)
			f.cancelled.Store(string(p))
		}
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	switch m.Method {
	case "initialize":
		n := f.sessions.Add(1)
		w.Header().Set("Mcp-Session-Id", fmt.Sprintf("s-%d", n))
		v := f.version
		if v == "" {
			v = ProtocolVersion
		}
		result = map[string]any{"protocolVersion": v, "capabilities": map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]any{"name": "fake", "version": "0"}}
	case "tools/list":
		p, _ := m.Params.(map[string]any)
		if p["cursor"] == nil {
			result = map[string]any{"tools": []any{map[string]any{"name": "echo", "inputSchema": map[string]any{"type": "object"}}}, "nextCursor": "p2"}
		} else {
			result = map[string]any{"tools": []any{map[string]any{"name": "add", "inputSchema": map[string]any{"type": "object"}}}}
		}
	case "tools/call":
		if f.slowCall != nil {
			<-f.slowCall
			return
		}
		p, _ := m.Params.(map[string]any)
		args, _ := p["arguments"].(map[string]any)
		result = map[string]any{"content": []any{map[string]any{"type": "text", "text": fmt.Sprint(args["text"])}}}
	default:
		result = nil
	}
	resp := map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result}
	b, _ := json.Marshal(resp)
	if f.sse {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}\n\n")
		fmt.Fprintf(w, "event: message\ndata: %s\n\n", b)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
}

var devPolicy = DialPolicy{AllowLoopback: true, AllowPrivate: true}

func newClient(url string, tok string) *Client {
	t := &HTTPTransport{URL: url, HTTP: devPolicy.NewHTTPClient(5 * time.Second)}
	if tok != "" {
		t.Token = func(context.Context) (string, error) { return tok, nil }
	}
	return &Client{T: t}
}

func TestHTTPListAndCall_JSONAndSSE(t *testing.T) {
	for _, sse := range []bool{false, true} {
		f := &fakeServer{t: t, sse: sse}
		srv := httptest.NewServer(f)
		c := newClient(srv.URL, "")
		tools, err := c.ListTools(context.Background())
		if err != nil || len(tools) != 2 || tools[1].Name != "add" {
			t.Fatalf("sse=%v list: %v %+v", sse, err, tools)
		}
		res, err := c.CallTool(context.Background(), "echo", map[string]any{"text": "hi"})
		if err != nil || res.Content[0].Text != "hi" {
			t.Fatalf("sse=%v call: %v %+v", sse, err, res)
		}
		// Protocol-version header on every post-initialize request, never on initialize.
		for _, s := range f.sawVersions {
			if strings.HasPrefix(s, "initialize=") != (s == "initialize=") {
				t.Fatalf("bad version header %q", s)
			}
			if !strings.HasPrefix(s, "initialize") && !strings.HasSuffix(s, "="+ProtocolVersion) {
				t.Fatalf("missing MCP-Protocol-Version on %q", s)
			}
		}
		_ = c.T.Close(context.Background())
		srv.Close()
	}
}

func TestHTTPSessionExpiryReinitializes(t *testing.T) {
	f := &fakeServer{t: t}
	srv := httptest.NewServer(f)
	defer srv.Close()
	c := newClient(srv.URL, "")
	if _, err := c.ListTools(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.expireOnce.Store(true)
	if _, err := c.CallTool(context.Background(), "echo", nil); err != nil {
		t.Fatalf("expected transparent re-init, got %v", err)
	}
	if f.sessions.Load() != 2 {
		t.Fatalf("want 2 sessions, got %d", f.sessions.Load())
	}
}

func TestHTTPUnsupportedVersionRefused(t *testing.T) {
	srv := httptest.NewServer(&fakeServer{t: t, version: "2099-01-01"})
	defer srv.Close()
	if _, err := newClient(srv.URL, "").ListTools(context.Background()); !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("want ErrUnsupportedVersion, got %v", err)
	}
}

func TestHTTP401SurfacesResourceMetadata(t *testing.T) {
	srv := httptest.NewServer(&fakeServer{t: t, token: "good"})
	defer srv.Close()
	_, err := newClient(srv.URL, "bad").ListTools(context.Background())
	var ae *AuthRequiredError
	if !errors.As(err, &ae) || ae.Status != 401 || !strings.HasSuffix(ae.ResourceMetadata, "/.well-known/oauth-protected-resource/mcp") || ae.Scope != "tools" {
		t.Fatalf("got %v %+v", err, ae)
	}
	if _, err := newClient(srv.URL, "good").ListTools(context.Background()); err != nil {
		t.Fatalf("good token: %v", err)
	}
}

func TestHTTPCancellationSendsNotification(t *testing.T) {
	f := &fakeServer{t: t, slowCall: make(chan struct{})}
	srv := httptest.NewServer(f)
	defer srv.Close()
	defer close(f.slowCall)
	c := newClient(srv.URL, "")
	if _, err := c.ListTools(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, err := c.CallTool(ctx, "echo", nil); err == nil {
		t.Fatal("expected timeout")
	}
	got, _ := f.cancelled.Load().(string)
	if !strings.Contains(got, `"requestId"`) {
		t.Fatalf("no notifications/cancelled seen: %q", got)
	}
}

func TestHTTPResponseCap(t *testing.T) {
	big := strings.Repeat("x", 2048)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m rpcMessage
		_ = json.NewDecoder(r.Body).Decode(&m)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"pad":"%s"}}`, m.ID, big)
	}))
	defer srv.Close()
	tr := &HTTPTransport{URL: srv.URL, HTTP: devPolicy.NewHTTPClient(5 * time.Second), MaxResponseBytes: 1024}
	if _, err := (&Client{T: tr}).ListTools(context.Background()); !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("want ErrResponseTooLarge, got %v", err)
	}
}

func TestHTTPResponseIDMismatchRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":999,"result":{}}`)
	}))
	defer srv.Close()
	if _, err := newClient(srv.URL, "").ListTools(context.Background()); err == nil || !strings.Contains(err.Error(), "id does not match") {
		t.Fatalf("got %v", err)
	}
}

func TestDialPolicy(t *testing.T) {
	strict := DialPolicy{RequireHTTPS: true}
	for _, ip := range []string{"169.254.169.254", "127.0.0.1", "10.0.0.1", "100.64.1.1", "::1", "fe80::1", "0.0.0.0", "fd00::1"} {
		if strict.Allowed(net.ParseIP(ip)) {
			t.Errorf("strict policy allowed %s", ip)
		}
	}
	if !strict.Allowed(net.ParseIP("93.184.216.34")) {
		t.Error("public IP refused")
	}
	if devPolicy.Allowed(net.ParseIP("169.254.169.254")) {
		t.Error("metadata address must be refused even in dev")
	}
	for _, u := range []string{"http://example.com/mcp", "https://user:pw@example.com/", "https://example.com/#x", "ftp://example.com", "https://169.254.169.254/"} {
		if _, err := strict.CheckURL(u); err == nil {
			t.Errorf("CheckURL accepted %q", u)
		}
	}
	// Dial-time check: a loopback server is unreachable under the strict policy.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()
	_, err := DialPolicy{}.NewHTTPClient(time.Second).Get(srv.URL)
	if err == nil || !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("loopback dial not blocked: %v", err)
	}
}

func TestParseWWWAuthenticate(t *testing.T) {
	p := ParseWWWAuthenticate(`Bearer error="insufficient_scope", scope="a b", resource_metadata="https://x/.well-known/oauth-protected-resource"`)
	if p["error"] != "insufficient_scope" || p["scope"] != "a b" || p["resource_metadata"] != "https://x/.well-known/oauth-protected-resource" {
		t.Fatalf("%v", p)
	}
	if len(ParseWWWAuthenticate(`Basic realm="x"`)) != 0 {
		t.Fatal("non-bearer parsed")
	}
}

func TestCanonicalResource(t *testing.T) {
	for in, want := range map[string]string{
		"HTTPS://MCP.Example.com/mcp/": "https://mcp.example.com/mcp",
		"https://mcp.example.com#frag": "https://mcp.example.com",
		"https://mcp.example.com:8443": "https://mcp.example.com:8443",
	} {
		if got, err := CanonicalResource(in); err != nil || got != want {
			t.Errorf("%s → %s (%v), want %s", in, got, err, want)
		}
	}
}

// oauthFixture is a resource server + authorization server pair.
func oauthFixture(t *testing.T, badIssuer, crossOriginPRM bool) (*httptest.Server, *[]string) {
	var seen []string
	mux := http.NewServeMux()
	var base string
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, _ *http.Request) {
		res := base + "/mcp"
		if crossOriginPRM {
			res = "https://other.example/mcp"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"resource": res, "authorization_servers": []string{base + "/as"}})
	})
	mux.HandleFunc("/.well-known/oauth-authorization-server/as", func(w http.ResponseWriter, _ *http.Request) {
		iss := base + "/as"
		if badIssuer {
			iss = "https://evil.example"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": iss, "authorization_endpoint": base + "/as/authorize",
			"token_endpoint": base + "/as/token", "registration_endpoint": base + "/as/register", "code_challenge_methods_supported": []string{"S256"}})
	})
	mux.HandleFunc("/as/register", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"client_id": "cid"})
	})
	mux.HandleFunc("/as/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		seen = append(seen, r.Form.Encode())
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "refresh_token": "rt", "expires_in": 60})
	})
	srv := httptest.NewServer(mux)
	base = srv.URL
	return srv, &seen
}

func TestOAuthDiscoveryAndExchange(t *testing.T) {
	srv, seen := oauthFixture(t, false, false)
	defer srv.Close()
	hc := devPolicy.NewHTTPClient(5 * time.Second)
	ctx := context.Background()
	prm, err := DiscoverResource(ctx, hc, devPolicy, srv.URL+"/mcp", "")
	if err != nil {
		t.Fatal(err)
	}
	as, err := DiscoverAuthServer(ctx, hc, devPolicy, prm.AuthorizationServers[0])
	if err != nil {
		t.Fatal(err)
	}
	cid, _, err := RegisterClient(ctx, hc, as, "https://pal.example/cb")
	if err != nil || cid != "cid" {
		t.Fatal(cid, err)
	}
	v, ch, _ := NewPKCE()
	resource, _ := CanonicalResource(srv.URL + "/mcp")
	u := AuthorizeURL(as, cid, "https://pal.example/cb", "st", ch, resource, "")
	for _, want := range []string{"code_challenge_method=S256", "resource=" + strings.ReplaceAll(strings.ReplaceAll(resource, ":", "%3A"), "/", "%2F"), "state=st"} {
		if !strings.Contains(u, want) {
			t.Fatalf("authorize URL %q missing %q", u, want)
		}
	}
	tok, err := ExchangeCode(ctx, hc, as, cid, "", "code", v, "https://pal.example/cb", resource)
	if err != nil || tok.AccessToken != "at" {
		t.Fatal(err)
	}
	if !strings.Contains((*seen)[0], "code_verifier="+v) || !strings.Contains((*seen)[0], "resource=") {
		t.Fatalf("token request missing PKCE/resource: %s", (*seen)[0])
	}
	if _, err := Refresh(ctx, hc, as, cid, "", "rt", resource); err != nil || !strings.Contains((*seen)[1], "resource=") {
		t.Fatalf("refresh: %v %v", err, *seen)
	}
}

func TestOAuthRejectsIssuerMismatchAndForeignResource(t *testing.T) {
	ctx := context.Background()
	hc := devPolicy.NewHTTPClient(5 * time.Second)
	srv, _ := oauthFixture(t, true, false)
	prm, err := DiscoverResource(ctx, hc, devPolicy, srv.URL+"/mcp", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DiscoverAuthServer(ctx, hc, devPolicy, prm.AuthorizationServers[0]); err == nil {
		t.Fatal("issuer mismatch accepted")
	}
	srv.Close()
	srv2, _ := oauthFixture(t, false, true)
	defer srv2.Close()
	if _, err := DiscoverResource(ctx, hc, devPolicy, srv2.URL+"/mcp", ""); err == nil {
		t.Fatal("foreign resource accepted")
	}
	if _, err := DiscoverResource(ctx, hc, devPolicy, srv2.URL+"/mcp", "https://elsewhere.example/prm"); err == nil {
		t.Fatal("cross-origin resource_metadata hint accepted")
	}
}

// ---------- stdio ----------

// fakeVM emulates the exec: decodes $1, runs a scripted server that answers
// each request line, streaming stdout in small chunks.
func fakeVM(t *testing.T, answer func(m rpcMessage) []string) ExecFunc {
	return func(ctx context.Context, command string, argv []string, onStdout func([]byte) error) error {
		if command != "/bin/sh" || argv[0] != "-c" || argv[1] != stdioScript || argv[4] != "npx server" {
			t.Fatalf("unexpected exec %s %q", command, argv)
		}
		in, err := base64.StdEncoding.DecodeString(argv[3])
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(strings.TrimSpace(string(in)), "\n") {
			var m rpcMessage
			_ = json.Unmarshal([]byte(line), &m)
			for _, out := range answer(m) {
				for _, chunk := range []string{out[:len(out)/2], out[len(out)/2:] + "\n"} {
					if err := onStdout([]byte(chunk)); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}
}

func TestStdioCall(t *testing.T) {
	tr := &StdioTransport{Command: "npx server", Exec: fakeVM(t, func(m rpcMessage) []string {
		switch m.Method {
		case "initialize":
			return []string{"not json: server banner", fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}}}}`, m.ID)}
		case "tools/call":
			return []string{fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"ok"}]}}`, m.ID)}
		}
		return nil
	})}
	res, err := (&Client{T: tr}).CallTool(context.Background(), "x", nil)
	if err != nil || res.Content[0].Text != "ok" {
		t.Fatal(err, res)
	}
}

func TestStdioRequiresVMAndCapsOutput(t *testing.T) {
	if _, err := (&StdioTransport{Command: "x"}).Call(context.Background(), "tools/list", nil); err == nil {
		t.Fatal("stdio without a VM must refuse")
	}
	tr := &StdioTransport{Command: "npx server", MaxResponseBytes: 64, Exec: fakeVM(t, func(m rpcMessage) []string {
		return []string{strings.Repeat("y", 200)}
	})}
	if _, err := tr.Call(context.Background(), "tools/list", nil); !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("want cap error, got %v", err)
	}
	_ = io.EOF
}
