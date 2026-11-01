package handlers

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/dshakes/pal/services/control-plane/internal/db"
)

var evRefRe = regexp.MustCompile(`\[ev:[0-9]+\]|\[evidence:truncated\]`)

// mintScopedKey is an API-key principal (role "service") holding exactly scopes.
func mintScopedKey(t *testing.T, tenantID string, scopes ...string) string {
	t.Helper()
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, PalClaims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "key-" + uuid.NewString()[:6], IssuedAt: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)), Issuer: "pal-test"},
		TenantID: tenantID, Role: "service", Scopes: scopes,
	})
	s, err := tok.SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mountSupport(s *debugScenario) *SupportHandler {
	sh := NewSupportHandler(s.f.e.srv, s.f.h.auth, nil)
	sh.complete = s.stub.complete
	sh.providerReady = func(context.Context, string) bool { return true }
	s.f.mux.HandleFunc("POST /v1/support/ask", sh.Ask)
	s.f.mux.HandleFunc("POST /v1/support/escalations", sh.Escalate)
	s.f.mux.HandleFunc("GET /v1/support/escalations", sh.ListEscalations)
	s.f.mux.HandleFunc("GET /v1/support/escalations/{id}", sh.GetEscalation)
	s.f.mux.HandleFunc("GET /v1/support/escalations/{id}/verify", sh.VerifyEscalation)
	return sh
}

// HIGH 1: a runs:execute-only key (a public widget key) must not reach any of
// these routes, whatever PAL_AUTHZ_ENFORCE says.
func TestDebugSupport_ScopeMatrixAlwaysEnforced(t *testing.T) {
	t.Setenv("PAL_AUTHZ_ENFORCE", "0")
	s := newDebugScenario(t)
	mountSupport(s)
	s.stub.reply = `{"answer":"ok [run:` + s.failedRun + `]","escalate":false}`
	code, out := s.f.call("POST", "/v1/support/escalations", s.f.owner, map[string]any{"question": "help", "runId": s.failedRun})
	if code != 201 {
		t.Fatalf("owner escalate: %d %v", code, out)
	}
	esc := out["id"].(string)

	type call struct{ method, path string }
	analyze := call{"POST", "/v1/debug/analyze"}
	ask := call{"POST", "/v1/support/ask"}
	escPost := call{"POST", "/v1/support/escalations"}
	escList := call{"GET", "/v1/support/escalations"}
	escGet := call{"GET", "/v1/support/escalations/" + esc}
	escVerify := call{"GET", "/v1/support/escalations/" + esc + "/verify"}
	body := func(c call) any {
		switch c {
		case analyze:
			return map[string]any{"kind": "run", "runId": s.failedRun}
		case ask:
			return map[string]any{"question": "why did it fail?"}
		case escPost:
			return map[string]any{"question": "help"}
		}
		return nil
	}
	all := []call{analyze, ask, escPost, escList, escGet, escVerify}
	for name, tc := range map[string]struct {
		tok   string
		allow []call
	}{
		"widget runs:execute only":        {mintScopedKey(t, s.f.tenant, "runs:execute"), nil},
		"coarse read (no execute)":        {mintScopedKey(t, s.f.tenant, "read"), []call{escList, escGet, escVerify}},
		"agents+budgets read, no execute": {mintScopedKey(t, s.f.tenant, "agents:read", "budgets:read"), nil},
		"debug key":                       {mintScopedKey(t, s.f.tenant, "runs:execute", "agents:read", "budgets:read"), []call{analyze, ask}},
		"settings key":                    {mintScopedKey(t, s.f.tenant, "settings:write"), []call{escPost, escList, escGet, escVerify}},
		"kiosk session":                   {mintTestToken(t, s.f.tenant, "kiosk-1", "kiosk"), nil},
		"owner session":                   {s.f.owner, all},
	} {
		allowed := map[call]bool{}
		for _, c := range tc.allow {
			allowed[c] = true
		}
		for _, c := range all {
			code, out := s.f.call(c.method, c.path, tc.tok, body(c))
			if allowed[c] && (code == 401 || code == 403) {
				t.Errorf("%s: %s %s should be allowed, got %d %v", name, c.method, c.path, code, out)
			}
			if !allowed[c] && code != 403 {
				t.Errorf("%s: %s %s must be 403, got %d %v", name, c.method, c.path, code, out)
			}
		}
	}
}

