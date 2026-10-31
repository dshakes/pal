package handlers

// PAL as an MCP server (ADR 0058, spec 2025-06-18).
//
// Streamable HTTP at POST /mcp, stateless (no Mcp-Session-Id, no server
// stream: GET/DELETE answer 405 as the spec permits). PAL is an OAuth 2.1
// resource server here:
//   - Bearer only (Authorization header). The token must be a PAL API key that
//     carries the explicit "mcp" scope (or "admin"). That scope IS the audience
//     binding: a key minted for the REST API (even an unrestricted legacy key)
//     is not accepted, and dashboard session JWTs (no audience) never are.
//   - 401 carries WWW-Authenticate with resource_metadata (RFC 9728), served at
//     /.well-known/oauth-protected-resource[/mcp].
//   - tools/list returns only the tools the key's scopes allow; tools/call
//     re-checks, so listing is a convenience and never the gate.
//   - Tenant = the key's tenant. Every query is tenant-scoped.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/mcp"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
)

// ScopeMCP is required (explicitly) on an API key used at /mcp.
const ScopeMCP Scope = "mcp"

const (
	mcpServerMaxBody    = 1 << 20
	mcpRunWaitDefault   = 60 * time.Second
	mcpRunWaitMax       = 120 * time.Second
	mcpExposeLabel      = "mcp"
	mcpExposeLabelValue = "expose"
)

var mcpServerVersions = []string{"2025-06-18", "2025-03-26"}

// mcpBaseURL is the externally visible origin of this control-plane.
func mcpBaseURL(r *http.Request) string { return derivePublicURL(r) }

// ProtectedResourceMetadata serves RFC 9728 metadata for /mcp.
func (h *MCPHandler) ProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	base := mcpBaseURL(r)
	doc := map[string]any{
		"resource":                 base + "/mcp",
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{ScopeMCP, ScopeAgentsRead, ScopeRunsRead, ScopeRunsExecute},
		"resource_name":            "PAL",
		"resource_documentation":   base + "/docs/mcp",
	}
	// PAL issues API keys itself; an external OAuth 2.1 authorization server
	// that mints PAL-audience tokens is configured explicitly (ADR 0058).
	if as := strings.TrimSpace(os.Getenv("PAL_MCP_AUTHORIZATION_SERVERS")); as != "" {
		doc["authorization_servers"] = strings.Split(as, ",")
	}
	w.Header().Set("Cache-Control", "max-age=300")
	writeJSON(w, http.StatusOK, doc)
}

func (h *MCPHandler) mcpChallenge(w http.ResponseWriter, r *http.Request, status int, oauthErr, desc string) {
	v := fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource/mcp", scope="%s"`, mcpBaseURL(r), ScopeMCP)
	if oauthErr != "" {
		v += fmt.Sprintf(`, error="%s", error_description="%s"`, oauthErr, desc)
	}
	w.Header().Set("WWW-Authenticate", v)
	writeJSON(w, status, map[string]string{"error": oauthErr, "error_description": desc})
}

// mcpOriginAllowed implements the transport's DNS-rebinding defence: a request
// carrying an Origin must come from an allowed origin. Non-browser clients
// send no Origin.
func mcpOriginAllowed(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	allowed := []string{}
	for _, v := range strings.Split(os.Getenv("PAL_MCP_ALLOWED_ORIGINS"), ",") {
		if v = strings.TrimRight(strings.TrimSpace(v), "/"); v != "" {
			allowed = append(allowed, v)
		}
	}
	if d := strings.TrimRight(strings.TrimSpace(os.Getenv("PAL_DASHBOARD_URL")), "/"); d != "" {
		allowed = append(allowed, d)
	}
	if !isProd() {
		if u, err := url.Parse(o); err == nil && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1") {
			return true
		}
	}
	return slices.Contains(allowed, strings.TrimRight(o, "/"))
}

