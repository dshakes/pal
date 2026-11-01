package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestMinimizePII(t *testing.T) {
	for in, want := range map[string]string{
		"mail ada@example.com now":     "mail [email] now",
		"call +1 512 555 1234 please":  "call [phone] please",
		"call (512) 555-1234":          "call [phone]",
		"call 512-555-1234":            "call [phone]",
		"intl +447911123456":           "intl [phone]",
		"at 2026-10-31T12:00:00Z ok":   "at 2026-10-31T12:00:00Z ok",
		"run 3751ade4-c889-40e9-8ba0":  "run 3751ade4-c889-40e9-8ba0",
		"cost $0.0021 for 1200 tokens": "cost $0.0021 for 1200 tokens",
	} {
		if got := minimizePII(in); got != want {
			t.Errorf("minimizePII(%q) = %q, want %q", in, got, want)
		}
	}
	if got := minimizePII("key " + obsFakeKey); strings.Contains(got, obsFakeKey) {
		t.Fatalf("secret survived: %q", got)
	}
}

func TestRankDocs(t *testing.T) {
	got := rankDocs("why was my run blocked by the budget spend limit?", 3)
	if len(got) == 0 || got[0].Slug != "build/budgets" {
		t.Fatalf("budgets page should rank first: %+v", got)
	}
	if len(rankDocs("zzzz qqqq", 3)) != 0 {
		t.Fatal("no overlap → no docs")
	}
}

func TestBuildSupportAnswer_ValidatesEverything(t *testing.T) {
	run := uuid.NewString()
	f := supportFacts{runs: map[string]bool{run: true}, incidents: map[string]bool{}, agents: map[string]bool{"desk": true}}
	items := []debugItem{{Ref: "run:" + run, Label: "failed run"}}
	out := supportModelOut{Answer: "It hit the budget [run:" + run + "] [run:fake] see [doc:build/budgets] and [doc:nope].", Docs: []string{"build/evaluations", "made/up"}}
	out.Actions = append(out.Actions,
		struct {
			Kind       string `json:"kind"`
			RunID      string `json:"runId"`
			IncidentID string `json:"incidentId"`
			Href       string `json:"href"`
			Label      string `json:"label"`
		}{Kind: "debug_run", RunID: run},
		struct {
			Kind       string `json:"kind"`
			RunID      string `json:"runId"`
			IncidentID string `json:"incidentId"`
			Href       string `json:"href"`
			Label      string `json:"label"`
		}{Kind: "debug_run", RunID: uuid.NewString()},
		struct {
			Kind       string `json:"kind"`
			RunID      string `json:"runId"`
			IncidentID string `json:"incidentId"`
			Href       string `json:"href"`
			Label      string `json:"label"`
		}{Kind: "open", Href: "https://evil.example/phish"},
		struct {
			Kind       string `json:"kind"`
			RunID      string `json:"runId"`
			IncidentID string `json:"incidentId"`
			Href       string `json:"href"`
			Label      string `json:"label"`
		}{Kind: "open", Href: "/agents/desk", Label: "Open desk"},
		struct {
			Kind       string `json:"kind"`
			RunID      string `json:"runId"`
			IncidentID string `json:"incidentId"`
			Href       string `json:"href"`
			Label      string `json:"label"`
		}{Kind: "delete_everything"},
	)
	ans := buildSupportAnswer(f, items, out)
	if strings.Contains(ans.Answer, "run:fake") || strings.Contains(ans.Answer, "doc:nope") {
		t.Fatalf("invented refs must be stripped: %q", ans.Answer)
	}
	if len(ans.Citations) != 1 || len(ans.Docs) != 2 || ans.Docs[0].Path != "/docs/build/budgets/" {
		t.Fatalf("citations/docs: %+v %+v", ans.Citations, ans.Docs)
	}
	if len(ans.Actions) != 2 || ans.Actions[0].RunID != run || ans.Actions[1].Href != "/agents/desk" {
		t.Fatalf("only grounded, allowlisted actions survive: %+v", ans.Actions)
	}
	if !ans.Grounded || ans.SuggestEscalate {
		t.Fatalf("grounded answer: %+v", ans)
	}
	if bare := buildSupportAnswer(f, items, supportModelOut{Answer: "No idea."}); bare.Grounded || !bare.SuggestEscalate {
		t.Fatalf("an ungrounded answer must suggest escalation: %+v", bare)
	}
}

