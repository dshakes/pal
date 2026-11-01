package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type debugStub struct {
	mu      sync.Mutex
	prompts []string
	reply   string
	err     error
}

func (s *debugStub) complete(_ context.Context, _, system, user string) (string, int64, int64, float64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prompts = append(s.prompts, system+"\n"+user)
	return s.reply, 120, 40, 0.0021, s.err
}

func (s *debugStub) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.prompts)
}

type debugScenario struct {
	f                  *promoFixture
	dh                 *DebugHandler
	stub               *debugStub
	goodRun, failedRun string
}

const debugStubReply = `{"summary":"The run failed right after v2 shipped [ev:2].",
 "rootCause":"The lookup tool timed out [ev:2] and v2 changed the system prompt to force French [diff:prompt]; an invented ref [ev:999] must vanish.",
 "confidence":"high","citations":["ev:2","diff:prompt","ev:999"],
 "proposals":[
  {"kind":"rollback","env":"prod","title":"Roll prod back to v1","rationale":"v1 was healthy [diff:prompt]"},
  {"kind":"prompt_patch","find":"Always answer in French.","replace":"Answer in the customer's language.","title":"Stop forcing French"},
  {"kind":"eval_case","expectedBehavior":"Looks up the order and answers in English.","title":"Pin this as a regression"},
  {"kind":"policy","title":"Grant the refund connector?"},
  {"kind":"drop_database","title":"nuke"}]}`

// newDebugScenario: v1 healthy, v2 promoted to prod (forces French), a failed
// v2 run with a tool timeout (carrying a secret) and a policy denial.
func newDebugScenario(t *testing.T) *debugScenario {
	t.Helper()
	f := newPromoFixture(t)
	ctx := context.Background()
	must(t, execSQL(f, `UPDATE agent_versions SET manifest = jsonb_build_object('snapshot', jsonb_build_object('systemPrompt', $2::text, 'model', 'fast'))
		WHERE version = 'v1' AND agent_id = (SELECT id FROM agents WHERE tenant_id=$1 AND name=$3)`, f.tenant, "Answer briefly.", f.agent))
	must(t, execSQL(f, `UPDATE agent_versions SET manifest = jsonb_build_object('snapshot', jsonb_build_object('systemPrompt', $2::text, 'model', 'fast'))
		WHERE version = 'v2' AND agent_id = (SELECT id FROM agents WHERE tenant_id=$1 AND name=$3)`, f.tenant, "Always answer in French.", f.agent))
	must(t, execSQL(f, `UPDATE agents SET system_prompt = 'Always answer in French.' WHERE tenant_id=$1 AND name=$2`, f.tenant, f.agent))
	f.ready("v2")
	_, out := f.promote(f.apikey, "prod", "v2", nil)
	if code, _ := f.call("POST", "/v1/promotions/"+promoID(out)+"/approve", f.owner, nil); code != 200 || f.prodVersion() != "v2" {
		t.Fatalf("setup: v2 not serving prod (approve %d)", code)
	}
	s := &debugScenario{f: f, stub: &debugStub{reply: debugStubReply}}
	s.goodRun = s.insertRun("v1", "succeeded", `{"prompt":"refund order 41"}`, `null`, 2*time.Hour)
	s.failedRun = s.insertRun("v2", "failed", `{"prompt":"refund order 42 for ada@example.com"}`, `{"message":"lookup timed out"}`, time.Minute)
	at := time.Now().Add(-time.Minute)
	for _, ev := range []struct {
		seq        int64
		kind, step string
		payload    map[string]any
	}{
		{1, "step_started", "lookup", map[string]any{"name": "Lookup", "type": "tool"}},
		{2, "step_failed", "lookup", map[string]any{"tool": "lookup_order", "error": "timeout calling with " + obsFakeKey, "args": map[string]any{"api_key": obsFakeKey, "id": 42}}},
		{3, "policy_denied", "refund", map[string]any{"kind": "connector", "target": "stripe.refund", "reason": "not granted"}},
	} {
		b, _ := json.Marshal(ev.payload)
		_, err := f.e.superPool.Exec(ctx, `INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload, created_at) VALUES ($1,$2,$3,$4,1,$5,$6)`,
			s.failedRun, ev.seq, ev.kind, ev.step, b, at.Add(time.Duration(ev.seq)*time.Second))
		must(t, err)
	}
	t.Cleanup(func() {
		_, _ = f.e.superPool.Exec(context.Background(), `DELETE FROM journal_events WHERE run_id = $1`, s.failedRun)
	})
	s.dh = NewDebugHandler(f.e.srv, f.h.auth, nil)
	s.dh.complete = s.stub.complete
	s.dh.providerReady = func(context.Context, string) bool { return true }
	f.mux.HandleFunc("POST /v1/debug/analyze", s.dh.Analyze)
	return s
}

