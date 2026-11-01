package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/dshakes/pal/services/control-plane/internal/connectorreplay"
	"github.com/dshakes/pal/services/control-plane/internal/mcp"
)

const replayToken = "tok-secret-do-not-leak"

// replayEnv starts the replay server and points every overridable connector at it.
func replayEnv(t *testing.T) *connectorreplay.Server {
	t.Helper()
	t.Setenv("PAL_ENV", "")
	rs, err := connectorreplay.New()
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(rs)
	t.Cleanup(ts.Close)
	for _, name := range connectorHosts {
		t.Setenv(connectorBaseURLPrefix+name, ts.URL)
	}
	return rs
}

func TestCheckConnectorBaseURLOverrides(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	tests := []struct {
		name      string
		prod      bool
		env       map[string]string
		wantFatal bool
		wantMsg   string
	}{
		{"prod unset", true, nil, false, ""},
		{"prod set", true, map[string]string{"PAL_CONNECTOR_BASEURL_SLACK": "http://127.0.0.1:1"}, true, "PAL_CONNECTOR_BASEURL_SLACK"},
		{"dev unset", false, nil, false, ""},
		{"dev valid", false, map[string]string{"PAL_CONNECTOR_BASEURL_GITHUB": "http://127.0.0.1:1"}, false, ""},
		{"dev malformed", false, map[string]string{"PAL_CONNECTOR_BASEURL_GITHUB": "not-a-url"}, true, "malformed"},
		{"dev non-http scheme", false, map[string]string{"PAL_CONNECTOR_BASEURL_GITHUB": "file:///etc"}, true, "malformed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fatal, msg := CheckConnectorBaseURLOverrides(tc.prod, env(tc.env))
			if fatal != tc.wantFatal || !strings.Contains(msg, tc.wantMsg) {
				t.Fatalf("fatal=%v msg=%q, want fatal=%v containing %q", fatal, msg, tc.wantFatal, tc.wantMsg)
			}
		})
	}
}

type captureRT struct{ host string }

func (c *captureRT) RoundTrip(r *http.Request) (*http.Response, error) {
	c.host = r.URL.Host
	return &http.Response{StatusCode: 200, Body: http.NoBody, Header: http.Header{}}, nil
}

func TestBaseURLTransport_IgnoredInProd(t *testing.T) {
	t.Setenv("PAL_CONNECTOR_BASEURL_SLACK", "http://127.0.0.1:1")
	for env, want := range map[string]string{"production": "slack.com", "": "127.0.0.1:1"} {
		t.Run("env="+env, func(t *testing.T) {
			t.Setenv("PAL_ENV", env)
			c := &captureRT{}
			req, _ := http.NewRequest("GET", "https://slack.com/api/x", nil)
			if _, err := (baseURLTransport{next: c}).RoundTrip(req); err != nil {
				t.Fatal(err)
			}
			if c.host != want {
				t.Fatalf("host=%q want %q", c.host, want)
			}
			if req.URL.Host != "slack.com" {
				t.Fatal("original request was mutated")
			}
		})
	}
}

