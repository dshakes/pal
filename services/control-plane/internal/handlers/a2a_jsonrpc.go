package handlers

// a2a_jsonrpc.go — A2A protocol v0.3 server surface (ADR 0057).
//
//	GET  /.well-known/agent-card.json                     deployment default agent (PAL_A2A_DEFAULT_AGENT)
//	GET  /v1/agents/{name}/a2a/.well-known/agent-card.json per-agent spec Agent Card
//	POST /v1/agents/{name}/a2a                            JSON-RPC 2.0: message/send, message/stream,
//	                                                      tasks/get, tasks/cancel, tasks/resubscribe
//
// An A2A Task IS a PAL run: task id = run id. This file only CREATES runs (via
// RunService.CreateRun, the same path as /v1/runs) and CANCELS them (via
// RunService.CancelRun, the same path as /v1/runs/{id}/cancel); the run
// executor remains the only writer of run progress (invariant #2). The A2A
// view (contextId, caller, messageId) lives in runs.trigger_meta.a2a — no new
// table, no migration.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/structpb"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
	"github.com/dshakes/pal/packages/agentpolicy"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
)

// A2AProtocolVersion is the A2A spec version this surface implements.
const A2AProtocolVersion = "0.3.0"

const (
	a2aMaxBody = 1 << 20
	// a2aBlockingWait bounds a blocking message/send (and the stream). A run
	// still going after it is returned in its current state; the client polls
	// tasks/get or resubscribes.
	a2aBlockingWait = 60 * time.Second
	a2aPoll         = 500 * time.Millisecond
)

// JSON-RPC / A2A error codes (spec §8).
const (
	rpcParseError        = -32700
	rpcInvalidRequest    = -32600
	rpcMethodNotFound    = -32601
	rpcInvalidParams     = -32602
	rpcInternal          = -32603
	a2aTaskNotFound      = -32001
	a2aTaskNotCancelable = -32002
	a2aPushNotSupported  = -32003
	a2aUnsupportedOp     = -32004
	a2aContentType       = -32005
	a2aNoExtendedCard    = -32007
)

// ---------- caller authorization (shared with the legacy /a2a/invoke) ----------

type a2aCall struct {
	target       agentRef
	targetPublic bool
	callerID     string // caller's SPIFFE id, or "tenant:<id>" for a human / API key
	callerTenant string
	isAgent      bool
}

