package pal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
)

// ---------- Debug agent + support (read-only; proposals are data) ----------

// DebugCitation points at a piece of evidence a report or answer relies on.
type DebugCitation struct {
	Ref    string `json:"ref"`
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
}

// DebugProposalAction is the request a human would send through an existing
// endpoint to apply a proposal. The SDK never sends it.
type DebugProposalAction struct {
	Method         string          `json:"method"`
	Path           string          `json:"path"`
	Body           json.RawMessage `json:"body,omitempty"`
	IdempotencyKey string          `json:"idempotencyKey,omitempty"`
}

// DebugProposalPrecondition is a read the UI re-checks before offering the action.
type DebugProposalPrecondition struct {
	Path   string         `json:"path"`
	Expect map[string]any `json:"expect"`
}

// DebugProposalDiff is a before/after view of a single field.
type DebugProposalDiff struct {
	Field  string `json:"field"`
	Before any    `json:"before"`
	After  any    `json:"after"`
	// Hunk is the exact edit of a prompt_patch (Removed/Added never clipped).
	Hunk *DebugProposalHunk `json:"hunk,omitempty"`
}

// DebugProposalHunk: at byte Offset of the current prompt, Removed becomes Added.
type DebugProposalHunk struct {
	Offset        int    `json:"offset"`
	ContextBefore string `json:"contextBefore"`
	Removed       string `json:"removed"`
	Added         string `json:"added"`
	ContextAfter  string `json:"contextAfter"`
}

// DebugProposal is one suggested remediation. Kind is one of rollback,
// prompt_patch, model_change, eval_case, budget, policy, retry.
type DebugProposal struct {
	ID           string                     `json:"id"`
	Kind         string                     `json:"kind"`
	Title        string                     `json:"title"`
	Rationale    string                     `json:"rationale"`
	Citations    []string                   `json:"citations"`
	Risk         string                     `json:"risk"`
	Action       *DebugProposalAction       `json:"action,omitempty"`
	Precondition *DebugProposalPrecondition `json:"precondition,omitempty"`
	Href         string                     `json:"href,omitempty"`
	Diff         *DebugProposalDiff         `json:"diff,omitempty"`
	Preview      string                     `json:"preview,omitempty"`
	FollowUp     string                     `json:"followUp,omitempty"`
}

// DebugAnalyzeRequest is the payload for AnalyzeDebug. Kind is "run",
// "incident" or "eval_case".
type DebugAnalyzeRequest struct {
	Kind       string `json:"kind"`
	RunID      string `json:"runId,omitempty"`
	IncidentID string `json:"incidentId,omitempty"`
	AgentName  string `json:"agentName,omitempty"`
	Case       string `json:"case,omitempty"`
	Question   string `json:"question,omitempty"`
}

// DebugDropped records a proposal the server discarded and why.
type DebugDropped struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason"`
}

// DebugSubject identifies what a report is about.
type DebugSubject struct {
	Kind       string `json:"kind"`
	RunID      string `json:"runId,omitempty"`
	IncidentID string `json:"incidentId,omitempty"`
	AgentName  string `json:"agentName"`
	Case       string `json:"case,omitempty"`
}

// DebugReport is the response of AnalyzeDebug. Confidence is high|medium|low.
type DebugReport struct {
	Summary          string             `json:"summary"`
	RootCause        string             `json:"rootCause"`
	Confidence       string             `json:"confidence"`
	Grounded         bool               `json:"grounded"`
	Citations        []DebugCitation    `json:"citations"`
	Proposals        []DebugProposal    `json:"proposals"`
	Dropped          []DebugDropped     `json:"dropped"`
	Subject          DebugSubject       `json:"subject"`
	Evidence         map[string]float64 `json:"evidence"`
	CostUSD          float64            `json:"costUsd"`
	RequiresApproval bool               `json:"requiresApproval"`
	GeneratedAt      string             `json:"generatedAt"`
}

