import test from "node:test";
import assert from "node:assert/strict";
import { matchGlob, policyGaps, summarizeWorkflow } from "./design-view.ts";
import type { AgentPolicy } from "./agent-policy.ts";

const wf = {
  nodes: [
    { id: "s", type: "trigger", data: {} },
    { id: "a", type: "ai-step", data: { prompt: "x" } },
    { id: "t", type: "tool", data: { tool: "web_search" } },
    { id: "c1", type: "connector", data: { connector: "slack", action: "post_message" } },
    { id: "c2", type: "connector", data: { connector: "github", action: "list_prs" } },
    { id: "e", type: "end", data: {} },
  ],
  edges: [],
};

const policy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  mode: "enforce", tools: [], connectors: {}, mcpServers: [], egressHosts: [], a2aTargets: [], a2aInbound: [], secrets: [],
  budget: { maxToolCallsPerRun: 0, maxA2AInboundPerMinute: 0 }, version: 1, ...over,
});

test("summarizeWorkflow: counts node types and collects tools/connectors; empty → null", () => {
  const s = summarizeWorkflow(wf)!;
  assert.equal(s.nodes, 6);
  assert.deepEqual(s.byType, { trigger: 1, "ai-step": 1, tool: 1, connector: 2, end: 1 });
  assert.deepEqual(s.tools, ["web_search"]);
  assert.deepEqual(s.connectors, { github: ["list_prs"], slack: ["post_message"] });
  assert.equal(summarizeWorkflow(null), null);
  assert.equal(summarizeWorkflow({ nodes: [] }), null);
});

test("matchGlob mirrors the server's MatchGlob", () => {
  assert.ok(matchGlob("*", "anything"));
  assert.ok(matchGlob("web_*", "web_search"));
  assert.ok(matchGlob("*_message", "post_message"));
  assert.ok(matchGlob("a*c*e", "abcde"));
  assert.ok(!matchGlob("web_*", "fetch"));
  assert.ok(!matchGlob("post", "post_message"));
});

test("policyGaps: an enforcing policy flags what the workflow uses but doesn't allow", () => {
  const s = summarizeWorkflow(wf);
  assert.deepEqual(policyGaps(s, policy()).map((g) => g.target), ["web_search", "slack.post_message", "github.list_prs"]);
  const p = policy({ tools: ["web_*"], connectors: { slack: ["post_*"], "git*": ["*"] } });
  assert.deepEqual(policyGaps(s, p), []);
  assert.deepEqual(policyGaps(s, policy({ mode: "legacy_permissive" })), []);
  assert.deepEqual(policyGaps(null, policy()), []);
});