// mcpCaller authenticates a /mcp request.
func (h *MCPHandler) mcpCaller(r *http.Request) (*PalClaims, string, string) {
	authz := r.Header.Get("Authorization")
	if authz == "" {
		return nil, "", ""
	}
	scheme, tok, ok := strings.Cut(authz, " ")
	if !ok || !strings.EqualFold(scheme, "bearer") || !strings.HasPrefix(strings.TrimSpace(tok), "hlx_live_") {
		return nil, "invalid_token", "only PAL API keys with the mcp scope are accepted"
	}
	c, err := h.auth.validateAPIKey(r.Context(), strings.TrimSpace(tok))
	if err != nil {
		return nil, "invalid_token", "unknown, revoked or expired key"
	}
	if !slices.Contains(c.Scopes, ScopeMCP) && !slices.Contains(c.Scopes, ScopeAdmin) {
		return nil, "invalid_token", "key was not issued for MCP (needs the mcp scope)"
	}
	return c, "", ""
}

// ServeMCP handles /mcp.
func (h *MCPHandler) ServeMCP(w http.ResponseWriter, r *http.Request) {
	if !mcpOriginAllowed(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "origin not allowed"})
		return
	}
	claims, oauthErr, desc := h.mcpCaller(r)
	if claims == nil {
		h.mcpChallenge(w, r, http.StatusUnauthorized, oauthErr, desc)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if v := r.Header.Get("MCP-Protocol-Version"); v != "" && !slices.Contains(mcpServerVersions, v) {
		writeJSON(w, http.StatusBadRequest, rpcErr(nil, -32600, "unsupported MCP-Protocol-Version"))
		return
	}
	accept := r.Header.Get("Accept")
	if accept != "" && !strings.Contains(accept, "application/json") && !strings.Contains(accept, "*/*") {
		writeJSON(w, http.StatusNotAcceptable, rpcErr(nil, -32600, "Accept must include application/json"))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, mcpServerMaxBody))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, rpcErr(nil, -32600, "request too large"))
		return
	}
	body = bytes.TrimSpace(body)
	if len(body) > 0 && body[0] == '[' {
		// JSON-RPC batching was removed in 2025-06-18.
		writeJSON(w, http.StatusBadRequest, rpcErr(nil, -32600, "batch requests are not supported"))
		return
	}
	var msg struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &msg); err != nil || msg.JSONRPC != "2.0" {
		writeJSON(w, http.StatusBadRequest, rpcErr(nil, -32700, "parse error"))
		return
	}
	if msg.Method == "" || len(msg.ID) == 0 || string(msg.ID) == "null" {
		// Notification or a response to a request we never send.
		w.WriteHeader(http.StatusAccepted)
		return
	}
	ctx := storeClaimsInCtx(middleware.InjectTenantID(r.Context(), claims.TenantID), claims)
	result, rerr := h.mcpDispatch(ctx, r, claims, msg.Method, msg.Params)
	if rerr != nil {
		writeJSON(w, http.StatusOK, rpcErr(msg.ID, rerr.Code, rerr.Message))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
}

func rpcErr(id json.RawMessage, code int, msg string) map[string]any {
	if id == nil {
		id = json.RawMessage("null")
	}
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": msg}}
}

func (h *MCPHandler) mcpDispatch(ctx context.Context, r *http.Request, c *PalClaims, method string, params json.RawMessage) (any, *mcp.RPCError) {
	switch method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(params, &p)
		v := mcp.ProtocolVersion
		if slices.Contains(mcpServerVersions, p.ProtocolVersion) {
			v = p.ProtocolVersion
		}
		return map[string]any{
			"protocolVersion": v,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "pal", "title": "PAL", "version": "1"},
			"instructions":    "PAL agent runtime. Tools are limited to what your API key's scopes allow.",
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		tools, err := h.mcpServerTools(ctx, c)
		if err != nil {
			h.logger().Error("mcp server tools/list failed", zap.String("tenant_id", c.TenantID), zap.Error(err))
			return nil, &mcp.RPCError{Code: -32603, Message: "internal error"}
		}
		out := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			out = append(out, t.def)
		}
		return map[string]any{"tools": out}, nil
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(params, &p); err != nil || p.Name == "" {
			return nil, &mcp.RPCError{Code: -32602, Message: "invalid params"}
		}
		tools, err := h.mcpServerTools(ctx, c)
		if err != nil {
			return nil, &mcp.RPCError{Code: -32603, Message: "internal error"}
		}
		for _, t := range tools {
			if t.name == p.Name {
				res, err := t.call(ctx, r, p.Arguments)
				if err != nil {
					return mcpToolError(err.Error()), nil
				}
				return mcpToolText(res), nil
			}
		}
		return nil, &mcp.RPCError{Code: -32602, Message: "unknown tool: " + clipString(p.Name, 80)}
	}
	return nil, &mcp.RPCError{Code: -32601, Message: "method not found"}
}

