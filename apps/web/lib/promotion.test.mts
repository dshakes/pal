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