// authorizeA2ACall authenticates the caller and resolves the target agent:
// own-tenant first, else an is_public agent; anything else is 404 (never 403 —
// no existence leak). invoke=true also runs the caller's outbound policy and
// the target's inbound policy + rate limit (ADR 0055); task reads/cancels skip
// those (they only ever reach the caller's own tasks, see a2aTaskVisible) so
// polling does not consume the target's per-caller invoke budget. On failure
// the HTTP error is written and ok=false.
func (h *A2AHandler) authorizeA2ACall(w http.ResponseWriter, r *http.Request, name string, invoke bool) (a2aCall, bool) {
	var c a2aCall
	agentTok := strings.TrimSpace(r.Header.Get(AgentTokenHeader))
	if agentTok != "" {
		c.isAgent = true
		c.callerTenant = unverifiedAgentTenant(agentTok) // only to resolve the name; verified below
	} else {
		claims, err := h.auth.validateRequest(r)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return c, false
		}
		c.callerTenant = claims.TenantID
	}

	ctx := r.Context()
	// rls-exempt: authenticated A2A is intentionally cross-tenant — a caller
	// may reach its OWN agent OR any tenant's `is_public` agent (the whole
	// point of A2A). The explicit `is_public = true OR tenant_id = $2` clause
	// does the gating; RLS would block legitimate public calls. Own-tenant
	// first so a name never resolves to a stranger's agent.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT id::text, name, tenant_id::text, COALESCE(current_version_id::text, ''), created_at, is_public FROM agents
		WHERE name = $1 AND archived_at IS NULL
		  AND (is_public = true OR tenant_id::text = $2)
		ORDER BY (tenant_id::text = $2) DESC, created_at
		LIMIT 1
	`, name, c.callerTenant).Scan(&c.target.ID, &c.target.Name, &c.target.TenantID, &c.target.VersionID, &c.target.CreatedAt, &c.targetPublic)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return c, false
	}
	if err != nil {
		h.logger().Error("a2a: lookup agent failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to look up agent"})
		return c, false
	}
	z := currentAgentAuthz()

	c.callerID = "tenant:" + c.callerTenant
	if c.isAgent {
		if z == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "agent_token_invalid", "error": "agent identity not configured"})
			return c, false
		}
		// The token must be bound to THIS target (audience = target SPIFFE id).
		caller, verr := z.agentCallerFromRequest(r, z.auth.SpiffeID(c.target.TenantID, c.target.ID))
		if verr != nil || caller.TenantID != c.callerTenant {
			// A PRIVATE target was only resolvable through the (still
			// unverified) tenant claim; answering 401 would confirm it
			// exists. Look exactly like "no such agent" instead.
			if !c.targetPublic {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
				return c, false
			}
			writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "agent_token_invalid", "error": "invalid agent token"})
			return c, false
		}
		c.callerID = caller.SpiffeID
		if invoke {
			cctx := withAgentPrincipal(middleware.InjectTenantID(ctx, caller.TenantID), caller)
			if err := caller.Authorize(cctx, agentpolicy.Action{Kind: agentpolicy.KindA2A, Target: c.target.Name,
				Aliases: []string{z.auth.SpiffeID(c.target.TenantID, c.target.ID)}}, ""); err != nil {
				writeAgentPolicyDenied(w, err)
				return c, false
			}
		}
	}
	if invoke {
		if err := z.authorizeInbound(ctx, c.target, c.callerID, c.callerTenant, c.isAgent); err != nil {
			writeAgentPolicyDenied(w, err)
			return c, false
		}
	}
	return c, true
}

// ---------- Agent Card (spec §5) ----------

// A2ACard is the A2A v0.3 AgentCard.
type A2ACard struct {
	ProtocolVersion                   string                    `json:"protocolVersion"`
	Name                              string                    `json:"name"`
	Description                       string                    `json:"description"`
	URL                               string                    `json:"url"`
	PreferredTransport                string                    `json:"preferredTransport"`
	Version                           string                    `json:"version"`
	Provider                          *A2AProvider              `json:"provider,omitempty"`
	Capabilities                      A2ACapabilities           `json:"capabilities"`
	SecuritySchemes                   map[string]map[string]any `json:"securitySchemes,omitempty"`
	Security                          []map[string][]string     `json:"security,omitempty"`
	DefaultInputModes                 []string                  `json:"defaultInputModes"`
	DefaultOutputModes                []string                  `json:"defaultOutputModes"`
	Skills                            []A2ASkill                `json:"skills"`
	SupportsAuthenticatedExtendedCard bool                      `json:"supportsAuthenticatedExtendedCard"`
}

// A2AProvider is the AgentProvider object.
type A2AProvider struct {
	Organization string `json:"organization"`
	URL          string `json:"url"`
}

// A2ACapabilities is the AgentCapabilities object.
type A2ACapabilities struct {
	Streaming              bool `json:"streaming"`
	PushNotifications      bool `json:"pushNotifications"`
	StateTransitionHistory bool `json:"stateTransitionHistory"`
}

// A2ASkill is the AgentSkill object.
type A2ASkill struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
}

var a2aModes = []string{"text/plain", "application/json"}

// buildA2ACard renders the spec card. Skills come from the agent's declared
// `capabilities` label; with none declared the agent itself is the one skill
// (honest — it is exactly what message/send runs).
func buildA2ACard(base string, a agentRef, description, version string, labelsJSON []byte) A2ACard {
	if description == "" {
		description = "PAL agent " + a.Name
	}
	if version == "" {
		version = "unreleased"
	}
	var skills []A2ASkill
	labels := map[string]string{}
	if json.Unmarshal(labelsJSON, &labels) == nil && labels["capabilities"] != "" {
		var caps []string
		if json.Unmarshal([]byte(labels["capabilities"]), &caps) == nil {
			for _, c := range caps {
				skills = append(skills, A2ASkill{ID: c, Name: c, Description: c + " (" + a.Name + ")", Tags: []string{c}})
			}
		}
	}
	if len(skills) == 0 {
		skills = []A2ASkill{{ID: a.Name, Name: a.Name, Description: description, Tags: []string{}}}
	}
	tokenDesc := "Short-lived EdDSA PAL agent token (ADR 0055)."
	if z := currentAgentAuthz(); z != nil && a.ID != "" {
		tokenDesc += " Audience: " + z.auth.SpiffeID(a.TenantID, a.ID) + "; verifying keys: " +
			base + "/.well-known/pal-agent-keys/" + a.ID
	}
	return A2ACard{
		ProtocolVersion:    A2AProtocolVersion,
		Name:               a.Name,
		Description:        description,
		URL:                base + "/v1/agents/" + a.Name + "/a2a",
		PreferredTransport: "JSONRPC",
		Version:            version,
		Provider:           &A2AProvider{Organization: "PAL", URL: "https://dshakes.github.io/pal"},
		Capabilities:       A2ACapabilities{Streaming: true},
		SecuritySchemes: map[string]map[string]any{
			"palBearer": {"type": "http", "scheme": "bearer", "bearerFormat": "PAL session JWT or API key",
				"description": "A PAL session token or API key with the runs:execute scope."},
			"palAgentToken": {"type": "apiKey", "in": "header", "name": AgentTokenHeader, "description": tokenDesc},
		},
		Security:           []map[string][]string{{"palBearer": {}}, {"palAgentToken": {}}},
		DefaultInputModes:  a2aModes,
		DefaultOutputModes: a2aModes,
		Skills:             skills,
	}
}

// loadCardAgent resolves an agent the caller may see: is_public, or owned by
// callerTenant ("" = anonymous → public only).
func (h *A2AHandler) loadCardAgent(ctx context.Context, name, callerTenant string) (agentRef, string, string, []byte, error) {
	var (
		a       agentRef
		desc    *string
		version string
		labels  []byte
	)
	// rls-exempt: public A2A card discovery — intentionally cross-tenant, gated
	// by the explicit `is_public = true OR tenant_id = $2` clause (same as
	// GetAgentCard). Own-tenant first.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT a.id::text, a.name, a.tenant_id::text, a.description, a.labels, COALESCE(av.version, '')
		FROM agents a
		LEFT JOIN agent_versions av ON av.id = a.current_version_id
		WHERE a.name = $1 AND a.archived_at IS NULL
		  AND (a.is_public = true OR a.tenant_id = $2)
		ORDER BY (a.tenant_id::text = COALESCE($2::text, '')) DESC, a.created_at
		LIMIT 1
	`, name, nullableTenant(callerTenant)).Scan(&a.ID, &a.Name, &a.TenantID, &desc, &labels, &version)
	d := ""
	if desc != nil {
		d = *desc
	}
	return a, d, version, labels, err
}