func execSQL(f *promoFixture, q string, args ...any) error {
	_, err := f.e.superPool.Exec(context.Background(), q, args...)
	return err
}

func (s *debugScenario) insertRun(version, status, input, runErr string, age time.Duration) string {
	s.f.t.Helper()
	var id string
	created := time.Now().Add(-age)
	must(s.f.t, s.f.e.superPool.QueryRow(context.Background(), `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, error, cost_usd, created_at, started_at, finished_at)
		SELECT a.tenant_id, a.id, av.id, $3, 'api', $4::jsonb, NULLIF($5,'null')::jsonb, 0.01, $6, $6, $6::timestamptz + interval '2 seconds'
		FROM agents a JOIN agent_versions av ON av.agent_id = a.id WHERE a.tenant_id = $1 AND a.name = $2 AND av.version = $7
		RETURNING id::text`, s.f.tenant, s.f.agent, status, input, runErr, created, version).Scan(&id))
	return id
}

// mutableState is everything a debug proposal could change. Analyze must leave
// all of it exactly as it was.
func (s *debugScenario) mutableState() string {
	s.f.t.Helper()
	var out string
	must(s.f.t, s.f.e.superPool.QueryRow(context.Background(), `SELECT concat_ws('|',
		(SELECT concat(system_prompt, '/', model, '/', current_version_id) FROM agents WHERE tenant_id=$1 AND name=$2),
		(SELECT string_agg(concat(env, '=', version, ',', previous_version, ',', status), ';' ORDER BY env) FROM agent_environments WHERE tenant_id=$1),
		(SELECT count(*) FROM agent_promotions WHERE tenant_id=$1),
		(SELECT count(*) FROM agent_promotion_audit WHERE tenant_id=$1),
		(SELECT count(*) FROM eval_suites WHERE tenant_id=$1),
		(SELECT count(*) FROM runs WHERE tenant_id=$1),
		(SELECT count(*) FROM agent_budgets WHERE tenant_id=$1),
		(SELECT count(*) FROM agent_policies p JOIN agents a ON a.id = p.agent_id WHERE a.tenant_id=$1))`, s.f.tenant, s.f.agent).Scan(&out))
	return out
}

func (s *debugScenario) analyze(tok string, body map[string]any) (int, map[string]any, string) {
	s.f.t.Helper()
	code, out := s.f.call("POST", "/v1/debug/analyze", tok, body)
	raw, _ := json.Marshal(out)
	return code, out, string(raw)
}

func proposalsByKind(out map[string]any) map[string]map[string]any {
	m := map[string]map[string]any{}
	ps, _ := out["proposals"].([]any)
	for _, p := range ps {
		pm := p.(map[string]any)
		m[pm["kind"].(string)] = pm
	}
	return m
}

func TestDebugAnalyze_RunIsGroundedRedactedAndNeverApplied(t *testing.T) {
	s := newDebugScenario(t)
	before := s.mutableState()

	code, out, raw := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun, "question": "why did this fail?"})
	if code != 200 {
		t.Fatalf("analyze: %d %s", code, raw)
	}
	if after := s.mutableState(); after != before {
		t.Fatalf("ANALYZE MUTATED STATE — proposals must never be auto-applied\nbefore %s\nafter  %s", before, after)
	}
	// Secrets never reach the model or the response (invariant #10).
	prompt := s.stub.prompts[0]
	if strings.Contains(prompt, obsFakeKey) || strings.Contains(raw, obsFakeKey) {
		t.Fatal("SECRET LEAKED into the debug prompt or report")
	}
	// The model saw the real evidence.
	for _, want := range []string{"[ev:2] step_failed", "[diff:prompt]", "Always answer in French.", "[env:prod]", "[stats:24h]", "stripe.refund", "Allowed proposal kinds: rollback, prompt_patch, model_change, eval_case, policy, retry"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q", want)
		}
	}
	if out["grounded"] != true || out["confidence"] != "high" || out["requiresApproval"] != true {
		t.Fatalf("report header: %s", raw)
	}
	if strings.Contains(raw, "ev:999") {
		t.Fatalf("invented ref survived: %s", raw)
	}
	props := proposalsByKind(out)
	if len(props) != 4 {
		t.Fatalf("want rollback/prompt_patch/eval_case/policy, got %s", raw)
	}
	rb := props["rollback"]["action"].(map[string]any)
	if rb["method"] != "POST" || rb["path"] != "/v1/agents/"+s.f.agent+"/environments/prod/rollback" {
		t.Fatalf("rollback action: %v", rb)
	}
	if props["policy"]["action"] != nil {
		t.Fatal("policy proposal must not be one-click")
	}
	if !strings.Contains(raw, `"kind":"drop_database"`) {
		t.Fatalf("unknown kind must be reported as dropped: %s", raw)
	}
	// The regression case replays the recorded tool failure, redacted.
	cases := props["eval_case"]["action"].(map[string]any)["body"].(map[string]any)["cases"].([]any)
	mock := cases[0].(map[string]any)["mocks"].([]any)[0].(map[string]any)
	if mock["tool"] != "lookup_order" || !strings.Contains(fmt.Sprint(mock["error"]), "timeout") {
		t.Fatalf("mock: %v", mock)
	}

	// Metering: the model call is recorded against the workspace bucket.
	var cost float64
	must(t, s.f.e.superPool.QueryRow(context.Background(), `SELECT COALESCE(SUM(cost_usd),0)::float8 FROM agent_usage_daily
		WHERE tenant_id=$1 AND agent_name='__agentless__'`, s.f.tenant).Scan(&cost))
	if cost < 0.002 {
		t.Fatalf("debug spend not metered: %v", cost)
	}

	// Closing the loop: the proposal is a REAL request. Applied by the human
	// through the existing endpoint, prod goes back to v1 with an audit row.
	code, res := s.f.call(rb["method"].(string), rb["path"].(string), s.f.owner, rb["body"])
	if code != 200 || s.f.prodVersion() != "v1" {
		t.Fatalf("approving the rollback proposal: %d %v prod=%s", code, res, s.f.prodVersion())
	}
}

