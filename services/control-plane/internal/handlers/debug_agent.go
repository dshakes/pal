package handlers

// debug_agent.go — POST /v1/debug/analyze, the post-deployment debug agent
// (ADR 0059). Given a failing run, an incident or a failing eval case it reads
// the real evidence server-side, asks the model for a grounded root cause, and
// returns fix PROPOSALS a human approves through existing endpoints.
//
// Guarantees, each pinned by a test:
//   - Tenant scope: every read runs in one WithTenant transaction with an
//     explicit tenant_id filter on the subject row; a subject in another tenant
//     is 404 (no existence leak). journal_events / agent_versions are
//     RLS-exempt child tables reached only through that authorized row.
//   - Nothing is applied: this handler performs no write except the usage
//     rollup that meters its own model call. Proposals carry the exact request
//     (built server-side, debug_logic.go) and the client sends it with the
//     approving human's credentials.
//   - Grounding: the model must cite evidence refs; unknown refs are stripped
//     and an uncited report is marked ungrounded with low confidence.
//   - Secrets: evidence passes obs.Redact / RedactString before the model sees
//     it, and the report passes redactSecrets (invariant #10).
//   - Model + money: CompleteInternalWithUsage with capability "auto" (model
//     router seam, invariant #6). Before the call: a per-tenant hourly rate
//     limit, then the estimate is RESERVED and the tenant-wide cap and the debug
//     agents' own daily cap are read after it (admitDebugCall), so concurrent
//     calls cannot all pass one stale check. Spend accrues to "__pal_debug__", not to
//     the debugged agent, so an agent blocked by its own budget stays debuggable.
//   - Authorization: runs:execute + agents:read + budgets:read, always enforced
//     (debugCallerAllowed) — a runs:execute-only widget key gets 403.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/middleware"
	"github.com/dshakes/pal/services/control-plane/internal/obs"
	"github.com/dshakes/pal/services/control-plane/internal/server"
)

const (
	debugMaxEvents     = 80
	debugMaxQuestion   = 600
	debugEventDetail   = 400
	debugRunTextDetail = 600
)

type debugCompleteFn func(ctx context.Context, tenantID, system, user string) (text string, tokensIn, tokensOut int64, costUSD float64, err error)

// DebugHandler serves /v1/debug/*.
type DebugHandler struct {
	srv           *server.Server
	auth          *AuthHandler
	complete      debugCompleteFn
	providerReady func(ctx context.Context, tenantID string) bool
	now           func() time.Time
}

func NewDebugHandler(srv *server.Server, auth *AuthHandler, llm *LlmProxyHandler) *DebugHandler {
	h := &DebugHandler{srv: srv, auth: auth, now: time.Now}
	if llm != nil {
		h.complete = llm.CompleteInternalWithUsage
		h.providerReady = llm.hasAnyLLMProvider
	}
	return h
}

func (h *DebugHandler) logger() *zap.Logger { return h.srv.Logger.Named("debug-agent") }

// RegisterRoutes: analyze spends tenant money (runs:execute) AND reads the
// agent definition and budget, so the handler also requires agents:read and
// budgets:read, always (debugCallerAllowed).
func (h *DebugHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/debug/analyze", h.auth.WithScope(ScopeRunsExecute, h.Analyze))
}

type debugRequest struct {
	Kind       string `json:"kind"` // run | incident | eval_case
	RunID      string `json:"runId,omitempty"`
	IncidentID string `json:"incidentId,omitempty"`
	AgentName  string `json:"agentName,omitempty"`
	Case       string `json:"case,omitempty"`
	Question   string `json:"question,omitempty"`
}

type debugResponse struct {
	debugReport
	Subject          debugSubject   `json:"subject"`
	Evidence         map[string]int `json:"evidence"`
	CostUSD          float64        `json:"costUsd"`
	RequiresApproval bool           `json:"requiresApproval"`
	GeneratedAt      time.Time      `json:"generatedAt"`
}

