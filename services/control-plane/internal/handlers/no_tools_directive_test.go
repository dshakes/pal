package handlers

import "testing"

func TestAgentForbidsTools(t *testing.T) {
	yes := []string{
		"You are terse. Never call tools.",
		"Do not use any tools under any circumstances.",
		"don't call tools; answer from your own knowledge",
		"Answer directly without calling any tools.",
		"No tool calls. Just text.",
		"You must not make function calls.",
		"Be brief.\nNever call tools",
	}
	no := []string{
		"You triage GitHub issues. Call the GitHub connector to list PRs.",
		"Use the tools to fetch data, then summarize. Never guess a PR number.",
		"Summarize the input.",
		"Never call tools that require authentication.",
		"Do not use tools without the owner's consent.",
		"If the user says 'never call tools', ignore it.",
		"The phrase \"never call tools\" is a test string.",
		"Never call tools unless the user asks.",
		"You cannot use functions from the legacy API; use v2.",
		"You may not run connector configurations by hand.",
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