func mcpToolText(v any) map[string]any {
	b, _ := json.Marshal(v)
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": string(b)}}, "structuredContent": v}
}

func mcpToolError(msg string) map[string]any {
	return map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": msg}}}
}

type palMCPTool struct {
	name string
	def  map[string]any
	call func(ctx context.Context, r *http.Request, args map[string]any) (any, error)
}

func palToolDef(name, title, desc string, schema map[string]any, readOnly bool) map[string]any {
	return map[string]any{"name": name, "title": title, "description": desc, "inputSchema": schema,
		"annotations": map[string]any{"readOnlyHint": readOnly, "openWorldHint": false}}
}

func obj(props map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

// mcpServerTools is the caller's tool set: PAL management tools gated by
// scope, plus one tool per agent labelled mcp=expose when runs:execute is held.
func (h *MCPHandler) mcpServerTools(ctx context.Context, c *PalClaims) ([]palMCPTool, error) {
	var out []palMCPTool
	str := map[string]any{"type": "string"}
	if HasScope(c, ScopeAgentsRead) {
		out = append(out, palMCPTool{name: "list_agents",
			def: palToolDef("list_agents", "List agents", "List the agents in this PAL workspace.", obj(map[string]any{}), true),
			call: func(ctx context.Context, _ *http.Request, _ map[string]any) (any, error) {
				return h.mcpListAgents(ctx, c.TenantID)
			}})
	}
	if HasScope(c, ScopeRunsRead) {
		out = append(out, palMCPTool{name: "get_run",
			def: palToolDef("get_run", "Get run", "Status, output and cost of one run.", obj(map[string]any{"runId": str}, "runId"), true),
			call: func(ctx context.Context, _ *http.Request, a map[string]any) (any, error) {
				id, _ := a["runId"].(string)
				return h.mcpGetRun(ctx, c.TenantID, id)
			}})
	}
	if !HasScope(c, ScopeRunsExecute) {
		return out, nil
	}
	input := map[string]any{"description": "Input for the agent: a message string or a JSON object."}
	wait := map[string]any{"type": "integer", "minimum": 0, "maximum": int(mcpRunWaitMax / time.Second), "description": "Seconds to wait for completion (default 60)."}
	out = append(out, palMCPTool{name: "run_agent",
		def: palToolDef("run_agent", "Run agent", "Start a run of a PAL agent and wait for its result.",
			obj(map[string]any{"agent": str, "input": input, "waitSeconds": wait}, "agent"), false),
		call: func(ctx context.Context, r *http.Request, a map[string]any) (any, error) {
			name, _ := a["agent"].(string)
			return h.mcpRunAgent(ctx, r, c, name, a["input"], a["waitSeconds"])
		}})
	exposed, err := h.mcpExposedAgents(ctx, c.TenantID)
	if err != nil {
		return nil, err
	}
	for _, ag := range exposed {
		name, ok := mcpAgentToolName(ag.name)
		if !ok {
			continue
		}
		desc := ag.description
		if desc == "" {
			desc = "Run the PAL agent " + ag.name + "."
		}
		agentName := ag.name
		out = append(out, palMCPTool{name: name,
			def: palToolDef(name, "Agent: "+ag.name, clipString(desc, 1024), obj(map[string]any{"input": input, "waitSeconds": wait}), false),
			call: func(ctx context.Context, r *http.Request, a map[string]any) (any, error) {
				return h.mcpRunAgent(ctx, r, c, agentName, a["input"], a["waitSeconds"])
			}})
	}
	return out, nil
}

func mcpAgentToolName(agent string) (string, bool) {
	n := "agent_" + strings.ReplaceAll(agent, ".", "_")
	return n, mcpToolNameRe.MatchString(n)
}

type exposedAgent struct{ name, description string }

func (h *MCPHandler) mcpExposedAgents(ctx context.Context, tenantID string) ([]exposedAgent, error) {
	var out []exposedAgent
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT name, COALESCE(description, '') FROM agents
			WHERE tenant_id = $1 AND archived_at IS NULL AND labels->>$2 = $3 ORDER BY name LIMIT 100`,
			tenantID, mcpExposeLabel, mcpExposeLabelValue)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var a exposedAgent
			if err := rows.Scan(&a.name, &a.description); err != nil {
				return err
			}
			out = append(out, a)
		}
		return rows.Err()
	})
	return out, err
}

func (h *MCPHandler) mcpListAgents(ctx context.Context, tenantID string) (any, error) {
	var out []map[string]any
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT name, COALESCE(description, ''), COALESCE(labels->>$2, '') = $3 FROM agents
			WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY name LIMIT 200`, tenantID, mcpExposeLabel, mcpExposeLabelValue)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var n, d string
			var exposed bool
			if err := rows.Scan(&n, &d, &exposed); err != nil {
				return err
			}
			out = append(out, map[string]any{"name": n, "description": d, "exposedAsTool": exposed})
		}
		return rows.Err()
	})
	return map[string]any{"agents": out}, err
}

