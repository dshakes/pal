package handlers

import "testing"

func TestAgentForbidsTools(t *testing.T) {
	yes := []string{
		"You are terse. Never call tools.",
		"Do not use any tools under any circumstances.",
		"don't call tools; answer from your own knowledge",
		"Answer directly without calling any tools.",
		"No tool calls. Just text.",
		"You must not invoke the connectors.",
	}
	no := []string{
		"You triage GitHub issues. Call the GitHub connector to list PRs.",
		"Use the tools to fetch data, then summarize. Never guess a PR number.",
		"Summarize the input.",
		"",
	}
	for _, s := range yes {
		if !agentForbidsTools(s, nil) {
			t.Errorf("want forbid for %q", s)
		}
	}
	for _, s := range no {
		if agentForbidsTools(s, nil) {
			t.Errorf("want allow for %q", s)
		}
	}
	if !agentForbidsTools("anything", []byte(`{"tools":"none"}`)) {
		t.Error("label tools=none must forbid")
	}
	if agentForbidsTools("anything", []byte(`{"tools":"all","pal.template":"x"}`)) {
		t.Error("other label values must not forbid")
	}
}
