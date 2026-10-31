package pal

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// ---------- A2A v0.3 (JSON-RPC) ----------

// A2ASkill is one advertised capability on an agent card.
type A2ASkill struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
}

// A2ACapabilities mirrors the card's capabilities block.
type A2ACapabilities struct {
	Streaming              bool `json:"streaming"`
	PushNotifications      bool `json:"pushNotifications"`
	StateTransitionHistory bool `json:"stateTransitionHistory"`
}

// A2AAgentCard is the A2A AgentCard served at the well-known path.
type A2AAgentCard struct {
	ProtocolVersion    string                     `json:"protocolVersion"`
	Name               string                     `json:"name"`
	Description        string                     `json:"description,omitempty"`
	URL                string                     `json:"url"`
	PreferredTransport string                     `json:"preferredTransport,omitempty"`
	Version            string                     `json:"version,omitempty"`
	Capabilities       A2ACapabilities            `json:"capabilities"`
	SecuritySchemes    map[string]json.RawMessage `json:"securitySchemes,omitempty"`
	Security           []map[string][]string      `json:"security,omitempty"`
	DefaultInputModes  []string                   `json:"defaultInputModes,omitempty"`
	DefaultOutputModes []string                   `json:"defaultOutputModes,omitempty"`
	Skills             []A2ASkill                 `json:"skills,omitempty"`
}

// A2APart is one message/artifact part; only text parts carry Text.
type A2APart struct {
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
}

// A2AMessage is an A2A message.
type A2AMessage struct {
	Kind      string    `json:"kind"`
	MessageID string    `json:"messageId"`
	Role      string    `json:"role"`
	Parts     []A2APart `json:"parts"`
}

// A2AArtifact is an output produced by a task.
type A2AArtifact struct {
	ArtifactID string    `json:"artifactId"`
	Name       string    `json:"name,omitempty"`
	Parts      []A2APart `json:"parts"`
}

// A2ATaskStatus is a task's state (submitted|working|completed|failed|canceled).
type A2ATaskStatus struct {
	State     string      `json:"state"`
	Timestamp string      `json:"timestamp,omitempty"`
	Message   *A2AMessage `json:"message,omitempty"`
}

// A2ATask is the result of message/send, tasks/get and tasks/cancel.
type A2ATask struct {
	Kind      string        `json:"kind"`
	ID        string        `json:"id"`
	ContextID string        `json:"contextId"`
	Status    A2ATaskStatus `json:"status"`
	Artifacts []A2AArtifact `json:"artifacts,omitempty"`
	History   []A2AMessage  `json:"history,omitempty"`
}

// GetA2ACard fetches the agent's A2A card.
func (c *Client) GetA2ACard(ctx context.Context, agent string) (*A2AAgentCard, error) {
	var out A2AAgentCard
	err := c.do(ctx, http.MethodGet, a2aPath(agent)+"/.well-known/agent-card.json", nil, &out)
	return &out, err
}

// SendA2AMessage sends a text message (message/send). With blocking the call
// returns once the task is terminal.
func (c *Client) SendA2AMessage(ctx context.Context, agent, text string, blocking bool) (*A2ATask, error) {
	msg := A2AMessage{Kind: "message", MessageID: newUUID(), Role: "user", Parts: []A2APart{{Kind: "text", Text: text}}}
	return c.a2aRPC(ctx, agent, "message/send", map[string]any{
		"message":       msg,
		"configuration": map[string]any{"blocking": blocking},
	})
}

// GetA2ATask fetches a task by id (tasks/get).
func (c *Client) GetA2ATask(ctx context.Context, agent, taskID string) (*A2ATask, error) {
	return c.a2aRPC(ctx, agent, "tasks/get", map[string]any{"id": taskID})
}

// CancelA2ATask cancels a task (tasks/cancel).
func (c *Client) CancelA2ATask(ctx context.Context, agent, taskID string) (*A2ATask, error) {
	return c.a2aRPC(ctx, agent, "tasks/cancel", map[string]any{"id": taskID})
}

func a2aPath(agent string) string { return "/v1/agents/" + url.PathEscape(agent) + "/a2a" }

// a2aRPC posts a JSON-RPC 2.0 call. Errors arrive as HTTP 200 + {error}; they
// are returned as *APIError with Code set.
func (c *Client) a2aRPC(ctx context.Context, agent, method string, params any) (*A2ATask, error) {
	var resp struct {
		Result *A2ATask `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	req := map[string]any{"jsonrpc": "2.0", "id": newUUID(), "method": method, "params": params}
	if err := c.do(ctx, http.MethodPost, a2aPath(agent), req, &resp); err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, &APIError{Status: http.StatusOK, Body: resp.Error.Message, Code: resp.Error.Code}
	}
	if resp.Result == nil {
		return nil, &APIError{Status: http.StatusOK, Body: "a2a: response missing result"}
	}
	return resp.Result, nil
}

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