func TestConnectorActionsAgainstReplay(t *testing.T) {
	rs := replayEnv(t)
	tokCfg := func(field string) map[string]any { return map[string]any{field: replayToken} }

	tests := []struct {
		name     string
		run      func() (any, error)
		wantPath string
		wantBody map[string]any // subset of the outbound JSON body
		wantOut  string         // substring of the JSON result
	}{
		{"slack reply_thread", func() (any, error) {
			return executeSlack(tokCfg("botToken"), "reply_thread", map[string]any{"channel": "C0123", "text": "hi", "thread_ts": "1700000000.000100"})
		}, "/api/chat.postMessage", map[string]any{"channel": "C0123", "thread_ts": "1700000000.000100"}, `"ts":"1700000001.000200"`},
		{"slack post_message no thread", func() (any, error) {
			return executeSlack(tokCfg("botToken"), "post_message", map[string]any{"channel": "C0123", "text": "hi"})
		}, "/api/chat.postMessage", map[string]any{"text": "hi"}, `"ok":true`},
		{"github comment_pr", func() (any, error) {
			return executeGitHub(tokCfg("personalAccessToken"), "comment_pr", map[string]any{"owner": "acme", "repo": "api", "number": float64(42), "body": "LGTM"})
		}, "/repos/acme/api/issues/42/comments", map[string]any{"body": "LGTM"}, `"id":9001`},
		{"sentry get_issue", func() (any, error) {
			return executeSentry(tokCfg("authToken"), "get_issue", map[string]any{"organization": "acme", "issue_id": "1001"})
		}, "/api/0/organizations/acme/issues/1001/", nil, `"lastSeen"`},
		{"pagerduty list_incidents", func() (any, error) {
			return executePagerDuty(tokCfg("apiKey"), "list_incidents", map[string]any{"status": "triggered"})
		}, "/incidents", nil, `"PABC123"`},
		{"pagerduty get_incident", func() (any, error) {
			return executePagerDuty(tokCfg("apiKey"), "get_incident", map[string]any{"incident_id": "PABC123"})
		}, "/incidents/PABC123", nil, `"urgency":"high"`},
		{"pagerduty create_incident", func() (any, error) {
			return executePagerDuty(tokCfg("apiKey"), "create_incident", map[string]any{"title": "boom", "service_id": "PSVC1", "from": "oncall@acme.test", "details": "d"})
		}, "/incidents", map[string]any{"incident": map[string]any{"title": "boom", "type": "incident"}}, `"PNEW456"`},
		{"pagerduty update_incident", func() (any, error) {
			return executePagerDuty(tokCfg("apiKey"), "update_incident", map[string]any{"incident_id": "PABC123", "status": "acknowledged", "from": "oncall@acme.test"})
		}, "/incidents/PABC123", map[string]any{"incident": map[string]any{"status": "acknowledged"}}, `"acknowledged"`},
		{"pagerduty add_note", func() (any, error) {
			return executePagerDuty(tokCfg("apiKey"), "add_note", map[string]any{"incident_id": "PABC123", "content": "rollback approved", "from": "oncall@acme.test"})
		}, "/incidents/PABC123/notes", map[string]any{"note": map[string]any{"content": "rollback approved"}}, `"PNOTE1"`},
		{"gcal create_event", func() (any, error) {
			return executeGoogleCalendar(tokCfg("accessToken"), "create_event", map[string]any{
				"summary": "Sync", "start": "2026-11-02T15:00:00-08:00", "end": "2026-11-02T15:30:00-08:00",
				"timeZone": "America/Los_Angeles", "attendees": []any{"a@acme.test"}})
		}, "/calendar/v3/calendars/primary/events", map[string]any{"summary": "Sync"}, `"evt2"`},
	}
	for i, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out, err := tc.run()
			if err != nil {
				t.Fatal(err)
			}
			if b, _ := json.Marshal(out); !strings.Contains(string(b), tc.wantOut) {
				t.Fatalf("result %s missing %s", b, tc.wantOut)
			}
			reqs := rs.Requests()
			if len(reqs) != i+1 {
				t.Fatalf("recorded %d requests, want %d", len(reqs), i+1)
			}
			got := reqs[i]
			if got.Path != tc.wantPath || !got.Matched || !got.HasAuth {
				t.Fatalf("recorded %+v, want matched authed %s", got, tc.wantPath)
			}
			if got.Header.Get("Authorization") != "" || strings.Contains(got.Body, replayToken) {
				t.Fatal("token leaked into recorded request")
			}
			if tc.wantBody != nil {
				var body map[string]any
				if err := json.Unmarshal([]byte(got.Body), &body); err != nil {
					t.Fatalf("body not JSON: %v", err)
				}
				assertSubset(t, tc.wantBody, body)
			}
		})
	}
}

func assertSubset(t *testing.T, want, got map[string]any) {
	t.Helper()
	for k, w := range want {
		if wm, ok := w.(map[string]any); ok {
			gm, _ := got[k].(map[string]any)
			assertSubset(t, wm, gm)
		} else if got[k] != w {
			t.Fatalf("body[%q]=%v want %v", k, got[k], w)
		}
	}
}

func TestSlackThreadTSOmittedWhenEmpty(t *testing.T) {
	rs := replayEnv(t)
	if _, err := executeSlack(map[string]any{"botToken": replayToken}, "post_message", map[string]any{"channel": "C1", "text": "x"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rs.Requests()[0].Body, "thread_ts") {
		t.Fatal("thread_ts must be omitted for a plain post")
	}
}

func TestConnectorActionErrors(t *testing.T) {
	replayEnv(t)
	cfg := map[string]any{"token": replayToken}
	tests := []struct {
		name string
		run  func() (any, error)
		want string
	}{
		{"slack reply_thread missing thread_ts", func() (any, error) {
			return executeSlack(cfg, "reply_thread", map[string]any{"channel": "C", "text": "t"})
		}, "'thread_ts'"},
		{"github comment_pr missing body", func() (any, error) {
			return executeGitHub(cfg, "comment_pr", map[string]any{"owner": "a", "repo": "b", "number": "1"})
		}, "'body'"},
		{"github comment_pr unrecorded repo", func() (any, error) {
			return executeGitHub(cfg, "comment_pr", map[string]any{"owner": "x", "repo": "y", "number": "1", "body": "b"})
		}, "404"},
		{"sentry get_issue missing id", func() (any, error) {
			return executeSentry(cfg, "get_issue", map[string]any{"organization": "acme"})
		}, "'issue_id'"},
		{"gcal create_event missing end", func() (any, error) {
			return executeGoogleCalendar(cfg, "create_event", map[string]any{"summary": "s", "start": "x"})
		}, "'end'"},
		{"pagerduty create_incident missing from", func() (any, error) {
			return executePagerDuty(cfg, "create_incident", map[string]any{"title": "t", "service_id": "s"})
		}, "'from'"},
		{"pagerduty update_incident bad status", func() (any, error) {
			return executePagerDuty(cfg, "update_incident", map[string]any{"incident_id": "P", "from": "a@b.c", "status": "deleted"})
		}, "acknowledged|resolved"},
		{"pagerduty unknown action", func() (any, error) { return executePagerDuty(cfg, "nope", nil) }, "unknown PagerDuty action"},
		{"pagerduty no token", func() (any, error) { return executePagerDuty(map[string]any{}, "list_incidents", nil) }, "PagerDuty"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.run()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err=%v, want containing %q", err, tc.want)
			}
			if strings.Contains(err.Error(), replayToken) {
				t.Fatal("token leaked into error")
			}
		})
	}
}