func (h *A2AHandler) serveCard(w http.ResponseWriter, r *http.Request, name, callerTenant string) {
	// The card's url is where clients send their credentials, so it must not be
	// derived from request headers in prod (Host / X-Forwarded-Host poisoning),
	// and no shared cache may keep it.
	w.Header().Set("Cache-Control", "no-store")
	if isProd() && strings.TrimSpace(os.Getenv("PAL_PUBLIC_BASE_URL")) == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "public_base_url_required",
			"error": "A2A cards need PAL_PUBLIC_BASE_URL in production"})
		return
	}
	a, desc, version, labels, err := h.loadCardAgent(r.Context(), name, callerTenant)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}
	if err != nil {
		h.logger().Error("a2a card lookup failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to fetch agent"})
		return
	}
	writeJSON(w, http.StatusOK, buildA2ACard(derivePublicURL(r), a, desc, version, labels))
}

// GetA2AAgentCard serves GET /v1/agents/{name}/a2a/.well-known/agent-card.json:
// the spec card a reference A2A client resolves from the base URL
// /v1/agents/{name}/a2a. Own agents (any visibility) or is_public; else 404.
func (h *A2AHandler) GetA2AAgentCard(w http.ResponseWriter, r *http.Request) {
	h.serveCard(w, r, r.PathValue("name"), h.callerTenant(r))
}

// WellKnownAgentCard serves GET /.well-known/agent-card.json. A PAL
// deployment hosts many agents, so the domain-level card is the operator's
// chosen default: PAL_A2A_DEFAULT_AGENT names a PUBLIC agent. Unset → 404
// pointing at the per-agent cards and the legacy directory.
func (h *A2AHandler) WellKnownAgentCard(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(os.Getenv("PAL_A2A_DEFAULT_AGENT"))
	if name == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error":     "no default agent configured (PAL_A2A_DEFAULT_AGENT)",
			"cards":     "/v1/agents/{name}/a2a/.well-known/agent-card.json",
			"directory": "/.well-known/agent.json",
		})
		return
	}
	h.serveCard(w, r, name, "") // anonymous: public agents only
}

// ---------- JSON-RPC 2.0 transport (spec §3.2, §7) ----------

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func rpcErr(code int, msg string) *rpcError { return &rpcError{Code: code, Message: msg} }

func rpcEnvelope(id json.RawMessage, result any, e *rpcError) map[string]any {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	m := map[string]any{"jsonrpc": "2.0", "id": id}
	if e != nil {
		m["error"] = e
	} else {
		m["result"] = result
	}
	return m
}