// AnalyzeDebug asks the debug agent for a grounded root-cause report. It
// never applies anything: proposals are data a human applies through the
// existing endpoints. Errors: 400 no_provider, 402 budget_exceeded, 404,
// 502 llm_failed|bad_report (as *APIError).
func (c *Client) AnalyzeDebug(ctx context.Context, req DebugAnalyzeRequest) (*DebugReport, error) {
	var out DebugReport
	if err := c.do(ctx, http.MethodPost, "/v1/debug/analyze", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SupportTurn is one prior conversation turn (Role "user" or "agent").
type SupportTurn struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

// AskSupportRequest is the payload for AskSupport.
type AskSupportRequest struct {
	Question string        `json:"question"`
	RunID    string        `json:"runId,omitempty"`
	History  []SupportTurn `json:"history,omitempty"`
}

// SupportDoc is a documentation page an answer drew on.
type SupportDoc struct {
	Slug  string `json:"slug"`
	Title string `json:"title"`
	Path  string `json:"path"`
}

// SupportAction is a suggested next step (Kind: debug_run|debug_incident|open).
type SupportAction struct {
	Kind       string `json:"kind"`
	RunID      string `json:"runId,omitempty"`
	IncidentID string `json:"incidentId,omitempty"`
	Href       string `json:"href,omitempty"`
	Label      string `json:"label,omitempty"`
}

// SupportAnswer is the response of AskSupport.
type SupportAnswer struct {
	Answer            string          `json:"answer"`
	Citations         []DebugCitation `json:"citations"`
	Docs              []SupportDoc    `json:"docs"`
	Actions           []SupportAction `json:"actions"`
	SuggestEscalation bool            `json:"suggestEscalation"`
	Grounded          bool            `json:"grounded"`
	CostUSD           float64         `json:"costUsd"`
	RequiresApproval  bool            `json:"requiresApproval"`
}

// AskSupport asks the support agent a question. It never applies anything;
// the returned actions are data.
func (c *Client) AskSupport(ctx context.Context, req AskSupportRequest) (*SupportAnswer, error) {
	var out SupportAnswer
	if err := c.do(ctx, http.MethodPost, "/v1/support/ask", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// EscalateSupportRequest is the payload for EscalateSupport.
type EscalateSupportRequest struct {
	Question   string        `json:"question"`
	RunID      string        `json:"runId,omitempty"`
	IncidentID string        `json:"incidentId,omitempty"`
	Transcript []SupportTurn `json:"transcript,omitempty"`
}

// SupportEscalationResult is the 201 response of EscalateSupport.
type SupportEscalationResult struct {
	ID        string         `json:"id"`
	Digest    string         `json:"digest"`
	Algorithm string         `json:"algorithm"`
	Signature string         `json:"signature"`
	CreatedAt string         `json:"createdAt"`
	Bundle    map[string]any `json:"bundle"`
}

// EscalateSupport files a signed escalation bundle. It never applies anything.
func (c *Client) EscalateSupport(ctx context.Context, req EscalateSupportRequest) (*SupportEscalationResult, error) {
	var out SupportEscalationResult
	if err := c.do(ctx, http.MethodPost, "/v1/support/escalations", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SupportEscalationSummary is a list entry of ListSupportEscalations.
type SupportEscalationSummary struct {
	ID          string `json:"id"`
	SubjectKind string `json:"subjectKind"`
	SubjectID   string `json:"subjectId,omitempty"`
	Question    string `json:"question"`
	Digest      string `json:"digest"`
	Algorithm   string `json:"algorithm"`
	CreatedBy   string `json:"createdBy"`
	CreatedAt   string `json:"createdAt"`
}

// SupportEscalation is the full record returned by GetSupportEscalation.
type SupportEscalation struct {
	SupportEscalationSummary
	Signature string         `json:"signature"`
	Bundle    map[string]any `json:"bundle"`
}

// ListSupportEscalations lists the tenant's escalations, newest first.
func (c *Client) ListSupportEscalations(ctx context.Context) ([]SupportEscalationSummary, error) {
	var out struct {
		Escalations []SupportEscalationSummary `json:"escalations"`
	}
	if err := c.do(ctx, http.MethodGet, "/v1/support/escalations", nil, &out); err != nil {
		return nil, err
	}
	return out.Escalations, nil
}

// GetSupportEscalation fetches one escalation including signature and bundle.
func (c *Client) GetSupportEscalation(ctx context.Context, id string) (*SupportEscalation, error) {
	var out SupportEscalation
	if err := c.do(ctx, http.MethodGet, "/v1/support/escalations/"+url.PathEscape(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