// Regression: a workflow `connector` node dispatches in-process via
// dispatchConnectorInProc, which once lacked sentry/pagerduty ("dispatch not
// yet wired") even though the REST execute path served them.
func TestDispatchConnectorInProc_SentryPagerDuty(t *testing.T) {
	pool := openTestPool(t)
	replayEnv(t)
	ctx := context.Background()
	const tenant = "00000000-0000-0000-0000-000000000001" // seeded dev tenant
	for id, field := range map[string]string{"sentry": "authToken", "pagerduty": "apiKey"} {
		cfg, _ := json.Marshal(map[string]string{field: replayToken})
		if _, err := pool.Exec(ctx, `
			INSERT INTO connector_installs (tenant_id, connector_id, display_name, status, config)
			VALUES ($1, $2, 'dispatch test', 'connected', $3::jsonb)
			ON CONFLICT (tenant_id, connector_id) DO UPDATE SET status='connected', config=EXCLUDED.config`,
			tenant, id, string(cfg)); err != nil {
			t.Fatalf("seed %s install: %v", id, err)
		}
		id := id
		t.Cleanup(func() {
			_, _ = pool.Exec(ctx, `DELETE FROM connector_installs WHERE tenant_id=$1 AND connector_id=$2 AND display_name='dispatch test'`, tenant, id)
		})
	}
	out, err := dispatchConnectorInProc(ctx, pool, tenant, "sentry", "get_issue", map[string]any{"organization": "acme", "issue_id": "1001"})
	if err != nil || !strings.Contains(fmt.Sprint(out), "lastSeen") {
		t.Fatalf("sentry: %v %v", out, err)
	}
	out, err = dispatchConnectorInProc(ctx, pool, tenant, "pagerduty", "add_note", map[string]any{"incident_id": "PABC123", "content": "x", "from": "a@b.test"})
	if err != nil || !strings.Contains(fmt.Sprint(out), "PNOTE1") {
		t.Fatalf("pagerduty: %v %v", out, err)
	}
}

// ---------- S-9: connector SSRF guard ----------

