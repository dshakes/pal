import test from "node:test";
import assert from "node:assert/strict";
import { runFilterFromQuery, sessionSizes, runPageView } from "./runs-view.ts";
import type { Run } from "./types.ts";

const q = (s: string) => new URLSearchParams(s);

test("runs-view: filters come from the URL, unknown status falls back to all", () => {
  assert.deepEqual(runFilterFromQuery(q("status=failed&agent=pr-triage&q=abc")), { status: "failed", agent: "pr-triage", session: "", q: "abc" });
  assert.equal(runFilterFromQuery(q("status=bogus")).status, "all");
  assert.deepEqual(runFilterFromQuery(q("")), { status: "all", agent: "", session: "", q: "" });
});

test("runs-view: session sizes count only runs with a session id", () => {
  const r = (id: string, sessionId?: string) => ({ id, sessionId } as unknown as Run);
  const m = sessionSizes([r("1", "s1"), r("2", "s1"), r("3"), r("4", "s2")]);
  assert.equal(m.get("s1"), 2);
  assert.equal(m.get("s2"), 1);
  assert.equal(m.size, 2);
});

test("runPageView: a loaded run survives a failed or in-flight poll", () => {
  const down = new Error("Failed to fetch");
  assert.equal(runPageView({ hasRun: true, loading: false, error: down }), "run");
  assert.equal(runPageView({ hasRun: true, loading: true, error: null }), "run");
  assert.equal(runPageView({ hasRun: false, loading: true, error: null }), "skeleton");
  assert.equal(runPageView({ hasRun: false, loading: false, error: new Error("API 404: run not found") }), "not-found");
  assert.equal(runPageView({ hasRun: false, loading: false, error: down }), "load-failed");
});
