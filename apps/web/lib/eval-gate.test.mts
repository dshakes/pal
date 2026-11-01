import test from "node:test";
import assert from "node:assert/strict";
import { gateVerdict } from "./eval-gate.ts";
import type { EvalBaseline, EvalRun } from "./api.ts";

const run = (id: string, at: string, over: Partial<EvalRun> = {}): EvalRun => ({
  id, suiteId: "s", agentName: "a", passed: true, score: 0.9, casesTotal: 10, casesPassed: 9, durationMs: 1, totalCostUsd: 0, createdAt: at, ...over,
});
const base = (id: string, score: number): EvalBaseline => ({ agentName: "a", branch: "main", evalRunId: id, score, setAt: "" });

test("gateVerdict: no runs → none", () => {
  assert.equal(gateVerdict([], null).state, "none");
});

test("gateVerdict: judges the LATEST run, not the first", () => {
  const v = gateVerdict([run("new", "2026-11-01T10:00:00Z", { passed: false, score: 0.4 }), run("old", "2026-10-01T10:00:00Z")], null);
  assert.equal(v.state, "fail");
  assert.equal(v.run?.id, "new");
});

test("gateVerdict: below the pinned baseline is a regression even if the server flag is absent", () => {
  assert.equal(gateVerdict([run("r2", "2026-11-01T00:00:00Z", { score: 0.7 })], base("r1", 0.9)).state, "regressed");
  assert.equal(gateVerdict([run("r2", "2026-11-01T00:00:00Z", { regressed: true })], null).state, "regressed");
});

test("gateVerdict: passing at or above baseline, and the baseline run itself, pass", () => {
  assert.equal(gateVerdict([run("r2", "2026-11-01T00:00:00Z", { score: 0.95 })], base("r1", 0.9)).state, "pass");
  assert.equal(gateVerdict([run("r1", "2026-11-01T00:00:00Z")], base("r1", 0.9)).state, "pass");
});