// MED 4: secrets inside JSON text (run error, step error, incident evidence and
// events) reach neither the model, the report, nor the escalation bundle.
func TestDebugSupport_JSONSecretsNeverLeave(t *testing.T) {
	s := newDebugScenario(t)
	mountSupport(s)
	ctx := context.Background()
	secrets := []string{"hunter2-real-pass", "k-live-0123456789abcdef", "Zq9tokenvalue77"}
	errJSON := `{"message":"db login failed","password":"hunter2-real-pass","dsn_api_key":"k-live-0123456789abcdef"}`
	must(t, execSQL(s.f, `UPDATE runs SET error = $2::jsonb WHERE id = $1`, s.failedRun, errJSON))
	b, _ := json.Marshal(map[string]any{"tool": "db", "error": `upstream replied {"authToken":"Zq9tokenvalue77","ok":false}`})
	_, err := s.f.e.superPool.Exec(ctx, `INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload) VALUES ($1,4,'step_failed','db',1,$2)`, s.failedRun, b)
	must(t, err)
	var inc string
	ids, _ := json.Marshal([]string{s.failedRun})
	must(t, s.f.e.superPool.QueryRow(ctx, `INSERT INTO agent_incidents (tenant_id, agent_name, kind, title, evidence, affected_run_ids)
		VALUES ($1,$2,'anomaly:error_rate','t',$3::jsonb,$4::jsonb) RETURNING id::text`, s.f.tenant, s.f.agent,
		`{"sample":"{\"password\":\"hunter2-real-pass\"}"}`, string(ids)).Scan(&inc))
	_, err = s.f.e.superPool.Exec(ctx, `INSERT INTO agent_incident_events (tenant_id, incident_id, actor, action, detail) VALUES ($1,$2,'x','note',$3)`,
		s.f.tenant, inc, `retry with {"api_key":"k-live-0123456789abcdef"}`)
	must(t, err)

	s.stub.reply = `{"summary":"s [ev:4]","rootCause":"db [ev:4]","confidence":"low","proposals":[]}`
	for _, body := range []map[string]any{{"kind": "run", "runId": s.failedRun}, {"kind": "incident", "incidentId": inc}} {
		code, _, raw := s.analyze(s.f.owner, body)
		if code != 200 {
			t.Fatalf("analyze %v: %d %s", body, code, raw)
		}
		prompt := s.stub.prompts[len(s.stub.prompts)-1]
		for _, sec := range secrets {
			if strings.Contains(prompt, sec) || strings.Contains(raw, sec) {
				t.Fatalf("SECRET %q leaked (prompt or report) for %v", sec, body)
			}
		}
	}
	_, out := s.f.call("POST", "/v1/support/escalations", s.f.owner, map[string]any{"question": `my creds {"password":"hunter2-real-pass"}`, "runId": s.failedRun})
	raw, _ := json.Marshal(out)
	var stored string
	must(t, s.f.e.superPool.QueryRow(ctx, `SELECT signed_payload FROM support_escalations WHERE id = $1`, out["id"]).Scan(&stored))
	for _, sec := range secrets {
		if strings.Contains(string(raw), sec) || strings.Contains(stored, sec) {
			t.Fatalf("SECRET %q leaked into the escalation bundle", sec)
		}
	}
}

