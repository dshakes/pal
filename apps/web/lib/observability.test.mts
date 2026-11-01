import { test } from "node:test";
import assert from "node:assert/strict";
import {
  budgetPct,
  fmtMs,
  fmtUsd,
  incidentActions,
  incidentTone,
  kindLabel,
  MIN_BAR_PCT,
  waterfallRows,
  apiErrorText,
  wasRolledBack,
  sloTone,
  windowLabel,
  prettyRule,
  parseSloDraft,
  sloToDraft,
  parseProdEvalDraft,
  type SloDraft,
  type ProdEvalDraft,
  type RunTrace,
  type TraceNode,
} from "./observability.ts";

const node = (id: string, startMs: number, durationMs: number, extra: Partial<TraceNode> = {}): TraceNode => ({
  id, name: id, type: "step", status: "ok", startMs, durationMs, ...extra,
});
const trace = (runId: string, durationMs: number, steps: TraceNode[], childRuns: RunTrace[] = []): RunTrace => ({
  runId, status: "succeeded", agentName: "a", startedAt: "2026-01-01T00:00:00Z", durationMs, costUsd: 0, tokensIn: 0,
  tokensOut: 0, totals: { steps: steps.length, llmCalls: 0, toolCalls: 0, retries: 0 }, steps, childRuns,
});

test("waterfall positions bars on one axis and keeps every bar visible", () => {
  const rows = waterfallRows(trace("r", 1000, [node("a", 0, 500), node("b", 500, 0)]));
  assert.equal(rows[0].leftPct, 0);
  assert.equal(rows[0].widthPct, 50);
  assert.equal(rows[1].leftPct, 50);
  assert.ok(rows[1].widthPct >= MIN_BAR_PCT, "zero-duration step must still render a sliver");
});

test("child run steps are offset by the spawning step and nested one level deeper", () => {
  const child = trace("c", 200, [node("x", 0, 200)]);
  const rows = waterfallRows(trace("r", 1000, [node("sub", 400, 300, { type: "subagent", childRun: child })]));
  assert.deepEqual(rows.map((r) => [r.runId, r.depth]), [["r", 0], ["c", 1]]);
  assert.equal(rows[1].leftPct, 40);
  assert.equal(rows[1].widthPct, 20);
});

test("a step that overruns the recorded run duration still fits the axis", () => {
  const rows = waterfallRows(trace("r", 100, [node("a", 50, 450)]));
  for (const r of rows) assert.ok(r.leftPct + r.widthPct <= 100.0001);
});

test("formatters", () => {
  assert.equal(fmtMs(0.2), "<1ms");
  assert.equal(fmtMs(350), "350ms");
  assert.equal(fmtMs(1500), "1.50s");
  assert.equal(fmtMs(75_000), "1m 15s");
  assert.equal(fmtUsd(0), "$0");
  assert.equal(fmtUsd(0.0004), "$0.00040");
  assert.equal(fmtUsd(0.5), "$0.5000");
  assert.equal(fmtUsd(12.345), "$12.35");
});

test("incident actions mirror the server's transition rules", () => {
  assert.deepEqual(incidentActions("open"), ["acknowledge", "resolve"]);
  assert.deepEqual(incidentActions("acknowledged"), ["resolve"]);
  assert.deepEqual(incidentActions("resolved"), []);
  assert.equal(incidentTone({ severity: "page", status: "open" }), "bad");
  assert.equal(incidentTone({ severity: "ticket", status: "open" }), "warn");
  assert.equal(incidentTone({ severity: "page", status: "resolved" }), "muted");
});

test("labels and budget", () => {
  assert.equal(kindLabel("anomaly:error_rate"), "Error rate anomaly");
  assert.equal(kindLabel("slo:success"), "Success SLO burn");
  assert.equal(budgetPct(-0.4), 0);
  assert.equal(budgetPct(0.756), 76);
});

const alert = (severity: "page" | "ticket") => ({ severity, longBurn: 7, shortBurn: 7, rule: "6h/30m" });

test("SLO tone is the server's alert, never a client threshold on the budget", () => {
  // 10% left would have been "bad" under the old client cutoff; no alert fired, so it is ok.
  assert.equal(sloTone({ alerts: [], budgetRemaining: 0.1 }), "ok");
  assert.equal(sloTone({ alerts: [], budgetRemaining: 0.9 }), "ok");
  assert.equal(sloTone({ alerts: [alert("ticket")], budgetRemaining: 0.9 }), "warn");
  assert.equal(sloTone({ alerts: [alert("ticket"), alert("page")], budgetRemaining: 0.9 }), "bad");
  // The one fact read off the numbers: attainment below objective = budget spent.
  assert.equal(sloTone({ alerts: [], budgetRemaining: -0.2 }), "bad");
});