// The docs index is the page frontmatter verbatim, and covers every page.
func TestSupportDocsMatchSite(t *testing.T) {
	root := "../../../../site/src/content/docs/docs"
	front := func(b []byte, key string) string {
		for _, l := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(l, key+":"); ok {
				return strings.Trim(strings.TrimSpace(v), `"`)
			}
		}
		return ""
	}
	seen := map[string]bool{}
	for _, d := range supportDocs {
		file := filepath.Join(root, d.Slug+".mdx")
		if _, err := os.Stat(file); err != nil {
			file = filepath.Join(root, d.Slug, "index.mdx")
		}
		b, err := os.ReadFile(file)
		if err != nil {
			t.Errorf("doc %q: %v", d.Slug, err)
			continue
		}
		if got := front(b, "title"); got != d.Title {
			t.Errorf("doc %q title drifted (run scripts/gen-support-docs.py): index %q, page %q", d.Slug, d.Title, got)
		}
		if got := front(b, "description"); got != d.Summary {
			t.Errorf("doc %q summary drifted (run scripts/gen-support-docs.py): index %q, page %q", d.Slug, d.Summary, got)
		}
		seen[file] = true
	}
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && strings.HasSuffix(p, ".mdx") && !seen[p] {
			t.Errorf("page %s is missing from supportDocs: run scripts/gen-support-docs.py", p)
		}
		return nil
	})
}

func newSupportScenario(t *testing.T) (*debugScenario, *SupportHandler) {
	s := newDebugScenario(t)
	sh := NewSupportHandler(s.f.e.srv, s.f.h.auth, nil)
	sh.complete = s.stub.complete
	sh.providerReady = func(context.Context, string) bool { return true }
	return s, sh
}

func TestSupportAsk_GroundedAndTenantScoped(t *testing.T) {
	s, sh := newSupportScenario(t)
	s.f.mux.HandleFunc("POST /v1/support/ask", sh.Ask)
	s.stub.reply = `{"answer":"The run failed on a tool timeout [run:` + s.failedRun + `]; see [doc:build/evaluations].","actions":[{"kind":"debug_run","runId":"` + s.failedRun + `"},{"kind":"debug_run","runId":"` + uuid.NewString() + `"}],"escalate":false}`
	code, out := s.f.call("POST", "/v1/support/ask", s.f.owner, map[string]any{"question": "why did my last run fail?"})
	raw, _ := json.Marshal(out)
	if code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	prompt := s.stub.prompts[0]
	if !strings.Contains(prompt, "[run:"+s.failedRun+"]") || !strings.Contains(prompt, "[doc:build/") || strings.Contains(prompt, obsFakeKey) {
		t.Fatalf("support prompt must carry workspace facts + docs and no secrets")
	}
	acts, _ := out["actions"].([]any)
	if len(acts) != 1 || out["grounded"] != true {
		t.Fatalf("only the real run survives as an action: %s", raw)
	}
	other := seedEnforcedTenant(t, s.f.e, "sup-x-"+uuid.NewString()[:8])
	tok := mintTestToken(t, other, "intruder", "owner")
	if code, _ := s.f.call("POST", "/v1/support/ask", tok, map[string]any{"question": "what about this run?", "runId": s.failedRun}); code != 404 {
		t.Fatalf("cross-tenant runId: want 404, got %d", code)
	}
	// The other tenant's facts never include this tenant's run.
	_, _ = s.f.call("POST", "/v1/support/ask", tok, map[string]any{"question": "why did my last run fail?"})
	if last := s.stub.prompts[len(s.stub.prompts)-1]; strings.Contains(last, s.failedRun) {
		t.Fatal("CROSS-TENANT LEAK: another tenant's run reached the support prompt")
	}
	if code, _ := s.f.call("POST", "/v1/support/ask", s.f.owner, map[string]any{"question": "x"}); code != 400 {
		t.Fatalf("too short: want 400, got %d", code)
	}
}