// MED 5: evidence is bounded, the call is admitted only within the rate limit,
// the tenant cap (with a real estimate) and the debug agents' own daily cap.
func TestDebugSupport_EvidenceBudgetAndAdmission(t *testing.T) {
	s := newDebugScenario(t)
	mountSupport(s)
	ctx := context.Background()
	big := strings.Repeat("x", 3000)
	for i := int64(10); i < 400; i++ {
		b, _ := json.Marshal(map[string]any{"output": big, "n": i})
		_, err := s.f.e.superPool.Exec(ctx, `INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload) VALUES ($1,$2,'step_completed','s',1,$3)`, s.failedRun, i, b)
		must(t, err)
	}
	s.stub.reply = `{"summary":"s [ev:399]","rootCause":"r","confidence":"low","proposals":[]}`
	if code, _, raw := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	p := s.stub.prompts[len(s.stub.prompts)-1]
	if len(p) > 72<<10 {
		t.Fatalf("prompt is %d bytes; evidence must stay within its budget", len(p))
	}
	for _, want := range []string{"[ev:399]", "[evidence:truncated]", "[diff:prompt]"} {
		if !strings.Contains(p, want) {
			t.Fatalf("budget must keep the newest events, the agent-level evidence, and say what it dropped: missing %s\nrefs: %v", want, evRefRe.FindAllString(p, -1))
		}
	}

	// Rate limit (Redis fixed window).
	s.f.h.auth.rl = newFakeRedis()
	t.Setenv("PAL_DEBUG_RATE_PER_HOUR", "2")
	before := s.stub.calls()
	for i := 0; i < 2; i++ {
		if code, _, raw := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun}); code != 200 {
			t.Fatalf("call %d: %d %s", i, code, raw)
		}
	}
	if code, _, _ := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun}); code != 429 {
		t.Fatalf("third call within the hour: want 429, got %d", code)
	}
	if code, _ := s.f.call("POST", "/v1/support/ask", s.f.owner, map[string]any{"question": "why?"}); code == 429 {
		t.Fatal("support has its own window")
	}
	if s.stub.calls()-before != 3 {
		t.Fatalf("a rate-limited call must not reach the model (calls %d)", s.stub.calls()-before)
	}
	s.f.h.auth.rl = nil

	// The debug agents' own daily cap bounds a tenant with no tenant-wide cap.
	t.Setenv("PAL_DEBUG_MAX_USD_PER_DAY", "0.0001")
	before = s.stub.calls()
	if code, _, raw := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun}); code != 402 || !strings.Contains(raw, "debug_budget_exceeded") {
		t.Fatalf("debug daily cap: want 402 debug_budget_exceeded, got %d %s", code, raw)
	}
	if code, _ := s.f.call("POST", "/v1/support/ask", s.f.owner, map[string]any{"question": "why?"}); code != 402 {
		t.Fatalf("support under the debug cap: want 402, got %d", code)
	}
	t.Setenv("PAL_DEBUG_MAX_USD_PER_DAY", "off")
	// Tenant cap: nothing spent yet today in this bucket, but the ESTIMATE of
	// this call exceeds the cap, so it is refused before the model is called.
	must(t, execSQL(s.f, `DELETE FROM agent_usage_daily WHERE tenant_id = $1`, s.f.tenant))
	must(t, execSQL(s.f, `INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail) VALUES ($1,'*',0.001,true)`, s.f.tenant))
	if code, _, raw := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun}); code != 402 || !strings.Contains(raw, "budget_exceeded") {
		t.Fatalf("tenant cap with estimate: want 402, got %d %s", code, raw)
	}
	if s.stub.calls() != before {
		t.Fatal("a refused call must not reach the model")
	}
}

