import test from "node:test";
import assert from "node:assert/strict";
import { gateVerdict, isRegressed } from "./eval-gate.ts";
import type { EvalBaseline, EvalRun } from "./api.ts";

const run = (id: string, at: string, over: Partial<EvalRun> = {}): EvalRun => ({
  id, suiteId: "s", branch: "main", agentName: "a", passed: true, score: 0.9, casesTotal: 10, casesPassed: 9, durationMs: 1, totalCostUsd: 0, createdAt: at, ...over,
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

test("isRegressed: below the baseline on its branch, after the pin, and not the baseline itself", () => {
  const b: EvalBaseline = { agentName: "a", branch: "main", evalRunId: "r1", score: 0.9, setAt: "2026-11-01T00:00:00Z" };
  assert.equal(isRegressed(run("r2", "2026-11-01T01:00:00Z", { score: 0.6, branch: "main" }), b), true);
  assert.equal(isRegressed(run("r1", "2026-11-01T01:00:00Z", { score: 0.6 }), b), false); // the baseline itself
  assert.equal(isRegressed(run("r0", "2026-10-31T01:00:00Z", { score: 0.6 }), b), false); // before the pin
  assert.equal(isRegressed(run("r3", "2026-11-01T01:00:00Z", { score: 0.6, branch: "feat" }), b), false); // other branch
  assert.equal(isRegressed(run("r4", "2026-11-01T01:00:00Z", { score: 0.95 }), b), false);
  assert.equal(isRegressed(run("r5", "2026-11-01T01:00:00Z", { regressed: true }), null), true); // server said so
});

test("isRegressed: within the server's 0.01 tolerance is not a regression", () => {
  const b: EvalBaseline = { agentName: "a", branch: "main", evalRunId: "r1", score: 0.8, setAt: "" };
  assert.equal(isRegressed(run("r2", "2026-11-01T00:00:00Z", { score: 0.795 }), b), false);
  assert.equal(isRegressed(run("r3", "2026-11-01T00:00:00Z", { score: 0.79 }), b), false); // exactly 0.01 below
  assert.equal(isRegressed(run("r4", "2026-11-01T00:00:00Z", { score: 0.78 }), b), true);
});

test("isRegressed: a run with no branch is never compared (server skips it)", () => {
  const b: EvalBaseline = { agentName: "a", branch: "main", evalRunId: "r1", score: 0.9, setAt: "" };
  assert.equal(isRegressed(run("r2", "2026-11-01T00:00:00Z", { score: 0.1, branch: "" }), b), false);
});

test("gateVerdict: only the branch counts, newest run per suite, any failing suite fails the gate", () => {
  const runs = [
    run("a-old", "2026-10-01T00:00:00Z", { suiteId: "A", passed: false, score: 0.1 }), // superseded
    run("a-new", "2026-11-01T00:00:00Z", { suiteId: "A" }),
    run("b-new", "2026-10-30T00:00:00Z", { suiteId: "B", passed: false, score: 0.3 }),
    run("x", "2026-11-02T00:00:00Z", { suiteId: "C", branch: "feat", passed: false }), // other branch, ignored
  ];
  const v = gateVerdict(runs, null, "main");
  assert.equal(v.state, "fail");
  assert.equal(v.run?.id, "b-new");
  assert.equal(gateVerdict(runs.filter((r) => r.suiteId === "C"), null, "main").state, "none");
});