type debugSubject struct {
	Kind       string `json:"kind"`
	RunID      string `json:"runId,omitempty"`
	IncidentID string `json:"incidentId,omitempty"`
	AgentName  string `json:"agentName"`
	Case       string `json:"case,omitempty"`
}

var errDebugNotFound = errors.New("not found")

var agentNameShape = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// Analyze handles POST /v1/debug/analyze.
func (h *DebugHandler) Analyze(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil || claims.TenantID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !debugCallerAllowed(claims, debugScopes...) {
		writeInsufficientScope(w, debugScopes...)
		return
	}
	tenantID := claims.TenantID
	var req debugRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if strings.ContainsRune(req.Question, 0) || strings.ContainsRune(req.Case, 0) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text must not contain NUL"})
		return
	}
	switch req.Kind {
	case "run":
		if !isUUID(req.RunID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "runId must be a run id"})
			return
		}
	case "incident":
		if !isUUID(req.IncidentID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "incidentId must be an incident id"})
			return
		}
	case "eval_case":
		if (req.AgentName != "" && !agentNameShape.MatchString(req.AgentName)) || strings.TrimSpace(req.Case) == "" || len(req.Case) > 200 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "case is required (agentName optional)"})
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be run, incident or eval_case"})
		return
	}
	if h.complete == nil || h.providerReady == nil || !h.providerReady(r.Context(), tenantID) {
		writeLLMAssistError(w, errNoLLMProvider)
		return
	}

	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	var facts debugFacts
	var items []debugItem
	subject := debugSubject{Kind: req.Kind}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		g := &debugGather{ctx: ctx, tx: tx, tenant: tenantID, f: &facts}
		var e error
		switch req.Kind {
		case "run":
			e = g.run(req.RunID, true)
		case "incident":
			e = g.incident(req.IncidentID)
		case "eval_case":
			e = g.evalCase(req.AgentName, req.Case)
		}
		if e != nil {
			return e
		}
		e = g.agentContext()
		g.finish()
		items = g.items
		return e
	})
	if errors.Is(err, errDebugNotFound) || errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": req.Kind + " not found"})
		return
	}
	if err != nil {
		h.logger().Error("gather evidence", zap.String("tenant_id", tenantID), zap.String("kind", req.Kind), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	subject.AgentName, subject.RunID, subject.IncidentID = facts.AgentName, facts.RunID, facts.IncidentID
	if req.Kind == "eval_case" {
		subject.Case = cleanText(req.Case, 200)
	}
	// The span carries the run the evidence was actually read from (for an
	// incident, its primary affected run), not just what the request named.
	middleware.EnrichSpan(ctx, tenantID, claims.Subject, facts.RunID, "")

	nonce := newNonce()
	user := debugUserPrompt(subjectLabel(req, facts), facts, items, cleanText(req.Question, debugMaxQuestion), nonce)
	// Metering (budgets section of CLAUDE.md): rate limit, tenant cap and the
	// debug agents' own daily cap, each with a real estimate of this call.
	reserved, ok := admitDebugCall(ctx, w, h.auth, h.srv.Pool, tenantID, "analyze", len(debugSystemPrompt)+len(user))
	if !ok {
		return
	}
	text, tin, tout, cost, err := h.complete(ctx, tenantID, debugSystemPrompt, user)
	if err != nil {
		tin, tout, cost = 0, 0, 0 // release the reservation
	}
	if recErr := settleDebugCall(ctx, h.srv.Pool, tenantID, reserved, tin, tout, cost); recErr != nil {
		h.logger().Warn("debug: settle usage failed", zap.Error(recErr))
	}
	if err != nil {
		h.logger().Warn("debug: model call failed", zap.String("tenant_id", tenantID), zap.Error(err))
		writeLLMAssistError(w, fmt.Errorf("debug: %w", err))
		return
	}
	out, err := parseDebugModelOut(text)
	if err != nil {
		// The error names a JSON position only — never generated content.
		h.logger().Warn("debug: unusable model output", zap.Error(err), zap.Int("chars", len(text)))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "the model returned no usable report", "code": "bad_report"})
		return
	}
	rep := buildDebugReport(facts, items, out)
	if span := trace.SpanFromContext(ctx); span.IsRecording() {
		span.SetAttributes(attribute.String("pal.debug.kind", req.Kind), attribute.Int("pal.debug.proposals", len(rep.Proposals)),
			attribute.Bool("pal.debug.grounded", rep.Grounded), attribute.String("pal.agent_name", facts.AgentName))
	}
	writeJSON(w, http.StatusOK, debugResponse{
		debugReport: rep,
		Subject:     subject,
		Evidence:    countEvidence(items),
		CostUSD:     cost,
		// Always true: the debug agent proposes; a person applies.
		RequiresApproval: true,
		GeneratedAt:      h.now().UTC(),
	})
}