func TestDebugAnalyze_CrossTenantIs404AndNeverCallsTheModel(t *testing.T) {
	s := newDebugScenario(t)
	var inc string
	must(t, s.f.e.superPool.QueryRow(context.Background(), `INSERT INTO agent_incidents (tenant_id, agent_name, kind, title)
		VALUES ($1,$2,'anomaly:error_rate','t') RETURNING id::text`, s.f.tenant, s.f.agent).Scan(&inc))
	other := seedEnforcedTenant(t, s.f.e, "dbg-x-"+uuid.NewString()[:8])
	tok := mintTestToken(t, other, "intruder", "owner")
	for name, body := range map[string]map[string]any{
		"run":                 {"kind": "run", "runId": s.failedRun},
		"incident":            {"kind": "incident", "incidentId": inc},
		"eval_case":           {"kind": "eval_case", "agentName": s.f.agent, "case": "anything"},
		"eval_case any agent": {"kind": "eval_case", "case": "greets-in-english"},
		"no run":              {"kind": "run", "runId": uuid.NewString()},
	} {
		if code, _, raw := s.analyze(tok, body); code != http.StatusNotFound {
			t.Errorf("%s: cross-tenant must be 404, got %d %s", name, code, raw)
		}
	}
	if s.stub.calls() != 0 {
		t.Fatal("the model must not be called for a subject the caller does not own")
	}
	for name, body := range map[string]map[string]any{
		"kind":      {"kind": "vm"},
		"junk id":   {"kind": "run", "runId": "'; drop table runs;--"},
		"eval bare": {"kind": "eval_case", "agentName": "a/b"},
	} {
		if code, _, _ := s.analyze(s.f.owner, body); code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", name, code)
		}
	}
	if code, _, _ := s.analyze("not-a-token", map[string]any{"kind": "run", "runId": s.failedRun}); code != http.StatusUnauthorized {
		t.Errorf("no auth: want 401, got %d", code)
	}
}

func TestDebugAnalyze_IncidentUsesIncidentRollbackAndVersionDiff(t *testing.T) {
	s := newDebugScenario(t)
	var inc string
	ids, _ := json.Marshal([]string{s.failedRun})
	must(t, s.f.e.superPool.QueryRow(context.Background(), `INSERT INTO agent_incidents
		(tenant_id, agent_name, kind, severity, title, first_bad_version, last_good_version, suspected_cause, rollback_suggested, affected_run_ids)
		VALUES ($1,$2,'anomaly:error_rate','page','Error rate 40%','v2','v1','error rate 8x',true,$3::jsonb) RETURNING id::text`,
		s.f.tenant, s.f.agent, string(ids)).Scan(&inc))
	s.stub.reply = `{"summary":"Error rate jumped on v2 [incident:` + inc + `]","rootCause":"v2 forced French [diff:prompt] and the tool timed out [ev:2].","confidence":"medium","citations":["incident:` + inc + `"],"proposals":[{"kind":"rollback","env":"prod"}]}`
	code, out, raw := s.analyze(s.f.owner, map[string]any{"kind": "incident", "incidentId": inc})
	if code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	if !strings.Contains(s.stub.prompts[0], "[diff:prompt]") || !strings.Contains(s.stub.prompts[0], "[ev:2]") {
		t.Fatal("incident evidence must include the version diff and the affected run's journal")
	}
	rb := proposalsByKind(out)["rollback"]["action"].(map[string]any)
	if rb["path"] != "/v1/incidents/"+inc+"/rollback" {
		t.Fatalf("incident rollback must use the incident endpoint (re-checks the serving version): %v", rb)
	}
	if sub := out["subject"].(map[string]any); sub["incidentId"] != inc || sub["runId"] != s.failedRun {
		t.Fatalf("subject: %v", sub)
	}
}