test("Go burn windows are shown as 1h / 5m / 3d", () => {
  assert.equal(windowLabel("1h0m0s"), "1h");
  assert.equal(windowLabel("5m0s"), "5m");
  assert.equal(windowLabel("6h0m0s"), "6h");
  assert.equal(windowLabel("24h0m0s"), "1d");
  assert.equal(windowLabel("72h0m0s"), "3d");
  assert.equal(windowLabel("1h30m0s"), "1h 30m");
  assert.equal(windowLabel("weird"), "weird");
});

test("the server rule text is shown with short windows", () => {
  assert.equal(prettyRule("6h0m0s/30m0s >= 6x"), "6h/30m >= 6x");
  assert.equal(prettyRule("72h0m0s/6h0m0s >= 1x"), "3d/6h >= 1x");
  assert.equal(prettyRule("something else"), "something else");
});

const draft = (o: Partial<SloDraft> = {}): SloDraft => ({ objective: "0.95", latencyMs: "", costUsd: "", minScore: "", windowDays: "28", ...o });

test("SLO draft mirrors the Go validator, message for message", () => {
  const ok = parseSloDraft(draft({ latencyMs: "1500", costUsd: "0.05", minScore: "0.7" }));
  assert.deepEqual(ok, { ok: true, value: { objective: 0.95, windowDays: 28, latencyMs: 1500, costUsd: 0.05, minScore: 0.7 } });
  // Optional blanks are omitted, not sent as 0 (the server rejects 0).
  assert.deepEqual(parseSloDraft(draft()), { ok: true, value: { objective: 0.95, windowDays: 28 } });
  const err = (d: SloDraft) => { const r = parseSloDraft(d); return r.ok ? "ok" : r.error; };
  for (const bad of ["0", "1", "", "1.5", "abc"]) assert.equal(err(draft({ objective: bad })), "objective must be between 0 and 1 (exclusive)", bad);
  for (const bad of ["0", "91", "2.5", ""]) assert.equal(err(draft({ windowDays: bad })), "windowDays must be 1..90", bad);
  assert.equal(err(draft({ latencyMs: "0" })), "latencyMs and costUsd must be positive");
  assert.equal(err(draft({ latencyMs: "12.5" })), "latencyMs and costUsd must be positive"); // Go int64 rejects a fraction
  assert.equal(err(draft({ costUsd: "-1" })), "latencyMs and costUsd must be positive");
  assert.equal(err(draft({ minScore: "1.1" })), "minScore must be 0..1");
  assert.equal(parseSloDraft(draft({ minScore: "0" })).ok, true); // 0 is allowed for minScore
});

test("a half-typed decimal survives the round trip through a draft", () => {
  assert.equal(sloToDraft({ objective: 0.99, windowDays: 7, latencyMs: 900 }).latencyMs, "900");
  assert.equal(sloToDraft({ objective: 0.99, windowDays: 7 }).latencyMs, "");
});

test("prod-eval draft mirrors the server and keeps the judge model it was given", () => {
  const d: ProdEvalDraft = { enabled: true, sampleRate: "0.05", dailyBudgetUsd: "1", rubric: "" };
  assert.deepEqual(parseProdEvalDraft(d, "reasoning-large"), { ok: true, value: { enabled: true, sampleRate: 0.05, rubric: "", judgeModel: "reasoning-large", dailyBudgetUsd: 1 } });
  const msg = "sampleRate must be 0..1 and dailyBudgetUsd >= 0";
  assert.deepEqual(parseProdEvalDraft({ ...d, sampleRate: "1.2" }), { ok: false, error: msg });
  assert.deepEqual(parseProdEvalDraft({ ...d, sampleRate: "" }), { ok: false, error: msg });
  assert.deepEqual(parseProdEvalDraft({ ...d, dailyBudgetUsd: "-1" }), { ok: false, error: msg });
  assert.equal(parseProdEvalDraft({ ...d, sampleRate: "0", dailyBudgetUsd: "0" }).ok, true);
});

test("API errors show the server message, not the raw body", () => {
  const e = new Error('API 409: {"code":"conflict","error":"conflict: prod now serves \\"v1\\""}');
  assert.equal(apiErrorText(e, "x"), 'prod now serves "v1"');
  assert.equal(apiErrorText(new Error("network down"), "x"), "network down");
  assert.equal(apiErrorText(null, "fallback"), "fallback");
});

test("rollback is detected from the audit timeline", () => {
  assert.equal(wasRolledBack({ timeline: [{ at: "", actor: "a", action: "opened" }] }), false);
  assert.equal(wasRolledBack({ timeline: [{ at: "", actor: "a", action: "rollback" }] }), true);
  assert.equal(wasRolledBack({}), false);
});
