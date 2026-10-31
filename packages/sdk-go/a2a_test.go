package pal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestA2A(t *testing.T) {
	const task = `{"kind":"task","id":"t1","contextId":"c1","status":{"state":"completed"},"artifacts":[{"artifactId":"a","parts":[{"kind":"text","text":"hi"}]}]}`
	tests := []struct {
		name       string
		call       func(c *Client) (any, error)
		wantMethod string
		wantPath   string
		wantRPC    string
		reply      string
		wantCode   int
	}{
		{"card", func(c *Client) (any, error) { return c.GetA2ACard(context.Background(), "bot") },
			http.MethodGet, "/v1/agents/bot/a2a/.well-known/agent-card.json", "", `{"protocolVersion":"0.3.0","name":"bot","url":"u"}`, 0},
		{"send", func(c *Client) (any, error) { return c.SendA2AMessage(context.Background(), "bot", "hi", true) },
			http.MethodPost, "/v1/agents/bot/a2a", "message/send", `{"result":` + task + `}`, 0},
		{"get", func(c *Client) (any, error) { return c.GetA2ATask(context.Background(), "bot", "t1") },
			http.MethodPost, "/v1/agents/bot/a2a", "tasks/get", `{"result":` + task + `}`, 0},
		{"cancel", func(c *Client) (any, error) { return c.CancelA2ATask(context.Background(), "bot", "t1") },
			http.MethodPost, "/v1/agents/bot/a2a", "tasks/cancel", `{"result":` + task + `}`, 0},
		{"rpc error", func(c *Client) (any, error) { return c.GetA2ATask(context.Background(), "bot", "zz") },
			http.MethodPost, "/v1/agents/bot/a2a", "tasks/get", `{"error":{"code":-32001,"message":"task not found"}}`, -32001},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotRPC map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != tt.wantMethod || r.URL.Path != tt.wantPath {
					t.Errorf("got %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("Authorization") != "Bearer k" {
					t.Errorf("missing bearer")
				}
				if r.Method == http.MethodPost {
					_ = json.NewDecoder(r.Body).Decode(&gotRPC)
				}
				w.Write([]byte(tt.reply))
			}))
			defer srv.Close()
			c := New(WithBaseURL(srv.URL), WithAPIKey("k"))
			_, err := tt.call(c)
			if tt.wantCode != 0 {
				var ae *APIError
				if !errors.As(err, &ae) || ae.Code != tt.wantCode {
					t.Fatalf("want APIError code %d, got %v", tt.wantCode, err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if tt.wantRPC != "" && gotRPC["method"] != tt.wantRPC {
				t.Errorf("rpc method %v, want %s", gotRPC["method"], tt.wantRPC)
			}
		})
	}
}