func TestSupportEscalate_BundleIsMinimalSignedAndScoped(t *testing.T) {
	s, sh := newSupportScenario(t)
	s.f.mux.HandleFunc("POST /v1/support/escalations", sh.Escalate)
	s.f.mux.HandleFunc("GET /v1/support/escalations", sh.ListEscalations)
	s.f.mux.HandleFunc("GET /v1/support/escalations/{id}", sh.GetEscalation)
	before := s.mutableState()
	code, out := s.f.call("POST", "/v1/support/escalations", s.f.owner, map[string]any{
		"question": "Please help, call me at +1 512 555 1234 or ada@example.com",
		"runId":    s.failedRun,
		"transcript": []map[string]string{
			{"role": "user", "text": "my key is " + obsFakeKey},
			{"role": "agent", "text": "I could not find the cause."},
		},
	})
	raw, _ := json.Marshal(out)
	if code != 201 {
		t.Fatalf("%d %s", code, raw)
	}
	for _, leak := range []string{obsFakeKey, "ada@example.com", "555 1234", "refund order 42"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("BUNDLE LEAK %q: %s", leak, raw)
		}
	}
	b := out["bundle"].(map[string]any)
	run := b["run"].(map[string]any)
	if run["journalHash"] == "" || len(run["steps"].([]any)) != 3 || run["inputKeys"].([]any)[0] != "prompt" {
		t.Fatalf("bundle run shape: %v", run)
	}
	if s.mutableState() != before {
		t.Fatal("escalating must not change agent state")
	}

	// The stored bundle verifies against its digest and signature.
	id := out["id"].(string)
	var stored []byte
	var digest, sig, alg string
	must(t, s.f.e.superPool.QueryRow(context.Background(), `SELECT bundle, digest, signature, algorithm FROM support_escalations WHERE id=$1`, id).Scan(&stored, &digest, &sig, &alg))
	var v any
	must(t, json.Unmarshal(stored, &v))
	canon, err := canonicalJSON(v)
	must(t, err)
	sum := sha256.Sum256(canon)
	if hex.EncodeToString(sum[:]) != digest {
		t.Fatal("stored bundle does not match its digest")
	}
	if alg == "HMAC-SHA256" && hmacSign(canon) != sig {
		t.Fatal("bundle signature does not verify")
	}

	other := seedEnforcedTenant(t, s.f.e, "esc-x-"+uuid.NewString()[:8])
	tok := mintTestToken(t, other, "intruder", "owner")
	if code, _ := s.f.call("GET", "/v1/support/escalations/"+id, tok, nil); code != 404 {
		t.Fatalf("cross-tenant GET: want 404, got %d", code)
	}
	if code, _ := s.f.call("POST", "/v1/support/escalations", tok, map[string]any{"question": "help", "runId": s.failedRun}); code != 404 {
		t.Fatalf("cross-tenant subject: want 404, got %d", code)
	}
	_, list := s.f.call("GET", "/v1/support/escalations", tok, nil)
	if l, _ := list["escalations"].([]any); len(l) != 0 {
		t.Fatalf("another tenant sees escalations: %v", list)
	}
	_, list = s.f.call("GET", "/v1/support/escalations", s.f.owner, nil)
	if l, _ := list["escalations"].([]any); len(l) != 1 {
		t.Fatalf("own list: %v", list)
	}
	if code, _ := s.f.call("POST", "/v1/support/escalations", s.f.owner, map[string]any{"question": "help", "runId": s.failedRun, "incidentId": uuid.NewString()}); code != 400 {
		t.Fatalf("two subjects: want 400, got %d", code)
	}
}
