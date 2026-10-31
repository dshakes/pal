package cli

// a2a_cmd_test.go — `pal a2a …` against a mock A2A endpoint.

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestA2ACommands(t *testing.T) {
	var gotPath, gotBody string
	const task = `{"kind":"task","id":"t1","contextId":"c1","status":{"state":"completed"},"artifacts":[{"artifactId":"a","parts":[{"kind":"text","text":"hello back"}]}]}`
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/agents/{name}/a2a/.well-known/agent-card.json", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"protocolVersion":"0.3.0","name":"bot"}`))
	})
	mux.HandleFunc("POST /v1/agents/{name}/a2a", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotPath, gotBody = r.URL.Path, string(b)
		if strings.Contains(gotBody, `"zz"`) {
			_, _ = w.Write([]byte(`{"error":{"code":-32001,"message":"task not found"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":"1","result":` + task + `}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	withAPIURL(t, srv.URL)

	tests := []struct {
		name     string
		args     []string
		wantErr  string
		wantOut  []string
		wantBody []string
	}{
		{"card", []string{"card", "bot"}, "", nil, nil},
		{"send --wait", []string{"send", "bot", "hi", "--wait"}, "", []string{"task: t1", "state: completed", "hello back"},
			[]string{`"method":"message/send"`, `"blocking":true`, `"text":"hi"`}},
		{"send non-blocking", []string{"send", "bot", "hi"}, "", []string{"t1"}, []string{`"blocking":false`}},
		{"task", []string{"task", "bot", "t1"}, "", []string{"completed"}, []string{`"method":"tasks/get"`}},
		{"cancel", []string{"cancel", "bot", "t1"}, "", nil, []string{`"method":"tasks/cancel"`}},
		{"rpc error", []string{"task", "bot", "zz"}, "-32001", nil, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotBody = ""
			cmd := newA2ACommand()
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(io.Discard)
			cmd.SetArgs(tc.args)
			err := cmd.ExecuteContext(context.Background())
			if tc.wantErr == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
			}
			for _, w := range tc.wantOut {
				if !strings.Contains(out.String(), w) {
					t.Errorf("output missing %q:\n%s", w, out.String())
				}
			}
			if tc.name == "card" && !strings.HasSuffix(gotPath, "/a2a/.well-known/agent-card.json") {
				t.Errorf("card path = %s", gotPath)
			}
			for _, w := range tc.wantBody {
				if !strings.Contains(gotBody, w) {
					t.Errorf("request body missing %q: %s", w, gotBody)
				}
			}
		})
	}
}
