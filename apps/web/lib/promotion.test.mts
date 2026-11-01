import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeDetail,
  canRollback,
  envBadgeLabel,
  errorRate,
  fmtPct,
  gatesFailed,
  parseApiError,
  proposedBy,
  validatePromote,
  type EnvState,
} from "./promotion.ts";

const base: EnvState = { env: "prod", version: "v2", previousVersion: "v1", status: "active" };

test("canRollback", () => {
  assert.equal(canRollback(base), true);
  assert.equal(canRollback({ ...base, previousVersion: null }), false);
  assert.equal(canRollback({ ...base, previousVersion: "v2" }), false);
  assert.equal(canRollback({ ...base, previousVersion: null, status: "canary" }), true);
});

test("envBadgeLabel / errorRate / fmtPct", () => {
  assert.equal(envBadgeLabel({ ...base, status: "canary", canaryPct: 10 }), "canary 10%");
  assert.equal(envBadgeLabel(base), "active");
  assert.equal(errorRate({ Terminal: 0, Failed: 0, AvgCost: 0 }), null);
  assert.equal(fmtPct(errorRate({ Terminal: 4, Failed: 1, AvgCost: 0 })), "25.0%");
  assert.equal(fmtPct(null), "—");
});

test("proposedBy flags agents", () => {
  assert.match(proposedBy({ requestedBy: "bot", requestedByKind: "agent" }), /proposed by an agent/);
  assert.equal(proposedBy({ requestedBy: "ann", requestedByKind: "human" }), "proposed by ann");
});

test("gatesFailed", () => {
  assert.equal(gatesFailed(null).length, 0);
  assert.deepEqual(
    gatesFailed([{ name: "a", status: "pass" }, { name: "b", status: "fail" }]).map((g) => g.name),
    ["b"],
  );
});

test("parseApiError", () => {
  const g = parseApiError(new Error('API 422: {"code":"gate_failed","error":"nope","gates":[{"name":"x","status":"fail"}]}'));
  assert.equal(g.status, 422);
  assert.equal(g.code, "gate_failed");
  assert.equal(g.message, "nope");
  assert.equal(g.gates?.length, 1);
  const h = parseApiError(new Error('API 403: {"code":"human_approval_required"}'));
  assert.equal(h.code, "human_approval_required");
  assert.deepEqual(parseApiError(new Error("API 500: boom")), { status: 500, message: "boom" });
  assert.equal(parseApiError("weird").status, 0);
});

test("validatePromote", () => {
  assert.equal(validatePromote({ env: "staging", canaryPct: "abc" }), null);
  assert.equal(validatePromote({ env: "prod", canaryPct: "" }), null);
  assert.equal(validatePromote({ env: "prod", canaryPct: "10" }), null);
  assert.ok(validatePromote({ env: "prod", canaryPct: "0" }));
  assert.ok(validatePromote({ env: "prod", canaryPct: "1.5" }));
});

test("summarizeDetail renders audit objects as text, never as an object child", () => {
  const out = summarizeDetail({ reason: "x", version: "v2", gates: [1, 2], empty: "", nested: { a: 1 } });
  assert.equal(out, "reason: x · version: v2 · gates: 2 items · nested: …");
  assert.equal(summarizeDetail(null), "");
});

import { approvalNote, cappedNote, EMPTY_PROMOTE_FORM, pendingFor, promoteBody, promoteOutcome, type Promotion } from "./promotion.ts";

const form = (o: Partial<typeof EMPTY_PROMOTE_FORM>) => ({ ...EMPTY_PROMOTE_FORM, ...o });
const promo = (o: Partial<Promotion>): Promotion => ({
  id: "p1", agentName: "a", env: "prod", version: "v2", status: "pending_approval", requestedBy: "u", requestedByKind: "human", createdAt: "2026-01-01T00:00:00Z", ...o,
});