func subjectLabel(req debugRequest, f debugFacts) string {
	switch req.Kind {
	case "incident":
		return "incident " + f.IncidentID
	case "eval_case":
		return fmt.Sprintf("failing eval case %q", cleanText(req.Case, 200))
	}
	return "run " + f.RunID
}

func countEvidence(items []debugItem) map[string]int {
	out := map[string]int{}
	for _, it := range items {
		k := it.Ref
		if i := strings.Index(k, ":"); i > 0 {
			k = k[:i]
		}
		out[k]++
	}
	return out
}

// ---- evidence ------------------------------------------------------------------------

type debugGather struct {
	ctx    context.Context
	tx     pgx.Tx
	tenant string
	f      *debugFacts
	items  []debugItem
	refs   map[string]bool
	// version labels for the diff (failing vs last good)
	badVersion, goodVersion string
	agentID                 string
	createdAt               time.Time
	// bytes of evidence kept, and items dropped for the debugEvidenceBudget.
	bytes, dropped int
}

// add keeps one evidence item: redacted BEFORE it is clipped (a secret split
// by the cut must not survive half-masked), stripped of control characters,
// and only while the total stays under debugEvidenceBudget.
func (g *debugGather) add(ref, label, detail string) {
	if g.refs == nil {
		g.refs = map[string]bool{}
	}
	if g.refs[ref] {
		return
	}
	it := debugItem{Ref: ref, Label: cleanText(label, 300), Detail: cleanText(detail, 1500)}
	size := len(it.Ref) + len(it.Label) + len(it.Detail) + 8
	if g.bytes+size > debugEvidenceBudget {
		g.dropped++
		return
	}
	g.refs[ref] = true
	g.bytes += size
	g.items = append(g.items, it)
}

// finish records, as evidence itself, that some evidence was left out.
func (g *debugGather) finish() {
	if g.dropped > 0 {
		g.items = append(g.items, debugItem{Ref: "evidence:truncated",
			Label: fmt.Sprintf("%d more evidence items were left out to stay within the evidence budget", g.dropped)})
	}
}

var budgetSignalRe = regexp.MustCompile(`(?i)budget|\b402\b|spend limit|run limit reached|token limit reached`)

// compactJSON renders a decoded payload, redacted and bounded.
func compactJSON(v any, n int) string {
	if v == nil {
		return ""
	}
	b, err := json.Marshal(obs.Redact(v))
	if err != nil || string(b) == "null" || string(b) == "{}" {
		return ""
	}
	return clip(string(b), n)
}