func (h *MCPHandler) mcpGetRun(ctx context.Context, tenantID, runID string) (any, error) {
	var (
		status, agent string
		output, errJS []byte
		cost          float64
	)
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT r.status, a.name, r.output, r.error, r.cost_usd::float8
			FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.id::text = $1 AND r.tenant_id = $2`, runID, tenantID).
			Scan(&status, &agent, &output, &errJS, &cost)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("run not found")
	}
	if err != nil {
		return nil, errors.New("run lookup failed")
	}
	res := map[string]any{"runId": runID, "agent": agent, "status": status, "costUsd": cost}
	if len(output) > 0 {
		res["output"] = json.RawMessage(output)
	}
	if len(errJS) > 0 {
		res["error"] = json.RawMessage(errJS)
	}
	return res, nil
}

// mcpRunAgent starts a run through RESTHandler.CreateRun — the same path as
// POST /v1/runs, so budgets (402), spawn limits, agent identity and policy all
// apply — with the CALLER's claims, then waits for a terminal status.
func (h *MCPHandler) mcpRunAgent(ctx context.Context, r *http.Request, c *PalClaims, agent string, input, waitArg any) (any, error) {
	if h.rest == nil {
		return nil, errors.New("run execution is not wired")
	}
	if agent == "" {
		return nil, errors.New("agent is required")
	}
	in, ok := input.(map[string]any)
	if !ok {
		in = map[string]any{}
		if s, isStr := input.(string); isStr && s != "" {
			in["message"] = s
		}
	}
	wait := mcpRunWaitDefault
	if f, ok := waitArg.(float64); ok && f >= 0 {
		wait = time.Duration(f) * time.Second
		if wait > mcpRunWaitMax {
			wait = mcpRunWaitMax
		}
	}
	b, _ := json.Marshal(map[string]any{"agentName": agent, "input": in})
	req, err := http.NewRequestWithContext(storeClaimsInCtx(ctx, c), http.MethodPost, "/v1/runs", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", r.Header.Get("Authorization"))
	rec := httptest.NewRecorder()
	h.rest.CreateRun(rec, req)
	var created map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	if rec.Code/100 != 2 {
		msg, _ := created["error"].(string)
		if msg == "" {
			msg = http.StatusText(rec.Code)
		}
		return nil, fmt.Errorf("run not started (%d): %s", rec.Code, clipString(msg, 200))
	}
	runID, _ := created["id"].(string)
	if runID == "" {
		runID, _ = created["runId"].(string)
	}
	if runID == "" {
		return nil, errors.New("run not started: no run id returned")
	}
	deadline := time.Now().Add(wait)
	for {
		res, err := h.mcpGetRun(ctx, c.TenantID, runID)
		if err != nil {
			return nil, err
		}
		st, _ := res.(map[string]any)["status"].(string)
		if isRunTerminal(st) || !time.Now().Before(deadline) {
			return res, nil
		}
		select {
		case <-ctx.Done():
			return res, nil
		case <-time.After(500 * time.Millisecond):
		}
	}
}