// LOW 11: the signed bytes are stored verbatim, typed, verifiable, and a
// tampered payload fails verification; NUL is rejected.
func TestSupportEscalation_VerifyAndTamper(t *testing.T) {
	s := newDebugScenario(t)
	mountSupport(s)
	code, out := s.f.call("POST", "/v1/support/escalations", s.f.owner, map[string]any{"question": "help", "runId": s.failedRun})
	if code != 201 {
		t.Fatalf("%d %v", code, out)
	}
	id := out["id"].(string)
	if b := out["bundle"].(map[string]any); b["type"] != supportBundleType {
		t.Fatalf("bundle type: %v", b["type"])
	}
	_, v := s.f.call("GET", "/v1/support/escalations/"+id+"/verify", s.f.owner, nil)
	if v["valid"] != true {
		t.Fatalf("fresh escalation must verify: %v", v)
	}
	must(t, execSQL(s.f, `UPDATE support_escalations SET signed_payload = replace(signed_payload, '"help"', '"HELP"') WHERE id = $1`, id))
	_, v = s.f.call("GET", "/v1/support/escalations/"+id+"/verify", s.f.owner, nil)
	if v["valid"] != false || v["digestMatches"] != false {
		t.Fatalf("a tampered payload must not verify: %v", v)
	}
	if code, _ := s.f.call("POST", "/v1/support/escalations", s.f.owner, map[string]any{"question": "a\x00b"}); code != 400 {
		t.Fatalf("NUL: want 400, got %d", code)
	}
	if code, _ := s.f.call("POST", "/v1/support/ask", s.f.owner, map[string]any{"question": "why?", "history": []map[string]string{{"role": "user", "text": "x\x00"}}}); code != 400 {
		t.Fatalf("NUL in history: want 400, got %d", code)
	}
	other := seedEnforcedTenant(t, s.f.e, "esc-v-"+uuid.NewString()[:8])
	if code, _ := s.f.call("GET", "/v1/support/escalations/"+id+"/verify", mintTestToken(t, other, "u", "owner"), nil); code != 404 {
		t.Fatalf("cross-tenant verify: want 404, got %d", code)
	}
}

// RLS (invariant #7): under the enforced pal_app role, an escalation row is
// visible only with its own tenant's GUC, and the handlers' tenant-scoped
// reads work through RLS (the scenario's handlers already run on TenantPool).
func TestRLSDebugSupport_EscalationsIsolatedAtTheDatabase(t *testing.T) {
	s := newDebugScenario(t)
	mountSupport(s)
	if code, out := s.f.call("POST", "/v1/support/escalations", s.f.owner, map[string]any{"question": "help", "runId": s.failedRun}); code != 201 {
		t.Fatalf("insert through RLS: %d %v", code, out)
	}
	other := seedEnforcedTenant(t, s.f.e, "esc-rls-"+uuid.NewString()[:8])
	count := func(tenant string) int {
		var n int
		must(t, db.WithTenantConn(context.Background(), s.f.e.srv.TenantPool(), tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(context.Background(), `SELECT count(*) FROM support_escalations`).Scan(&n)
		}))
		return n
	}
	if count(s.f.tenant) != 1 || count(other) != 0 {
		t.Fatalf("RLS: own=%d other=%d", count(s.f.tenant), count(other))
	}
	// A pal_app insert claiming another tenant is refused by WITH CHECK.
	err := db.WithTenantConn(context.Background(), s.f.e.srv.TenantPool(), other, func(tx pgx.Tx) error {
		_, e := tx.Exec(context.Background(), `INSERT INTO support_escalations (tenant_id, subject_kind, question, bundle, signed_payload, digest, signature, algorithm, created_by)
			VALUES ($1,'none','q','{}','{}','d','s','a','x')`, s.f.tenant)
		return e
	})
	if err == nil {
		t.Fatal("RLS WITH CHECK must refuse a cross-tenant insert")
	}
	// The analyze path reads runs/journal/incidents/promotions under RLS too.
	s.stub.reply = `{"summary":"s [ev:2]","rootCause":"r [ev:2]","confidence":"low","proposals":[]}`
	if code, _, raw := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun}); code != 200 || !strings.Contains(s.stub.prompts[len(s.stub.prompts)-1], "[promo:") {
		t.Fatalf("analyze under enforced RLS: %d %s", code, raw)
	}
}