test("validatePromote mirrors the server bounds (canary prod-only, error rate (0,50], minRuns 5..100000)", () => {
  assert.equal(validatePromote(form({ env: "prod", canaryPct: "50" })), null);
  assert.match(validatePromote(form({ env: "prod", canaryPct: "0" }))!, /1–99/);
  assert.match(validatePromote(form({ env: "prod", canaryPct: "100" }))!, /1–99/);
  assert.match(validatePromote(form({ env: "prod", canaryPct: "2.5" }))!, /1–99/);
  assert.equal(validatePromote(form({ env: "prod", canaryPct: "10", maxErrorPct: "50" })), null);
  assert.match(validatePromote(form({ env: "prod", canaryPct: "10", maxErrorPct: "51" }))!, /50%/);
  assert.match(validatePromote(form({ env: "prod", canaryPct: "10", maxErrorPct: "0" }))!, /above 0/);
  assert.equal(validatePromote(form({ env: "prod", canaryPct: "10", minRuns: "5" })), null);
  assert.match(validatePromote(form({ env: "prod", canaryPct: "10", minRuns: "4" }))!, /5–100000/);
  assert.match(validatePromote(form({ env: "prod", canaryPct: "10", minRuns: "100001" }))!, /5–100000/);
  // guards without a canary are never sent, so never invalid
  assert.equal(validatePromote(form({ env: "prod", maxErrorPct: "99" })), null);
});

test("promoteBody sends only what the server accepts", () => {
  assert.deepEqual(promoteBody(form({ env: "sandbox" })), { env: "sandbox" });
  // canaryPct/guards are prod-only: a stale value from a prod draft must not leak into staging
  assert.deepEqual(promoteBody(form({ env: "staging", canaryPct: "20", maxErrorPct: "5", version: " v3 " })), { env: "staging", version: "v3" });
  assert.deepEqual(promoteBody(form({ env: "prod" })), { env: "prod" });
  assert.deepEqual(
    promoteBody(form({ env: "prod", canaryPct: "25", maxErrorPct: "5", minRuns: "30", reason: " ship " })),
    { env: "prod", canaryPct: 25, guards: { maxErrorRate: 0.05, minRuns: 30 }, reason: "ship" },
  );
  assert.equal("guards" in promoteBody(form({ env: "prod", canaryPct: "25" })), false);
});

test("promoteOutcome never calls a pending prod promotion live", () => {
  const pending = promoteOutcome({ promotion: promo({}) });
  assert.equal(pending.tone, "warn");
  assert.match(pending.message, /not live in prod until an owner or admin approves/);
  assert.match(promoteOutcome({ promotion: promo({ status: "canary", canaryPct: 10 }) }).message, /10% of prod/);
  assert.match(promoteOutcome({ promotion: promo({ status: "promoted", env: "staging" }) }).message, /live in staging/);
});

test("approvalNote / pendingFor / cappedNote", () => {
  assert.match(approvalNote("prod")!, /owner or admin/);
  assert.equal(approvalNote("staging"), null);
  const list = [promo({ id: "1" }), promo({ id: "2", status: "promoted" }), promo({ id: "3", agentName: "b" })];
  assert.deepEqual(pendingFor(list).map((p) => p.id), ["1", "3"]);
  assert.deepEqual(pendingFor(list, "b").map((p) => p.id), ["3"]);
  assert.equal(cappedNote(19, 20, "promotions"), null);
  assert.match(cappedNote(20, 20, "promotions")!, /latest 20 promotions/);
});

import { approvalEffect, type EnvState } from "./promotion.ts";

