package pal

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDebugAndSupport(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.EscapedPath()
		gotBody = nil
		if b, _ := io.ReadAll(r.Body); len(b) > 0 {
			_ = json.Unmarshal(b, &gotBody)
		}
		switch gotPath {
		case "/v1/debug/analyze":
			if gotBody["runId"] == "bad" {
				w.WriteHeader(402)
				w.Write([]byte(`{"code":"budget_exceeded"}`))
				return
			}
			w.Write([]byte(`{"summary":"s","rootCause":"rc","confidence":"high","grounded":true,"citations":[{"ref":"run:1","label":"l"}],"proposals":[{"id":"p1","kind":"rollback","title":"t","rationale":"r","citations":["run:1"],"risk":"low","action":{"method":"POST","path":"/v1/x","body":{"a":1},"idempotencyKey":"k"},"diff":{"field":"model","before":"a","after":"b"}}],"dropped":[{"kind":"retry","reason":"x"}],"subject":{"kind":"run","runId":"1","agentName":"a"},"evidence":{"runs":2},"costUsd":0.01,"requiresApproval":true,"generatedAt":"t"}`))
		case "/v1/support/ask":
			w.Write([]byte(`{"answer":"a","citations":[],"docs":[{"slug":"s","title":"T","path":"/p"}],"actions":[{"kind":"debug_run","runId":"1"}],"suggestEscalation":true,"grounded":true,"costUsd":0,"requiresApproval":false}`))
		case "/v1/support/escalations":
			if r.Method == http.MethodPost {
				w.WriteHeader(201)
				w.Write([]byte(`{"id":"e1","digest":"d","algorithm":"ed25519","signature":"s","createdAt":"t","bundle":{"q":1}}`))
				return
			}
			w.Write([]byte(`{"escalations":[{"id":"e1","subjectKind":"run","subjectId":"1","question":"q","digest":"d","algorithm":"a","createdBy":"u","createdAt":"t"}]}`))
		case "/v1/support/escalations/e%201":
			w.Write([]byte(`{"id":"e 1","subjectKind":"run","question":"q","digest":"d","algorithm":"a","createdBy":"u","createdAt":"t","signature":"sig","bundle":{}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := New(WithBaseURL(srv.URL))
	ctx := context.Background()

	rep, err := c.AnalyzeDebug(ctx, DebugAnalyzeRequest{Kind: "run", RunID: "1"})
	if err != nil || gotMethod != "POST" || gotPath != "/v1/debug/analyze" || gotBody["kind"] != "run" || gotBody["runId"] != "1" {
		t.Fatalf("analyze: %v %s %s %v", err, gotMethod, gotPath, gotBody)
	}
	p := rep.Proposals[0]
	if rep.Confidence != "high" || !rep.RequiresApproval || p.Action == nil || p.Action.Path != "/v1/x" ||
		string(p.Action.Body) != `{"a":1}` || p.Action.IdempotencyKey != "k" || p.Diff.After != "b" || rep.Evidence["runs"] != 2 {
		t.Fatalf("decode: %+v", rep)
	}
	_, err = c.AnalyzeDebug(ctx, DebugAnalyzeRequest{Kind: "run", RunID: "bad"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 402 {
		t.Fatalf("want 402 APIError, got %v", err)
	}

	ans, err := c.AskSupport(ctx, AskSupportRequest{Question: "why", History: []SupportTurn{{Role: "user", Text: "hi"}}})
	if err != nil || gotPath != "/v1/support/ask" || gotBody["question"] != "why" || !ans.SuggestEscalation || ans.Actions[0].Kind != "debug_run" || ans.Docs[0].Slug != "s" {
		t.Fatalf("ask: %+v %v", ans, err)
	}

	esc, err := c.EscalateSupport(ctx, EscalateSupportRequest{Question: "help", IncidentID: "i"})
	if err != nil || gotMethod != "POST" || gotBody["incidentId"] != "i" || esc.ID != "e1" || esc.Bundle["q"] != float64(1) {
		t.Fatalf("escalate: %+v %v", esc, err)
	}

	list, err := c.ListSupportEscalations(ctx)
	if err != nil || gotMethod != "GET" || len(list) != 1 || list[0].SubjectID != "1" {
		t.Fatalf("list: %+v %v", list, err)
	}

	one, err := c.GetSupportEscalation(ctx, "e 1")
	if err != nil || gotPath != "/v1/support/escalations/e%201" || one.Signature != "sig" || one.ID != "e 1" {
		t.Fatalf("get: %+v %v", one, err)
	}
}
