import test from "node:test";
import assert from "node:assert/strict";
import { bucketRuns, verdict } from "./overview.ts";
import type { Run } from "./types.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const run = (agentName: string, status: Run["status"], minsAgo: number): Run => ({
  id: `${agentName}-${minsAgo}`, tenantId: "t", agentId: "a", agentName, status, input: null,
  costUsd: 0, tokensIn: 0, tokensOut: 0, createdAt: new Date(NOW - minsAgo * 60_000), labels: {},
});

test("verdict: idle, all-ok, and failures name the agents worst-first", () => {
  assert.deepEqual(verdict([], NOW), { tone: "idle", text: "No runs in the last 24 hours." });
  assert.equal(verdict([run("a", "succeeded", 5)], NOW).text, "The only run in the last 24 hours succeeded.");
  assert.equal(verdict([run("a", "succeeded", 5), run("b", "succeeded", 9)], NOW).tone, "ok");
  const v = verdict([run("b", "failed", 1), run("a", "failed", 2), run("a", "failed", 3), run("c", "succeeded", 4)], NOW);
  assert.equal(v.tone, "bad");
  assert.equal(v.text, "3 of 4 runs failed in the last 24 hours, on a and b.");
});

test("verdict: ignores runs older than 24h, notes live runs, caps named agents", () => {
  assert.equal(verdict([run("a", "failed", 25 * 60)], NOW).tone, "idle");
  assert.match(verdict([run("a", "running", 1)], NOW).text, /1 running now\.$/);
  const many = verdict([run("a", "failed", 1), run("b", "failed", 1), run("c", "failed", 1)], NOW);
  assert.equal(many.text, "3 of 3 runs failed in the last 24 hours, on a, b and 1 more.");
});

test("bucketRuns: newest bucket is last, out-of-window runs dropped", () => {
  const b = bucketRuns([run("a", "succeeded", 1), run("a", "failed", 31), run("a", "queued", 1), run("a", "failed", 24 * 60 + 1)], NOW, 48);
  assert.equal(b.length, 48);
  assert.deepEqual(b[47], { ok: 1, fail: 0, other: 1 });
  assert.deepEqual(b[46], { ok: 0, fail: 1, other: 0 });
  assert.equal(b.reduce((n, x) => n + x.ok + x.fail + x.other, 0), 3);
});