func TestDebugAnalyze_EvalCaseIsServerGrounded(t *testing.T) {
	s := newDebugScenario(t)
	ctx := context.Background()
	var suite, evalRun string
	must(t, s.f.e.superPool.QueryRow(ctx, `INSERT INTO eval_suites (tenant_id, agent_name, name, cases) VALUES ($1,$2,'smoke',
		'[{"name":"greets-in-english","input":"hello","assert":{"contains":"Hello"}}]'::jsonb) RETURNING id::text`, s.f.tenant, s.f.agent).Scan(&suite))
	must(t, s.f.e.superPool.QueryRow(ctx, `INSERT INTO eval_runs (tenant_id, suite_id, agent_name, agent_version, passed, score, cases_total, cases_passed, cases_result)
		VALUES ($1,$2,$3,'v2',false,0,1,0,'[{"name":"greets-in-english","passed":false,"score":0,"actual":"Bonjour","expected":"Hello"}]'::jsonb) RETURNING id::text`,
		s.f.tenant, suite, s.f.agent).Scan(&evalRun))
	s.stub.reply = `{"summary":"Answered in French [eval:` + evalRun + `]","rootCause":"The prompt forces French [case:definition].","confidence":"high","proposals":[{"kind":"prompt_patch","find":"Always answer in French.","replace":"Answer in English."},{"kind":"retry"}]}`
	code, out, raw := s.analyze(s.f.owner, map[string]any{"kind": "eval_case", "agentName": s.f.agent, "case": "greets-in-english"})
	if code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	if !strings.Contains(s.stub.prompts[0], "Bonjour") || !strings.Contains(s.stub.prompts[0], "input: hello") {
		t.Fatal("eval evidence must be loaded server-side")
	}
	props := proposalsByKind(out)
	if props["prompt_patch"] == nil || props["retry"] != nil {
		t.Fatalf("eval subject: prompt patch yes, retry no: %s", raw)
	}
	// Without agentName the server finds the case among the tenant's own eval runs.
	if code, out, raw := s.analyze(s.f.owner, map[string]any{"kind": "eval_case", "case": "greets-in-english"}); code != 200 || out["subject"].(map[string]any)["agentName"] != s.f.agent {
		t.Fatalf("eval case without agentName: %d %s", code, raw)
	}
	if code, _, _ := s.analyze(s.f.owner, map[string]any{"kind": "eval_case", "agentName": s.f.agent, "case": "never-failed"}); code != 404 {
		t.Fatalf("unknown failing case: want 404, got %d", code)
	}
}

func TestDebugAnalyze_BudgetProviderAndBadOutput(t *testing.T) {
	s := newDebugScenario(t)
	ctx := context.Background()
	// Tenant-wide hard cap already exceeded → 402, the model is not called.
	must(t, execSQL(s.f, `INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail) VALUES ($1,'*',0.01,true)`, s.f.tenant))
	must(t, execSQL(s.f, `INSERT INTO agent_usage_daily (tenant_id, agent_name, usage_date, cost_usd) VALUES ($1,'x',$2,5)`, s.f.tenant, usageDate(time.Now())))
	if code, _, raw := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun}); code != http.StatusPaymentRequired || s.stub.calls() != 0 {
		t.Fatalf("tenant cap: want 402 and no model call, got %d %s (calls %d)", code, raw, s.stub.calls())
	}
	_, err := s.f.e.superPool.Exec(ctx, `DELETE FROM agent_budgets WHERE tenant_id=$1`, s.f.tenant)
	must(t, err)

	s.dh.providerReady = func(context.Context, string) bool { return false }
	if code, _, raw := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun}); code != 400 || !strings.Contains(raw, "no_provider") {
		t.Fatalf("no provider: %d %s", code, raw)
	}
	s.dh.providerReady = func(context.Context, string) bool { return true }

	s.stub.reply = "I think it's DNS."
	if code, _, raw := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun}); code != 502 || !strings.Contains(raw, "bad_report") {
		t.Fatalf("prose answer: %d %s", code, raw)
	}
	s.stub.err = errors.New("provider down")
	if code, _, raw := s.analyze(s.f.owner, map[string]any{"kind": "run", "runId": s.failedRun}); code != 502 || !strings.Contains(raw, "llm_failed") {
		t.Fatalf("model error: %d %s", code, raw)
	}
}