func writeRPC(w http.ResponseWriter, id json.RawMessage, result any, e *rpcError) {
	writeJSON(w, http.StatusOK, rpcEnvelope(id, result, e))
}

// writeRPCErr answers an error; for the streaming methods it is one SSE event
// (a streaming client expects text/event-stream even for an error).
func writeRPCErr(w http.ResponseWriter, req rpcRequest, e *rpcError) {
	if req.Method != "message/stream" && req.Method != "tasks/resubscribe" {
		writeRPC(w, req.ID, nil, e)
		return
	}
	b, _ := json.Marshal(rpcEnvelope(req.ID, nil, e))
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "data: %s\n\n", b)
}

// validRPCID: string, number or null (JSON-RPC 2.0 §4).
func validRPCID(id json.RawMessage) bool {
	if len(id) == 0 {
		return true
	}
	var v any
	if json.Unmarshal(id, &v) != nil {
		return false
	}
	switch v.(type) {
	case nil, string, float64:
		return true
	}
	return false
}

// A2A wire objects (only the fields PAL reads or writes).
type a2aPart struct {
	Kind string         `json:"kind"`
	Text string         `json:"text,omitempty"`
	Data map[string]any `json:"data,omitempty"`
	File any            `json:"file,omitempty"`
}

type a2aMessage struct {
	Kind      string    `json:"kind"`
	MessageID string    `json:"messageId"`
	Role      string    `json:"role"`
	Parts     []a2aPart `json:"parts"`
	ContextID string    `json:"contextId,omitempty"`
	TaskID    string    `json:"taskId,omitempty"`
}

type a2aTaskStatus struct {
	State     string      `json:"state"`
	Message   *a2aMessage `json:"message,omitempty"`
	Timestamp string      `json:"timestamp,omitempty"`
}

type a2aArtifact struct {
	ArtifactID string    `json:"artifactId"`
	Name       string    `json:"name,omitempty"`
	Parts      []a2aPart `json:"parts"`
}

type a2aTask struct {
	Kind      string        `json:"kind"`
	ID        string        `json:"id"`
	ContextID string        `json:"contextId"`
	Status    a2aTaskStatus `json:"status"`
	Artifacts []a2aArtifact `json:"artifacts,omitempty"`
	History   []a2aMessage  `json:"history"`
}

// trimHistory keeps the n most recent history messages (spec historyLength).
func (t a2aTask) trimHistory(n *int) a2aTask {
	if n != nil && *n >= 0 && len(t.History) > *n {
		t.History = t.History[len(t.History)-*n:]
	}
	return t
}

// JSONRPC serves POST /v1/agents/{name}/a2a.
func (h *A2AHandler) JSONRPC(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, a2aMaxBody+1))
	if err != nil || len(raw) > a2aMaxBody {
		writeRPC(w, nil, nil, rpcErr(rpcInvalidRequest, "request body too large or unreadable"))
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		writeRPC(w, nil, nil, rpcErr(rpcParseError, "invalid JSON"))
		return
	}
	if !validRPCID(req.ID) {
		writeRPC(w, nil, nil, rpcErr(rpcInvalidRequest, "id must be a string, number or null"))
		return
	}
	if req.JSONRPC != "2.0" || req.Method == "" {
		writeRPCErr(w, req, rpcErr(rpcInvalidRequest, "not a JSON-RPC 2.0 request"))
		return
	}
	switch req.Method {
	case "message/send", "message/stream", "tasks/get", "tasks/cancel", "tasks/resubscribe":
	case "tasks/pushNotificationConfig/set", "tasks/pushNotificationConfig/get",
		"tasks/pushNotificationConfig/list", "tasks/pushNotificationConfig/delete":
		writeRPCErr(w, req, rpcErr(a2aPushNotSupported, "Push Notification is not supported"))
		return
	case "agent/getAuthenticatedExtendedCard":
		writeRPCErr(w, req, rpcErr(a2aNoExtendedCard, "Authenticated Extended Card not configured"))
		return
	default:
		writeRPCErr(w, req, rpcErr(rpcMethodNotFound, "Method not found"))
		return
	}

	invoke := req.Method == "message/send" || req.Method == "message/stream"
	call, ok := h.authorizeA2ACall(w, r, r.PathValue("name"), invoke)
	if !ok {
		return
	}
	switch req.Method {
	case "message/send", "message/stream":
		h.rpcMessage(w, r, req, call)
	case "tasks/get", "tasks/resubscribe":
		var p struct {
			ID            string `json:"id"`
			HistoryLength *int   `json:"historyLength"`
		}
		if json.Unmarshal(req.Params, &p) != nil || p.ID == "" || (p.HistoryLength != nil && *p.HistoryLength < 0) {
			writeRPCErr(w, req, rpcErr(rpcInvalidParams, "params.id is required; historyLength must be >= 0"))
			return
		}
		t, ok := h.loadTask(r.Context(), call, p.ID)
		if !ok {
			writeRPCErr(w, req, rpcErr(a2aTaskNotFound, "Task not found"))
			return
		}
		if req.Method == "tasks/get" {
			writeRPC(w, req.ID, t.trimHistory(p.HistoryLength), nil)
			return
		}
		h.streamTask(w, r, req.ID, call, t, false)
	case "tasks/cancel":
		h.rpcCancel(w, r, req, call)
	}
}