// run loads the subject (or primary affected) run. primary=true also sets the
// run facts the proposals are gated on.
func (g *debugGather) run(runID string, primary bool) error {
	var (
		status, agentName, agentID, version, inputText, snapRaw string
		input, output, runErr                                   []byte
		cost                                                    float64
		created                                                 time.Time
		finished                                                *time.Time
		versionID                                               string
	)
	err := g.tx.QueryRow(g.ctx, `
		SELECT r.status, a.name, a.id::text, COALESCE(v.version,''), r.agent_version_id::text,
		       r.input, COALESCE(r.output,'null'::jsonb), COALESCE(r.error,'null'::jsonb),
		       r.cost_usd::float8, r.created_at, r.finished_at,
		       COALESCE(r.input->>'prompt', r.input::text, ''),
		       COALESCE(v.manifest->'snapshot','null'::jsonb)::text
		FROM runs r JOIN agents a ON a.id = r.agent_id AND a.tenant_id = r.tenant_id
		LEFT JOIN agent_versions v ON v.id = r.agent_version_id
		WHERE r.id = $1 AND r.tenant_id = $2`, runID, g.tenant,
	).Scan(&status, &agentName, &agentID, &version, &versionID, &input, &output, &runErr, &cost, &created, &finished, &inputText, &snapRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return errDebugNotFound
	}
	if err != nil {
		return err
	}
	var errV, outV any
	_ = json.Unmarshal(runErr, &errV)
	_ = json.Unmarshal(output, &outV)
	dur := "unfinished"
	if finished != nil {
		dur = finished.Sub(created).Round(time.Millisecond).String()
	}
	g.add("run:"+runID, fmt.Sprintf("run %s status=%s agent=%s version=%s cost=$%.4f duration=%s started=%s",
		runID, status, agentName, firstNonEmpty(version, "?"), cost, dur, created.UTC().Format(time.RFC3339)),
		strings.TrimSpace("input: "+cleanText(inputText, debugRunTextDetail)+" | error: "+compactJSON(errV, debugRunTextDetail)+" | output: "+compactJSON(outV, debugRunTextDetail)))
	if budgetSignalRe.MatchString(string(runErr)) && g.f.BudgetSignalRef == "" {
		g.f.BudgetSignalRef = "run:" + runID
	}
	if !primary {
		return nil
	}
	g.f.RunID, g.f.AgentName, g.agentID, g.createdAt = runID, agentName, agentID, created
	g.f.RunFailed = status == "failed"
	// The regression case stores this input in an eval suite: redacted first.
	g.f.InputText = clip(redactText(inputText), 4000)
	var in map[string]any
	if json.Unmarshal(input, &in) == nil && in != nil {
		g.f.RunInput = in
	}
	g.badVersion = version

	// Journal, newest debugMaxEvents in seq order. journal_events is an
	// RLS-exempt child table; the tenant-filtered runs read above proved ownership.
	rows, err := g.tx.Query(g.ctx, `
		SELECT seq, kind, COALESCE(step_id,''), attempt, payload, created_at FROM (
			SELECT seq, kind, step_id, attempt, payload, created_at FROM journal_events
			WHERE run_id = $1 ORDER BY seq DESC LIMIT $2) t ORDER BY seq`, runID, debugMaxEvents)
	if err != nil {
		return err
	}
	type ev struct {
		seq        int64
		kind, step string
		attempt    int
		payload    map[string]any
		at         time.Time
	}
	var evs []ev
	for rows.Next() {
		var e ev
		var raw []byte
		if err := rows.Scan(&e.seq, &e.kind, &e.step, &e.attempt, &raw, &e.at); err != nil {
			rows.Close()
			return err
		}
		_ = json.Unmarshal(raw, &e.payload)
		evs = append(evs, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	// The journal gets at most debugJournalBudget: keep the NEWEST events (the
	// failure is usually at the end), shown oldest first.
	type evItem struct {
		ref, label, detail string
		e                  ev
	}
	var kept []evItem
	used := 0
	for i := len(evs) - 1; i >= 0; i-- {
		e := evs[i]
		it := evItem{ref: fmt.Sprintf("ev:%d", e.seq), e: e, detail: compactJSON(e.payload, debugEventDetail),
			label: fmt.Sprintf("%s step=%s attempt=%d at=%s", e.kind, firstNonEmpty(e.step, "-"), e.attempt, e.at.UTC().Format("15:04:05.000"))}
		if used += len(it.label) + len(it.detail) + 16; used > debugJournalBudget {
			g.dropped += i + 1
			break
		}
		kept = append(kept, it)
	}
	for i := len(kept) - 1; i >= 0; i-- {
		ref, detail, e := kept[i].ref, kept[i].detail, kept[i].e
		g.add(ref, kept[i].label, detail)
		if e.kind == "policy_denied" {
			s := func(k string) string { v, _ := e.payload[k].(string); return cleanText(v, 200) }
			g.f.Denials = append(g.f.Denials, debugDenial{Ref: ref, Kind: s("kind"), Target: s("target"), Reason: s("reason")})
		}
		if g.f.BudgetSignalRef == "" && (strings.Contains(e.kind, "budget") || (strings.Contains(e.kind, "fail") && budgetSignalRe.MatchString(detail))) {
			g.f.BudgetSignalRef = ref
		}
	}

	// Trace summary + the tool results this run recorded (they become the
	// regression case's mocks, so a replay sees exactly what this run saw).
	if tr, err := buildRunTrace(g.ctx, g.tx, g.tenant, runID, 0); err == nil {
		g.add("trace:"+runID, tr.Describe(), "")
		seenTool := map[string]bool{}
		for _, n := range tr.Steps {
			if n.Tool == nil || n.Tool.Name == "" || seenTool[n.Tool.Name] {
				continue
			}
			switch n.Status {
			case "ok":
				seenTool[n.Tool.Name] = true
				g.f.Mocks = append(g.f.Mocks, evalMock{Tool: n.Tool.Name, Result: n.Output})
			case "failed":
				seenTool[n.Tool.Name] = true
				g.f.Mocks = append(g.f.Mocks, evalMock{Tool: n.Tool.Name, Error: firstNonEmpty(n.Error, "tool failed")})
			}
		}
	}

	// Last good version: the newest succeeded run of this agent on a DIFFERENT
	// version, before this run.
	var goodLabel string
	err = g.tx.QueryRow(g.ctx, `
		SELECT COALESCE(v.version,'') FROM runs r JOIN agent_versions v ON v.id = r.agent_version_id
		WHERE r.tenant_id = $1 AND r.agent_id = $2 AND r.status = 'succeeded'
		  AND r.agent_version_id <> $3 AND r.created_at < $4
		ORDER BY r.created_at DESC LIMIT 1`, g.tenant, agentID, versionID, created).Scan(&goodLabel)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if g.goodVersion == "" {
		g.goodVersion = goodLabel
	}

	// 24h shape of the failure.
	var failed, ok, same int
	if err := g.tx.QueryRow(g.ctx, `
		SELECT count(*) FILTER (WHERE status = 'failed'), count(*) FILTER (WHERE status = 'succeeded'),
		       count(*) FILTER (WHERE status = 'failed' AND error IS NOT DISTINCT FROM $3::jsonb)
		FROM runs WHERE tenant_id = $1 AND agent_id = $2 AND created_at > $4`,
		g.tenant, agentID, string(runErr), created.Add(-24*time.Hour)).Scan(&failed, &ok, &same); err != nil {
		return err
	}
	g.add("stats:24h", fmt.Sprintf("agent runs in the 24h before this run: %d failed (%d with this exact error), %d succeeded", failed, same, ok), "")
	return nil
}

func (g *debugGather) incident(id string) error {
	d, err := scanIncident(g.tx.QueryRow(g.ctx, `SELECT `+incidentCols+` FROM agent_incidents WHERE id=$1 AND tenant_id=$2`, id, g.tenant))
	if errors.Is(err, pgx.ErrNoRows) {
		return errDebugNotFound
	}
	if err != nil {
		return err
	}
	g.f.IncidentID, g.f.AgentName = d.ID, d.AgentName
	g.f.IncidentRollback = d.Status != "resolved" && d.Rollback.Suggested
	g.add("incident:"+d.ID, fmt.Sprintf("incident %s kind=%s severity=%s status=%s opened=%s: %s", d.ID, d.Kind, d.Severity, d.Status,
		d.OpenedAt.UTC().Format(time.RFC3339), d.Title),
		fmt.Sprintf("suspected cause: %s | first bad version: %s | last good version: %s | rollback suggested: %v | summary: %s | evidence: %s",
			d.SuspectedCause, firstNonEmpty(d.FirstBadVersion, "?"), firstNonEmpty(d.LastGoodVersion, "?"), d.Rollback.Suggested,
			d.Summary, cleanText(string(d.Evidence), 600)))
	rows, err := g.tx.Query(g.ctx, `SELECT id, at, actor, action, detail FROM agent_incident_events
		WHERE incident_id=$1 AND tenant_id=$2 ORDER BY id LIMIT 20`, id, g.tenant)
	if err != nil {
		return err
	}
	for rows.Next() {
		var evID int64
		var ev incidentEvent
		if err := rows.Scan(&evID, &ev.At, &ev.Actor, &ev.Action, &ev.Detail); err != nil {
			rows.Close()
			return err
		}
		g.add(fmt.Sprintf("inc-ev:%d", evID), fmt.Sprintf("incident %s by %s at %s", ev.Action, ev.Actor, ev.At.UTC().Format(time.RFC3339)), ev.Detail)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	g.badVersion, g.goodVersion = d.FirstBadVersion, d.LastGoodVersion
	// Primary run: the newest failed affected run, else the newest affected run.
	var primary string
	if len(d.AffectedRunIDs) > 0 {
		err := g.tx.QueryRow(g.ctx, `SELECT id::text FROM runs WHERE tenant_id=$1 AND id::text = ANY($2)
			ORDER BY (status='failed') DESC, created_at DESC LIMIT 1`, g.tenant, d.AffectedRunIDs).Scan(&primary)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	if primary != "" {
		badV, goodV := g.badVersion, g.goodVersion
		if err := g.run(primary, true); err != nil && !errors.Is(err, errDebugNotFound) {
			return err
		}
		// The incident's own version attribution wins over the run heuristic.
		g.badVersion = firstNonEmpty(badV, g.badVersion)
		g.goodVersion = firstNonEmpty(goodV, g.goodVersion)
		for _, other := range d.AffectedRunIDs {
			if other != primary && len(g.items) < 140 && isUUID(other) {
				if err := g.run(other, false); err != nil && !errors.Is(err, errDebugNotFound) {
					return err
				}
			}
			if countEvidence(g.items)["run"] >= 4 {
				break
			}
		}
	}
	return nil
}

func (g *debugGather) evalCase(agentName, caseName string) error {
	// agentName "" → the newest failing run of this case among the tenant's agents
	// (the dashboard's failure clusters span agents).
	probe, _ := json.Marshal([]map[string]any{{"name": caseName, "passed": false}})
	var runID, suiteID, version, casesRaw string
	var created time.Time
	err := g.tx.QueryRow(g.ctx, `
		SELECT id::text, suite_id::text, agent_name, COALESCE(agent_version,''), cases_result::text, created_at
		FROM eval_runs WHERE tenant_id = $1 AND ($2 = '' OR agent_name = $2) AND cases_result @> $3::jsonb
		ORDER BY created_at DESC LIMIT 1`, g.tenant, agentName, string(probe)).Scan(&runID, &suiteID, &g.f.AgentName, &version, &casesRaw, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return errDebugNotFound
	}
	if err != nil {
		return err
	}
	var results []evalCaseResult
	_ = json.Unmarshal([]byte(casesRaw), &results)
	for _, c := range results {
		if c.Name != caseName {
			continue
		}
		g.add("eval:"+runID, fmt.Sprintf("eval run %s at %s, agent version %s: case %q failed (score %.2f)", runID,
			created.UTC().Format(time.RFC3339), firstNonEmpty(version, "?"), caseName, c.Score),
			"expected: "+cleanText(c.Expected, 600)+" | actual: "+cleanText(c.Actual, 900)+" | error: "+cleanText(c.Error, 600))
		for i, a := range c.Assertions {
			if i >= 6 {
				break
			}
			g.add(fmt.Sprintf("assert:%d", i), "assertion result", compactJSON(a, 300))
		}
		break
	}
	var suiteCases []evalCase
	var suiteRaw string
	if err := g.tx.QueryRow(g.ctx, `SELECT cases::text FROM eval_suites WHERE id = $1 AND tenant_id = $2`, suiteID, g.tenant).Scan(&suiteRaw); err == nil {
		_ = json.Unmarshal([]byte(suiteRaw), &suiteCases)
		for _, c := range suiteCases {
			if c.Name == caseName {
				g.add("case:definition", "eval case definition", "input: "+cleanText(c.Input, 800)+" | assert: "+compactJSON(c.Assert, 500))
			}
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	// Last version where this case passed in the same suite → diff target.
	passProbe, _ := json.Marshal([]map[string]any{{"name": caseName, "passed": true}})
	var good string
	err = g.tx.QueryRow(g.ctx, `SELECT COALESCE(agent_version,'') FROM eval_runs
		WHERE tenant_id = $1 AND suite_id::text = $2 AND created_at < $3 AND cases_result @> $4::jsonb
		ORDER BY created_at DESC LIMIT 1`, g.tenant, suiteID, created, string(passProbe)).Scan(&good)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if good != "" {
		g.add("eval:last-pass", "case last passed on agent version "+good, "")
	}
	g.badVersion, g.goodVersion = version, good
	return nil
}

// agentContext adds the agent-level evidence every subject shares: the working
// copy, the version diff, promotions/environments (rollback gating), eval
// failures, the budget and other open incidents.
func (g *debugGather) agentContext() error {
	agent := g.f.AgentName
	if agent == "" {
		return nil
	}
	snap, _, err := loadDraftSnapshot(g.ctx, g.tx, g.tenant, agent)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// archived/deleted: explain only
	case err != nil:
		return err
	default:
		g.f.AgentExists, g.f.DraftPrompt, g.f.DraftModel = true, snap.SystemPrompt, snap.Model
		g.f.PromptHasSecret = obs.ContainsSecret(snap.SystemPrompt)
		var manifest []byte
		if err := g.tx.QueryRow(g.ctx, `SELECT COALESCE(av.manifest,'{}'::jsonb)::text FROM agent_versions av
			JOIN agents a ON a.current_version_id = av.id WHERE a.tenant_id = $1 AND a.name = $2`, g.tenant, agent).Scan(&manifest); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		g.f.Replayable = evalAgentKind(snap.Workflow, manifest) == "tool-loop"
	}

	if g.badVersion != "" && g.goodVersion != "" && g.badVersion != g.goodVersion {
		bad, e1 := versionSnapshot(g.ctx, g.tx, g.tenant, agent, g.badVersion)
		good, e2 := versionSnapshot(g.ctx, g.tx, g.tenant, agent, g.goodVersion)
		if e1 == nil && e2 == nil {
			diffs := snapshotDiffItems(g.badVersion, g.goodVersion, bad, good)
			if len(diffs) == 0 && bad != nil && good != nil {
				g.add("diff:none", fmt.Sprintf("versions %s and %s have the same prompt, model and workflow", g.badVersion, g.goodVersion), "")
			}
			for _, d := range diffs {
				g.add(d.Ref, d.Label, d.Detail)
			}
		}
	}

	rows, err := g.tx.Query(g.ctx, `SELECT id, env, action, actor, actor_kind, detail::text, created_at
		FROM agent_promotion_audit WHERE tenant_id = $1 AND agent_name = $2 ORDER BY id DESC LIMIT 8`, g.tenant, agent)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var env, action, actor, kind, detail string
		var at time.Time
		if err := rows.Scan(&id, &env, &action, &actor, &kind, &detail, &at); err != nil {
			rows.Close()
			return err
		}
		g.add(fmt.Sprintf("promo:%d", id), fmt.Sprintf("%s %s in %s by %s (%s)", at.UTC().Format(time.RFC3339), action, env, kind, actor), cleanText(detail, 400))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// Rollback gating mirrors PromotionHandler.rollbackTx exactly.
	rows, err = g.tx.Query(g.ctx, `
		SELECT e.env, e.version, COALESCE(e.previous_version,''), e.status, COALESCE(p.status,'')
		FROM agent_environments e
		LEFT JOIN LATERAL (SELECT status FROM agent_promotions
			WHERE tenant_id = e.tenant_id AND agent_name = e.agent_name AND env = e.env
			  AND status IN ('canary','promoted','rolled_back') ORDER BY created_at DESC LIMIT 1) p ON true
		WHERE e.tenant_id = $1 AND e.agent_name = $2 ORDER BY e.env`, g.tenant, agent)
	if err != nil {
		return err
	}
	for rows.Next() {
		var env, ver, prev, envStatus, promoStatus string
		if err := rows.Scan(&env, &ver, &prev, &envStatus, &promoStatus); err != nil {
			rows.Close()
			return err
		}
		g.add("env:"+env, fmt.Sprintf("%s serves %s (previous %s, %s)", env, ver, firstNonEmpty(prev, "none"), envStatus), "")
		if (promoStatus == "canary" && envStatus == "canary") || (promoStatus == "promoted" && prev != "") {
			g.f.RollbackEnvs = append(g.f.RollbackEnvs, env)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	rows, err = g.tx.Query(g.ctx, `SELECT id::text, COALESCE(agent_version,''), score::float8, cases_result::text, created_at
		FROM eval_runs WHERE tenant_id = $1 AND agent_name = $2 AND passed = false ORDER BY created_at DESC LIMIT 3`, g.tenant, agent)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, ver, raw string
		var score float64
		var at time.Time
		if err := rows.Scan(&id, &ver, &score, &raw, &at); err != nil {
			rows.Close()
			return err
		}
		var res []evalCaseResult
		_ = json.Unmarshal([]byte(raw), &res)
		var failing []string
		for _, c := range res {
			if !c.Passed && len(failing) < 6 {
				failing = append(failing, cleanText(c.Name, 60))
			}
		}
		g.add("eval:"+id, fmt.Sprintf("eval run failed at %s on version %s, score %.2f", at.UTC().Format(time.RFC3339), firstNonEmpty(ver, "?"), score),
			"failing cases: "+strings.Join(failing, ", "))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	if b, err := loadBudgetDTO(g.ctx, g.tx, g.tenant, agent); err == nil {
		g.f.Budget = b
		var spent float64
		var runs int
		_ = g.tx.QueryRow(g.ctx, `SELECT COALESCE(cost_usd,0)::float8, COALESCE(runs_count,0) FROM agent_usage_daily
			WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = $3`, g.tenant, agent, usageDate(time.Now())).Scan(&spent, &runs)
		g.add("budget:"+agent, "agent budget", fmt.Sprintf("%s | today: spent $%.4f, %d runs", compactJSON(b, 400), spent, runs))
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	if g.f.IncidentID == "" {
		rows, err = g.tx.Query(g.ctx, `SELECT id::text, kind, title, opened_at FROM agent_incidents
			WHERE tenant_id = $1 AND agent_name = $2 AND status <> 'resolved' ORDER BY opened_at DESC LIMIT 3`, g.tenant, agent)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, kind, title string
			var at time.Time
			if err := rows.Scan(&id, &kind, &title, &at); err != nil {
				rows.Close()
				return err
			}
			g.add("incident:"+id, fmt.Sprintf("open incident (%s) since %s: %s", kind, at.UTC().Format(time.RFC3339), title), "")
		}
		rows.Close()
		return rows.Err()
	}
	return nil
}

// loadBudgetDTO reads one agent's budget row inside a tenant transaction.
func loadBudgetDTO(ctx context.Context, tx pgx.Tx, tenant, agent string) (*budgetDTO, error) {
	b := &budgetDTO{AgentName: agent}
	var tools []byte
	err := tx.QueryRow(ctx, `SELECT max_cost_usd_per_day::float8, max_cost_usd_per_run::float8, max_tokens_per_day, max_runs_per_day,
		COALESCE(tool_limits,'{}'::jsonb), hard_fail, notify_at_pct
		FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`, tenant, agent).Scan(
		&b.MaxCostUsdPerDay, &b.MaxCostUsdPerRun, &b.MaxTokensPerDay, &b.MaxRunsPerDay, &tools, &b.HardFail, &b.NotifyAtPct)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(tools, &b.ToolLimits)
	return b, nil
}
