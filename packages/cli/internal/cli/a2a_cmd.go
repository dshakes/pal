package cli

// a2a_cmd.go — `pal a2a …`: thin A2A v0.3 (JSON-RPC) client for an agent's
// /v1/agents/{name}/a2a endpoint (control-plane handlers/a2a_jsonrpc.go).

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/spf13/cobra"
)

type a2aPart struct {
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
}

type a2aTask struct {
	ID        string `json:"id"`
	ContextID string `json:"contextId"`
	Status    struct {
		State string `json:"state"`
	} `json:"status"`
	Artifacts []struct {
		Parts []a2aPart `json:"parts"`
	} `json:"artifacts"`
}

func newA2ACommand() *cobra.Command {
	cmd := &cobra.Command{Use: "a2a", Short: "Talk to an agent over A2A v0.3 (card, send, task, cancel)"}
	cmd.AddCommand(
		&cobra.Command{
			Use: "card <agent>", Short: "Print the agent's A2A card", Args: cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				resp, err := apiRaw("GET", a2aBase(args[0])+"/.well-known/agent-card.json", nil)
				if err != nil {
					return err
				}
				var card any
				if err := json.Unmarshal(resp, &card); err != nil {
					return fmt.Errorf("decode response: %w", err)
				}
				return printJSON(card)
			},
		},
		newA2ASendCommand(),
		&cobra.Command{
			Use: "task <agent> <taskId>", Short: "Get a task", Args: cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				return a2aCall(cmd, args[0], "tasks/get", map[string]any{"id": args[1]})
			},
		},
		&cobra.Command{
			Use: "cancel <agent> <taskId>", Short: "Cancel a task", Args: cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				return a2aCall(cmd, args[0], "tasks/cancel", map[string]any{"id": args[1]})
			},
		},
	)
	return cmd
}

func newA2ASendCommand() *cobra.Command {
	var wait bool
	cmd := &cobra.Command{
		Use: "send <agent> <text>", Short: "Send a message; --wait blocks until the task is terminal", Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			msg := map[string]any{
				"kind": "message", "messageId": a2aUUID(), "role": "user",
				"parts": []a2aPart{{Kind: "text", Text: args[1]}},
			}
			return a2aCall(cmd, args[0], "message/send", map[string]any{
				"message": msg, "configuration": map[string]any{"blocking": wait},
			})
		},
	}
	cmd.Flags().BoolVar(&wait, "wait", false, "block until the task reaches a terminal state")
	return cmd
}

func a2aBase(agent string) string { return "/v1/agents/" + url.PathEscape(agent) + "/a2a" }

// a2aCall posts one JSON-RPC call and prints the resulting task.
func a2aCall(cmd *cobra.Command, agent, method string, params map[string]any) error {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": a2aUUID(), "method": method, "params": params})
	if err != nil {
		return err
	}
	resp, err := apiRaw("POST", a2aBase(agent), body)
	if err != nil {
		return err
	}
	var env struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(resp, &env); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	if env.Error != nil {
		return fmt.Errorf("a2a error %d: %s", env.Error.Code, env.Error.Message)
	}
	if isJSON() {
		var raw any
		_ = json.Unmarshal(env.Result, &raw)
		return printJSON(raw)
	}
	var t a2aTask
	if err := json.Unmarshal(env.Result, &t); err != nil {
		return fmt.Errorf("decode task: %w", err)
	}
	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "task: %s\nstate: %s\n", t.ID, t.Status.State)
	for _, a := range t.Artifacts {
		for _, p := range a.Parts {
			if p.Kind == "text" {
				fmt.Fprintln(out, p.Text)
			}
		}
	}
	return nil
}

func a2aUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