// parseA2AInput turns message parts into run input: text parts join into
// input.message (what every PAL agent reads); data parts land in input.data.
func parseA2AInput(m a2aMessage) (map[string]any, *rpcError) {
	if m.MessageID == "" || m.Role != "user" || len(m.Parts) == 0 {
		return nil, rpcErr(rpcInvalidParams, "message requires messageId, role \"user\" and at least one part")
	}
	var texts []string
	var data []any
	for _, p := range m.Parts {
		switch p.Kind {
		case "text":
			texts = append(texts, p.Text)
		case "data":
			data = append(data, p.Data)
		case "file":
			return nil, rpcErr(a2aContentType, "file parts are not supported; send text or data parts")
		default:
			return nil, rpcErr(rpcInvalidParams, fmt.Sprintf("unknown part kind %q", p.Kind))
		}
	}
	input := map[string]any{"message": strings.Join(texts, "\n")}
	switch len(data) {
	case 0:
	case 1:
		input["data"] = data[0]
	default:
		input["data"] = data
	}
	return input, nil
}

func (h *A2AHandler) rpcMessage(w http.ResponseWriter, r *http.Request, req rpcRequest, call a2aCall) {
	var p struct {
		Message       a2aMessage `json:"message"`
		Configuration *struct {
			Blocking               *bool `json:"blocking"`
			HistoryLength          *int  `json:"historyLength"`
			PushNotificationConfig any   `json:"pushNotificationConfig"`
		} `json:"configuration"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		writeRPCErr(w, req, rpcErr(rpcInvalidParams, "invalid params"))
		return
	}
	if p.Configuration != nil && p.Configuration.HistoryLength != nil && *p.Configuration.HistoryLength < 0 {
		writeRPCErr(w, req, rpcErr(rpcInvalidParams, "historyLength must be >= 0"))
		return
	}
	if p.Configuration != nil && p.Configuration.PushNotificationConfig != nil {
		writeRPCErr(w, req, rpcErr(a2aPushNotSupported, "Push Notification is not supported"))
		return
	}
	if p.Message.TaskID != "" {
		// Multi-turn continuation (input-required) is not implemented: PAL
		// runs never enter input-required. An unknown id is still TaskNotFound.
		if _, ok := h.loadTask(r.Context(), call, p.Message.TaskID); !ok {
			writeRPCErr(w, req, rpcErr(a2aTaskNotFound, "Task not found"))
			return
		}
		writeRPCErr(w, req, rpcErr(a2aUnsupportedOp, "continuing an existing task is not supported; send a new message without taskId"))
		return
	}
	input, perr := parseA2AInput(p.Message)
	if perr != nil {
		writeRPCErr(w, req, perr)
		return
	}
	ctx := r.Context()
	contextID := p.Message.ContextID
	if contextID == "" {
		contextID = uuid.NewString()
	}

	// Replay: the same caller re-sending the same messageId to the same agent
	// gets the existing task back, not a second run.
	// ponytail: read-then-insert, so two truly concurrent duplicates can both
	// create a run; use runs.idempotency_key if that ever matters.
	runID, err := h.findTaskByMessage(ctx, call, p.Message.MessageID)
	if err != nil {
		writeRPCErr(w, req, rpcErr(rpcInternal, "task lookup failed"))
		return
	}
	if runID == "" {
		var rerr *rpcError
		runID, rerr = h.startA2ARun(ctx, call, input, map[string]any{
			"messageId": p.Message.MessageID, "contextId": contextID, "message": p.Message,
			"caller": call.callerID, "callerTenant": call.callerTenant,
		})
		if rerr != nil {
			writeRPCErr(w, req, rerr)
			return
		}
	}

	t, ok := h.loadTask(ctx, call, runID)
	if !ok {
		writeRPCErr(w, req, rpcErr(rpcInternal, "task vanished"))
		return
	}
	if req.Method == "message/stream" {
		h.streamTask(w, r, req.ID, call, t, true)
		return
	}
	// Non-blocking unless the client asks (spec: "If true, the client will wait").
	var hl *int
	if p.Configuration != nil {
		hl = p.Configuration.HistoryLength
		if p.Configuration.Blocking != nil && *p.Configuration.Blocking {
			t = h.waitTask(ctx, call, t)
		}
	}
	writeRPC(w, req.ID, t.trimHistory(hl), nil)
}

// startA2ARun creates the run on the TARGET tenant (its keys, its budgets —
// same pattern as marketplace invoke) and hands it to the inline executor.
func (h *A2AHandler) startA2ARun(ctx context.Context, call a2aCall, input, meta map[string]any) (string, *rpcError) {
	if h.rest == nil || h.runSvc == nil {
		return "", rpcErr(rpcInternal, "A2A execution is not wired on this server")
	}
	tenant := call.target.TenantID
	if bc := CheckBudget(ctx, h.srv.Pool, tenant, call.target.Name, 0); !bc.Allowed && bc.HardFail {
		return "", &rpcError{Code: rpcInternal, Message: "agent budget limit reached", Data: map[string]string{"code": "budget_exceeded"}}
	}
	agentCtx := middleware.InjectTenantID(context.WithoutCancel(ctx), tenant)
	agentCtx = metadata.NewIncomingContext(agentCtx, metadata.Pairs("tenant_id", tenant))
	in, err := structpb.NewStruct(input)
	if err != nil {
		return "", rpcErr(rpcInvalidParams, "data parts must be JSON objects")
	}
	// JSON round-trip: structpb only takes plain maps/slices.
	var metaMap map[string]any
	mb, _ := json.Marshal(map[string]any{"a2a": meta})
	_ = json.Unmarshal(mb, &metaMap)
	tm, err := structpb.NewStruct(metaMap)
	if err != nil {
		return "", rpcErr(rpcInternal, "failed to record task metadata")
	}
	run, err := h.runSvc.CreateRun(agentCtx, &palv1.CreateRunRequest{
		AgentName: call.target.Name, Input: in, TriggerMeta: tm,
		TriggerKind: palv1.TriggerKind_TRIGGER_KIND_A2A,
	})
	if err != nil {
		h.logger().Warn("a2a: CreateRun failed", zap.String("agent", call.target.Name), zap.String("tenant_id", tenant), zap.Error(err))
		if status.Code(err) == codes.FailedPrecondition {
			return "", rpcErr(a2aUnsupportedOp, "agent has no promoted version")
		}
		return "", rpcErr(rpcInternal, "failed to start task")
	}
	runID := run.GetId()
	h.logger().Info("a2a: task created", zap.String("agent", call.target.Name), zap.String("tenant_id", tenant),
		zap.String("caller", call.callerID), zap.String("run_id", runID))
	h.rest.inFlightRuns.Add(1)
	go func() {
		defer h.rest.inFlightRuns.Done()
		h.rest.executeRunInline(runID, tenant, call.target.Name, input)
	}()
	return runID, nil
}

func (h *A2AHandler) findTaskByMessage(ctx context.Context, call a2aCall, messageID string) (string, error) {
	var id string
	// rls-exempt: cross-tenant A2A — the run lives on the target's tenant and is
	// scoped by (tenant_id, agent_id) plus the stored caller, never by the caller.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT id::text FROM runs
		WHERE tenant_id = $1 AND agent_id = $2 AND trigger_kind = 'a2a'
		  AND trigger_meta->'a2a'->>'messageId' = $3 AND trigger_meta->'a2a'->>'caller' = $4
		ORDER BY created_at LIMIT 1`, call.target.TenantID, call.target.ID, messageID, call.callerID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// a2aState maps a PAL run status onto the A2A TaskState.
func a2aState(runStatus string) string {
	switch runStatus {
	case "queued":
		return "submitted"
	case "running", "paused", "waiting":
		return "working"
	case "succeeded":
		return "completed"
	case "failed":
		return "failed"
	case "cancelled":
		return "canceled"
	}
	return "unknown"
}

func a2aTerminal(state string) bool {
	switch state {
	case "completed", "failed", "canceled", "rejected":
		return true
	}
	return false
}

// loadTask reads a task the caller may see: a run of THIS target agent,
// created over A2A, whose stored caller is this caller — or any A2A task of
// the agent when the caller is the owning tenant (a human/API key, not an
// agent). Everything else is TaskNotFound: a task id is never an oracle for
// another caller's or tenant's runs.
func (h *A2AHandler) loadTask(ctx context.Context, call a2aCall, id string) (a2aTask, bool) {
	if _, err := uuid.Parse(id); err != nil {
		return a2aTask{}, false
	}
	var (
		st, caller, contextID string
		out, errRaw, msgRaw   []byte
		updated               time.Time
	)
	// rls-exempt: cross-tenant A2A — scoped by the target's tenant_id + agent_id
	// and the stored caller principal (checked below).
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT status, COALESCE(trigger_meta->'a2a'->>'caller', ''), COALESCE(trigger_meta->'a2a'->>'contextId', ''),
		       COALESCE(output, 'null'::jsonb), COALESCE(error, 'null'::jsonb),
		       COALESCE(trigger_meta->'a2a'->'message', 'null'::jsonb),
		       COALESCE(finished_at, started_at, created_at)
		FROM runs WHERE id = $1 AND tenant_id = $2 AND agent_id = $3 AND trigger_kind = 'a2a'`,
		id, call.target.TenantID, call.target.ID).Scan(&st, &caller, &contextID, &out, &errRaw, &msgRaw, &updated)
	if err != nil {
		return a2aTask{}, false
	}
	owner := !call.isAgent && call.callerTenant == call.target.TenantID
	if caller != call.callerID && !owner {
		return a2aTask{}, false
	}
	t := a2aTask{Kind: "task", ID: id, ContextID: contextID,
		Status: a2aTaskStatus{State: a2aState(st), Timestamp: updated.UTC().Format(time.RFC3339Nano)}, History: []a2aMessage{}}
	// History is the caller's message, then the agent's reply once there is one.
	var userMsg a2aMessage
	if json.Unmarshal(msgRaw, &userMsg) == nil && userMsg.MessageID != "" {
		userMsg.Kind, userMsg.TaskID, userMsg.ContextID = "message", id, contextID
		t.History = append(t.History, userMsg)
	}
	switch t.Status.State {
	case "completed":
		parts := outputParts(out)
		t.Artifacts = []a2aArtifact{{ArtifactID: id + "-output", Name: "output", Parts: parts}}
		t.History = append(t.History, a2aMessage{Kind: "message", MessageID: id + "-reply", Role: "agent",
			Parts: parts, TaskID: id, ContextID: contextID})
	case "failed":
		t.Status.Message = &a2aMessage{Kind: "message", MessageID: id + "-error", Role: "agent",
			Parts: []a2aPart{{Kind: "text", Text: runErrorText(errRaw)}}, TaskID: id, ContextID: contextID}
	}
	return t, true
}

// outputParts renders a run output: the usual text keys become a TextPart,
// anything else a DataPart.
func outputParts(raw []byte) []a2aPart {
	var v any
	_ = json.Unmarshal(raw, &v)
	if m, ok := v.(map[string]any); ok {
		for _, k := range []string{"result", "text", "output", "response"} {
			if s, ok := m[k].(string); ok && len(m) == 1 {
				return []a2aPart{{Kind: "text", Text: s}}
			}
		}
		return []a2aPart{{Kind: "data", Data: m}}
	}
	if s, ok := v.(string); ok {
		return []a2aPart{{Kind: "text", Text: s}}
	}
	return []a2aPart{{Kind: "data", Data: map[string]any{"value": v}}}
}

func runErrorText(raw []byte) string {
	var v any
	if json.Unmarshal(raw, &v) == nil {
		if m, ok := v.(map[string]any); ok {
			if s, ok := m["message"].(string); ok && s != "" {
				return truncate(s, 2000)
			}
		}
		if s, ok := v.(string); ok && s != "" {
			return truncate(s, 2000)
		}
	}
	return "agent run failed"
}

// waitTask holds a blocking message/send; it shares the per-caller stream cap
// (over the cap it returns the task as-is, i.e. non-blocking).
func (h *A2AHandler) waitTask(ctx context.Context, call a2aCall, t a2aTask) a2aTask {
	release, ok := acquireA2AStream(call.callerID)
	if !ok {
		return t
	}
	defer release()
	deadline := time.Now().Add(a2aBlockingWait)
	for !a2aTerminal(t.Status.State) && time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return t
		case <-time.After(a2aPoll):
		}
		if nt, ok := h.loadTask(ctx, call, t.ID); ok {
			t = nt
		}
	}
	return t
}

// a2aMaxStreamsPerCaller caps open SSE streams per caller principal: each one
// holds a goroutine and polls the runs table for up to a2aBlockingWait.
// ponytail: per-process counter; a multi-replica deployment allows N×replicas.
const a2aMaxStreamsPerCaller = 8

var a2aStreams = struct {
	sync.Mutex
	n map[string]int
}{n: map[string]int{}}

func acquireA2AStream(caller string) (func(), bool) {
	a2aStreams.Lock()
	defer a2aStreams.Unlock()
	if a2aStreams.n[caller] >= a2aMaxStreamsPerCaller {
		return nil, false
	}
	a2aStreams.n[caller]++
	return func() {
		a2aStreams.Lock()
		defer a2aStreams.Unlock()
		if a2aStreams.n[caller]--; a2aStreams.n[caller] <= 0 {
			delete(a2aStreams.n, caller)
		}
	}, true
}

// streamTask serves message/stream and tasks/resubscribe as SSE (spec §7.2):
// each event is a JSON-RPC response whose result is the Task (first), then a
// TaskStatusUpdateEvent per state change, a TaskArtifactUpdateEvent with the
// output, and a final status-update with final=true. Events are flushed as
// they happen (invariant #4).
func (h *A2AHandler) streamTask(w http.ResponseWriter, r *http.Request, id json.RawMessage, call a2aCall, t a2aTask, sendTask bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeRPC(w, id, nil, rpcErr(rpcInternal, "streaming unsupported"))
		return
	}
	release, ok := acquireA2AStream(call.callerID)
	if !ok {
		writeRPCErr(w, rpcRequest{ID: id, Method: "message/stream"}, &rpcError{Code: rpcInternal,
			Message: fmt.Sprintf("too many concurrent A2A streams for this caller (max %d)", a2aMaxStreamsPerCaller)})
		return
	}
	defer release()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	emit := func(result any) {
		b, _ := json.Marshal(rpcEnvelope(id, result, nil))
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}
	statusEvent := func(t a2aTask, final bool) map[string]any {
		return map[string]any{"kind": "status-update", "taskId": t.ID, "contextId": t.ContextID, "status": t.Status, "final": final}
	}
	if sendTask {
		emit(t)
	} else {
		if a2aTerminal(t.Status.State) {
			for _, a := range t.Artifacts {
				emit(map[string]any{"kind": "artifact-update", "taskId": t.ID, "contextId": t.ContextID, "artifact": a, "lastChunk": true})
			}
			emit(statusEvent(t, true))
			return
		}
		emit(statusEvent(t, false))
	}
	ctx := r.Context()
	last := t.Status.State
	deadline := time.Now().Add(a2aBlockingWait)
	for !a2aTerminal(last) {
		if time.Now().After(deadline) {
			return // client resubscribes; the task keeps running
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(a2aPoll):
		}
		nt, ok := h.loadTask(ctx, call, t.ID)
		if !ok || nt.Status.State == last {
			continue
		}
		last = nt.Status.State
		if a2aTerminal(last) {
			for _, a := range nt.Artifacts {
				emit(map[string]any{"kind": "artifact-update", "taskId": nt.ID, "contextId": nt.ContextID, "artifact": a, "lastChunk": true})
			}
		}
		emit(statusEvent(nt, a2aTerminal(last)))
	}
}

func (h *A2AHandler) rpcCancel(w http.ResponseWriter, r *http.Request, req rpcRequest, call a2aCall) {
	var p struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(req.Params, &p) != nil || p.ID == "" {
		writeRPCErr(w, req, rpcErr(rpcInvalidParams, "params.id is required"))
		return
	}
	ctx := r.Context()
	t, ok := h.loadTask(ctx, call, p.ID)
	if !ok {
		writeRPCErr(w, req, rpcErr(a2aTaskNotFound, "Task not found"))
		return
	}
	if a2aTerminal(t.Status.State) || h.runSvc == nil {
		writeRPCErr(w, req, rpcErr(a2aTaskNotCancelable, "Task cannot be canceled"))
		return
	}
	// The same cancel path as POST /v1/runs/{id}/cancel, on the run's tenant.
	tctx := middleware.InjectTenantID(ctx, call.target.TenantID)
	if _, err := h.runSvc.CancelRun(tctx, &palv1.CancelRunRequest{Id: p.ID, Reason: "a2a tasks/cancel by " + call.callerID}); err != nil {
		if status.Code(err) == codes.FailedPrecondition {
			writeRPCErr(w, req, rpcErr(a2aTaskNotCancelable, "Task cannot be canceled"))
			return
		}
		h.logger().Error("a2a: cancel failed", zap.String("run_id", p.ID), zap.Error(err))
		writeRPCErr(w, req, rpcErr(rpcInternal, "cancel failed"))
		return
	}
	t, _ = h.loadTask(ctx, call, p.ID)
	writeRPC(w, req.ID, t, nil)
}