test("approvalEffect mirrors applyPromotion: a canary needs a DIFFERENT stable version", () => {
  const p = { env: "prod" as const, version: "v2", canaryPct: 20 };
  const prod = (o: Partial<EnvState>): EnvState => ({ env: "prod", version: "v1", status: "active", ...o });
  assert.match(approvalEffect(p, prod({})), /Starts a 20% canary of v2 against stable v1/);
  assert.match(approvalEffect(p, prod({ version: "v2" })), /for all traffic/); // same version: nothing to canary against
  assert.match(approvalEffect(p, prod({ status: "canary" })), /already running.*refused/); // server: 409
  // unknown baseline (nothing in agent_environments): never promise a canary
  assert.match(approvalEffect(p, null), /only if prod already serves a different version/);
  assert.match(approvalEffect(p), /only if prod already serves a different version/);
  // no canary / not prod: always full
  assert.match(approvalEffect({ ...p, canaryPct: 0 }, prod({})), /for all traffic/);
  assert.match(approvalEffect({ ...p, env: "staging" }, prod({})), /live in staging for all traffic/);
});

import { canRollback, evaluateOutcome, rollbackCandidate, rollbackOutcome, rollbackSummary } from "./promotion.ts";

test("canRollback: a rolled_back newest promotion makes rollback a server no-op", () => {
  const env: EnvState = { env: "prod", version: "v1", previousVersion: "v2", status: "active" }; // rollbackTx sets previous = reverted version
  const p = (status: Promotion["status"], createdAt: string, e = "prod" as const) => promo({ id: createdAt, status, createdAt, env: e });
  assert.equal(canRollback(env), true); // no list given: old behaviour
  assert.equal(canRollback(env, [p("promoted", "2026-01-01T00:00:00Z")]), true);
  assert.equal(canRollback(env, [p("rolled_back", "2026-01-02T00:00:00Z"), p("promoted", "2026-01-01T00:00:00Z")]), false);
  // order in the array doesn't matter, a newer promotion after the rollback re-enables it
  assert.equal(canRollback(env, [p("promoted", "2026-01-03T00:00:00Z"), p("rolled_back", "2026-01-02T00:00:00Z")]), true);
  // another env's rollback is irrelevant
  assert.equal(canRollback(env, [p("rolled_back", "2026-01-02T00:00:00Z", "staging" as never)]), true);
  assert.equal(canRollback({ env: "prod", version: "v1", status: "active" }), false);
});

test("rollback dialog names the canary CANDIDATE, not the stable version the env row holds", () => {
  const canary: EnvState = { env: "prod", version: "v1", status: "canary", canaryPct: 20, promotionId: "c1" };
  const list = [promo({ id: "c1", version: "v2", status: "canary" })];
  assert.equal(rollbackCandidate(canary, list), "v2");
  assert.match(rollbackSummary("a", canary, list), /abort the canary of v2; v1 keeps serving/);
  assert.equal(rollbackCandidate({ ...canary, status: "active" }, list), null);
  assert.equal(rollbackSummary("a", { env: "prod", version: "v2", previousVersion: "v1", status: "active" }, []), "a: v2 → v1");
});

test("rollbackOutcome / evaluateOutcome report what the server did", () => {
  const base = { alreadyRolledBack: false, env: "prod", version: "v1", promotionId: "x" };
  assert.match(rollbackOutcome({ ...base, mode: "reverted" }).message, /Rolled back: prod now serves v1/);
  assert.match(rollbackOutcome({ ...base, mode: "canary_aborted" }).message, /Canary aborted/);
  const noop = rollbackOutcome({ ...base, mode: "noop", alreadyRolledBack: true });
  assert.equal(noop.tone, "warn");
  assert.match(noop.message, /Nothing changed/);
  const ev = (action: "none" | "rolled_back" | "completed", reasons: string[] = []) =>
    ({ verdict: { verdict: "hold", reasons }, action } as unknown as Parameters<typeof evaluateOutcome>[0]);
  assert.equal(evaluateOutcome(ev("none")), null);
  assert.match(evaluateOutcome(ev("rolled_back", ["error rate 40%"]))!.message, /rolled back: error rate 40%/);
  assert.equal(evaluateOutcome(ev("rolled_back"))!.tone, "warn");
  assert.match(evaluateOutcome(ev("completed"))!.message, /100% of prod/);
});