func TestVendorURL(t *testing.T) {
	jira := []string{"atlassian.net"}
	sf := []string{"salesforce.com", "force.com"}
	cases := []struct {
		raw     string
		allowed []string
		want    string // "" = rejected
	}{
		{"acme.atlassian.net", jira, "https://acme.atlassian.net"},
		{"https://ACME.atlassian.net/", jira, "https://acme.atlassian.net"},
		{"169.254.169.254", jira, ""},
		{"127.0.0.1", jira, ""},
		{"10.0.0.5", jira, ""},
		{"[::1]", jira, ""},
		{"localhost", jira, ""},
		{"evil.com", jira, ""},
		{"acme.atlassian.net.evil.com", jira, ""},
		{"evilatlassian.net", jira, ""},
		{"acme.atlassian.net@169.254.169.254", jira, ""},
		{"evil.com#.atlassian.net", jira, ""},
		{"evil.com/.atlassian.net", jira, ""},
		{"acme.atlassian.net:8443", jira, ""},
		{"http://acme.atlassian.net", jira, ""},
		{"https://acme.my.salesforce.com", sf, "https://acme.my.salesforce.com"},
		{"https://acme--dev.sandbox.my.salesforce.com", sf, "https://acme--dev.sandbox.my.salesforce.com"},
		{"https://test.salesforce.com", sf, "https://test.salesforce.com"},
		{"https://acme.lightning.force.com", sf, "https://acme.lightning.force.com"},
		{"https://169.254.169.254", sf, ""},
		{"http://acme.my.salesforce.com", sf, ""},
		{"https://acme.my.salesforce.com/services", sf, ""},
		{"https://metadata.google.internal", sf, ""},
		{"https://salesforce.com.evil.com", sf, ""},
	}
	for _, tc := range cases {
		got, err := vendorURL(tc.raw, tc.allowed...)
		if tc.want == "" {
			if err == nil {
				t.Errorf("vendorURL(%q) = %q, want rejection", tc.raw, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("vendorURL(%q) = %q, %v; want %q", tc.raw, got, err, tc.want)
		}
	}
}

// TestConnectorExecutors_RejectInternalHosts drives the two tenant-configured
// hosts end to end: neither may produce a request to an internal address.
func TestConnectorExecutors_RejectInternalHosts(t *testing.T) {
	if _, err := executeJira(map[string]any{"domain": "169.254.169.254", "accessToken": "t"}, "list_issues", nil); err == nil ||
		!strings.Contains(err.Error(), "invalid 'Domain'") {
		t.Fatalf("jira metadata domain: err = %v, want invalid-domain rejection", err)
	}
	if _, err := executeSalesforce(map[string]any{"instanceUrl": "http://10.0.0.5", "accessToken": "t"}, "query", map[string]any{"q": "SELECT Id FROM Account"}); err == nil ||
		!strings.Contains(err.Error(), "invalid instance URL") {
		t.Fatalf("salesforce private instance: err = %v, want invalid-instance rejection", err)
	}
}

func TestConnectorClient_DialGuard(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{}`) }))
	defer ok.Close()
	toMeta := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer toMeta.Close()

	get := func(ctx context.Context, u string) error {
		httpClient.CloseIdleConnections() // every case must dial, not reuse a pooled conn
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		resp, err := httpClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		return err
	}
	fixture := context.WithValue(context.Background(), fixtureDialKey{}, true)

	t.Run("loopback blocked by default", func(t *testing.T) {
		t.Setenv("PAL_ENV", "")
		t.Setenv("PAL_CONNECTOR_ALLOW_PRIVATE", "")
		if err := get(context.Background(), ok.URL); !errors.Is(err, mcp.ErrBlockedAddress) {
			t.Fatalf("err = %v, want ErrBlockedAddress", err)
		}
	})
	t.Run("metadata and private blocked", func(t *testing.T) {
		t.Setenv("PAL_ENV", "")
		for _, u := range []string{"http://169.254.169.254/latest/meta-data/", "http://10.255.255.1/", "http://[fe80::1]/", "http://100.64.0.1/"} {
			if err := get(context.Background(), u); !errors.Is(err, mcp.ErrBlockedAddress) {
				t.Errorf("%s: err = %v, want ErrBlockedAddress", u, err)
			}
		}
	})
	t.Run("redirect to metadata blocked even from an allowed host", func(t *testing.T) {
		t.Setenv("PAL_ENV", "")
		if err := get(fixture, toMeta.URL); !errors.Is(err, mcp.ErrBlockedAddress) {
			t.Fatalf("err = %v, want ErrBlockedAddress", err)
		}
	})
	t.Run("dev flag allows loopback", func(t *testing.T) {
		t.Setenv("PAL_ENV", "")
		t.Setenv("PAL_CONNECTOR_ALLOW_PRIVATE", "1")
		if err := get(context.Background(), ok.URL); err != nil {
			t.Fatalf("dev flag: %v", err)
		}
	})
	t.Run("prod ignores dev flag and fixture marker", func(t *testing.T) {
		t.Setenv("PAL_ENV", "production")
		t.Setenv("PAL_CONNECTOR_ALLOW_PRIVATE", "1")
		if err := get(fixture, ok.URL); !errors.Is(err, mcp.ErrBlockedAddress) {
			t.Fatalf("prod: err = %v, want ErrBlockedAddress", err)
		}
	})
}

// TestNoTimeoutlessDefaultClient pins S-16: the OAuth / captcha / Gmail /
// connector paths must use a client with a timeout, never http.DefaultClient
// (no timeout) or the http.Get/Post helpers built on it.
func TestNoTimeoutlessDefaultClient(t *testing.T) {
	if outboundHTTPClient.Timeout <= 0 || httpClient.Timeout <= 0 {
		t.Fatal("shared outbound clients must carry a timeout")
	}
	for _, f := range []string{"auth.go", "auth_lifecycle.go", "connectors.go", "connector_executor.go", "rest.go", "gmail.go"} {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, bad := range []string{"http.DefaultClient", "http.Get(", "http.Post(", "http.PostForm("} {
			if strings.Contains(string(src), bad) {
				t.Errorf("%s uses %s; use outboundHTTPClient (or the connector httpClient)", f, bad)
			}
		}
	}
}
