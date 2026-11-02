package handlers

// Test-mode base-URL override for connector HTTP calls.
//
// PAL_CONNECTOR_BASEURL_<NAME>=http://127.0.0.1:PORT re-points every outbound
// request a connector would send to that vendor's host at a recorded-fixture
// server (e2e/connectorreplay), so examples and tests run without a real SaaS
// account. Only scheme+host are replaced; the vendor path is preserved, so the
// replay server serves the vendor's real paths (/api/chat.postMessage, ...).
//
// It is dev/test only: IsProd() ignores overrides at request time and
// CheckConnectorBaseURLOverrides makes the control-plane refuse to boot with one
// set (a prod tenant's bearer token must never be sent to an arbitrary host).

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/dshakes/pal/services/control-plane/internal/mcp"
)

// connectorHosts maps a vendor API host to its override name.
var connectorHosts = map[string]string{
	"slack.com":          "SLACK",
	"api.github.com":     "GITHUB",
	"sentry.io":          "SENTRY",
	"www.googleapis.com": "GOOGLE",
	"api.pagerduty.com":  "PAGERDUTY",
}

const connectorBaseURLPrefix = "PAL_CONNECTOR_BASEURL_"

// parseConnectorBaseURL validates an override value: absolute http(s) URL with a host.
func parseConnectorBaseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("must be an absolute http(s) URL, got %q", raw)
	}
	return u, nil
}

// CheckConnectorBaseURLOverrides is the startup guard: fatal in prod when any
// override env var is set, and in every environment when a value is malformed.
func CheckConnectorBaseURLOverrides(isProdEnv bool, getenv func(string) string) (fatal bool, message string) {
	var set []string
	for _, name := range connectorHosts {
		key := connectorBaseURLPrefix + name
		raw := getenv(key)
		if raw == "" {
			continue
		}
		if isProdEnv {
			set = append(set, key)
			continue
		}
		if _, err := parseConnectorBaseURL(raw); err != nil {
			return true, fmt.Sprintf("%s is malformed: %v", key, err)
		}
	}
	if len(set) > 0 {
		sort.Strings(set)
		return true, fmt.Sprintf("%s set in production — connector base-URL overrides are test-only and would redirect tenant credentials to another host; unset them", strings.Join(set, ", "))
	}
	return false, ""
}

// baseURLTransport rewrites requests to known vendor hosts when an override is set.
type baseURLTransport struct{ next http.RoundTripper }

func (t baseURLTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if name, ok := connectorHosts[req.URL.Host]; ok && !IsProd() {
		if raw := os.Getenv(connectorBaseURLPrefix + name); raw != "" {
			if base, err := parseConnectorBaseURL(raw); err == nil {
				// The fixture server is the operator's own dev host (usually
				// loopback): exempt this request from the SSRF dial guard.
				r := req.Clone(context.WithValue(req.Context(), fixtureDialKey{}, true))
				r.URL.Scheme, r.URL.Host, r.Host = base.Scheme, base.Host, ""
				req = r
			}
		}
	}
	return t.next.RoundTrip(req)
}

// ---------- SSRF dial guard (S-9) ----------

// fixtureDialKey marks a request re-pointed at a dev fixture server.
type fixtureDialKey struct{}

// connectorDialPolicy decides which IPs a connector request may reach. Cloud
// metadata / link-local, loopback and private ranges are refused: connector
// config (a Jira domain, a Salesforce instance URL) is tenant input and the
// response is returned to the caller, so an internal address would be a
// read-SSRF. Dev only: PAL_CONNECTOR_ALLOW_PRIVATE=1 or a base-URL fixture
// override lifts the private/loopback block; both are ignored in prod.
func connectorDialPolicy(ctx context.Context) mcp.DialPolicy {
	if IsProd() {
		return mcp.DialPolicy{}
	}
	if ctx.Value(fixtureDialKey{}) != nil || envOn("PAL_CONNECTOR_ALLOW_PRIVATE") {
		return mcp.DialPolicy{AllowPrivate: true, AllowLoopback: true}
	}
	return mcp.DialPolicy{}
}

// connectorNetDialer checks the RESOLVED address at connect time, so DNS
// rebinding and redirects to an internal host are caught too.
var connectorNetDialer = &net.Dialer{
	Timeout:   10 * time.Second,
	KeepAlive: 30 * time.Second,
	ControlContext: func(ctx context.Context, _, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return fmt.Errorf("connector dial %q: %w", address, err)
		}
		if !connectorDialPolicy(ctx).Allowed(net.ParseIP(host)) {
			return fmt.Errorf("connector dial %s: %w", host, mcp.ErrBlockedAddress)
		}
		return nil
	},
}

// newConnectorTransport builds a fresh transport (never derived from
// http.DefaultTransport, which llm_baseurl.go wraps at init) with the dial
// guard, explicit timeouts and no proxy (a proxy would hide the real
// destination from the guard).
func newConnectorTransport() http.RoundTripper {
	return baseURLTransport{next: &http.Transport{
		Proxy:                 nil,
		DialContext:           connectorNetDialer.DialContext,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
	}}
}

// vendorURL validates a tenant-configured vendor origin: https, no userinfo,
// port, path, query or fragment, and a host equal to or under one of the
// allowed domains. A bare host ("acme.atlassian.net") is accepted.
func vendorURL(raw string, allowed ...string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" ||
		u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", fmt.Errorf("must be an https origin like https://%s", "acme."+allowed[0])
	}
	host := strings.ToLower(u.Hostname())
	for _, d := range allowed {
		if host == d || strings.HasSuffix(host, "."+d) {
			return "https://" + host, nil
		}
	}
	return "", fmt.Errorf("host %q is not under %s", host, strings.Join(allowed, ", "))
}
