// Package mcp is PAL's Model Context Protocol client (spec revision
// 2025-06-18, ADR 0058): JSON-RPC lifecycle, tools/list + tools/call, the
// Streamable HTTP transport, a one-shot stdio transport that only ever runs
// inside a tenant microVM (invariant #5), and the OAuth 2.1 helpers the
// authorization section requires (RFC 9728, RFC 8414, RFC 7591, PKCE, RFC 8707).
//
// The package does no persistence and no policy: callers (internal/handlers)
// decide which server an agent may reach and store credentials encrypted.
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ProtocolVersion is the revision PAL speaks and asks for.
const ProtocolVersion = "2025-06-18"

// supportedVersions are the revisions whose tools surface is identical to ours;
// a server answering initialize with anything else is refused.
var supportedVersions = map[string]bool{"2025-06-18": true, "2025-03-26": true}

// Limits. A tools/list larger than this is a broken or hostile server.
const (
	MaxTools          = 256
	maxListPages      = 20
	DefaultMaxRespLen = 1 << 20 // 1 MiB per JSON-RPC response
)

// ClientName / ClientVersion go into initialize.clientInfo.
var (
	ClientName    = "pal"
	ClientVersion = "1"
)

// Transport carries one JSON-RPC request and returns its result. Implementations
// own initialization (it is per-connection on HTTP, per-exec on stdio).
type Transport interface {
	Call(ctx context.Context, method string, params any) (json.RawMessage, error)
	Close(ctx context.Context) error
}

// RPCError is a JSON-RPC error object returned by the server.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("mcp: server error %d: %s", e.Code, clip(e.Message, 200))
}

// ErrResponseTooLarge is returned when a response exceeds the size cap.
var ErrResponseTooLarge = errors.New("mcp: response exceeds size cap")

// ErrUnsupportedVersion is returned when initialize negotiates a revision PAL
// does not speak.
var ErrUnsupportedVersion = errors.New("mcp: server negotiated an unsupported protocol version")

// Tool is one entry of tools/list.
type Tool struct {
	Name        string          `json:"name"`
	Title       string          `json:"title,omitempty"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Annotations json.RawMessage `json:"annotations,omitempty"`
}

// Content is one block of a tools/call result.
type Content struct {
	Type     string          `json:"type"`
	Text     string          `json:"text,omitempty"`
	MimeType string          `json:"mimeType,omitempty"`
	URI      string          `json:"uri,omitempty"`
	Name     string          `json:"name,omitempty"`
	Data     string          `json:"data,omitempty"`
	Resource json.RawMessage `json:"resource,omitempty"`
}

// CallResult is a tools/call result.
type CallResult struct {
	Content           []Content       `json:"content"`
	StructuredContent json.RawMessage `json:"structuredContent,omitempty"`
	IsError           bool            `json:"isError,omitempty"`
}

// Client is a thin typed layer over a Transport.
type Client struct{ T Transport }

// ListTools follows nextCursor until done, capped at MaxTools / maxListPages.
func (c *Client) ListTools(ctx context.Context) ([]Tool, error) {
	var out []Tool
	cursor := ""
	for page := 0; page < maxListPages; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := c.T.Call(ctx, "tools/list", params)
		if err != nil {
			return nil, err
		}
		var res struct {
			Tools      []Tool `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, fmt.Errorf("mcp: decode tools/list: %w", err)
		}
		out = append(out, res.Tools...)
		if len(out) > MaxTools {
			return nil, fmt.Errorf("mcp: server lists more than %d tools", MaxTools)
		}
		if res.NextCursor == "" {
			return out, nil
		}
		cursor = res.NextCursor
	}
	return nil, fmt.Errorf("mcp: tools/list did not terminate after %d pages", maxListPages)
}

// CallTool invokes one tool. A tool-level failure is IsError=true, not an error.
func (c *Client) CallTool(ctx context.Context, name string, args map[string]any) (*CallResult, error) {
	if args == nil {
		args = map[string]any{}
	}
	raw, err := c.T.Call(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return nil, err
	}
	var res CallResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("mcp: decode tools/call: %w", err)
	}
	return &res, nil
}

// ---------- lifecycle helpers shared by the transports ----------

func initializeParams() map[string]any {
	return map[string]any{
		"protocolVersion": ProtocolVersion,
		// No client features (roots / sampling / elicitation): a remote server
		// must not be able to make PAL call an LLM or read files on its behalf.
		"capabilities": map[string]any{},
		"clientInfo":   map[string]any{"name": ClientName, "version": ClientVersion},
	}
}

// checkInitialize validates an InitializeResult and returns the negotiated version.
func checkInitialize(raw json.RawMessage) (string, error) {
	var res struct {
		ProtocolVersion string `json:"protocolVersion"`
		Capabilities    struct {
			Tools json.RawMessage `json:"tools"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return "", fmt.Errorf("mcp: decode initialize result: %w", err)
	}
	if !supportedVersions[res.ProtocolVersion] {
		return "", fmt.Errorf("%w (%q)", ErrUnsupportedVersion, clip(res.ProtocolVersion, 40))
	}
	if len(res.Capabilities.Tools) == 0 {
		return "", errors.New("mcp: server does not offer the tools capability")
	}
	return res.ProtocolVersion, nil
}

// rpcMessage is the union of request / response / notification shapes.
type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  any             `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

func request(id, method string, params any) rpcMessage {
	return rpcMessage{JSONRPC: "2.0", ID: json.RawMessage(id), Method: method, Params: params}
}

func notification(method string, params any) rpcMessage {
	return rpcMessage{JSONRPC: "2.0", Method: method, Params: params}
}

// sameID compares JSON-RPC ids textually after trimming whitespace; PAL only
// ever sends integer or quoted-string ids, which round-trip byte-identically.
func sameID(a, b json.RawMessage) bool {
	return len(a) > 0 && strings.TrimSpace(string(a)) == strings.TrimSpace(string(b))
}

// resultOf turns a response message into (result, error).
func resultOf(m rpcMessage) (json.RawMessage, error) {
	if m.Error != nil {
		return nil, m.Error
	}
	if m.Result == nil {
		return nil, errors.New("mcp: response has neither result nor error")
	}
	return m.Result, nil
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
