import test from "node:test";
import assert from "node:assert/strict";
import { clipToComplete, PROMOTION_LIMIT_MAX, filterAudit, mergeAudit, nextPromotionLimit, parsePromotionAudit, parseSandboxAudit, summarizeDetail } from "./audit.ts";

const promo = [
  { id: 7, agentName: "support", env: "prod", action: "approved", actor: "ada@x.co", actorKind: "human", detail: { note: "ship it", token: "abc123", gates: { a: 1 } }, createdAt: "2026-10-30T10:00:00Z" },
  { id: 1, agentName: "support", env: "staging", action: "proposed", actor: "key:ci", actorKind: "api_key", detail: {}, createdAt: "2026-10-29T10:00:00Z" },
];
const sandbox = { events: [
  { id: 7, tenantId: "t", vmId: "vm-1", action: "egress_deny", attrs: { host: "evil.example", api_key: "sk-live" }, principalId: "spiffe://x", at: "2026-10-30T11:00:00Z" },
  { id: 6, action: "spawn", attrs: null, at: "2026-10-28T11:00:00Z" },
], nextBefore: 6 };

test("detail never shows values for sensitive-looking keys, only primitives, truncated", () => {
  const d = summarizeDetail({ note: "ship it", token: "abc123", gates: { a: 1 }, n: 3, ok: true, bearer_value: "x" });
  assert.equal(d, "note=ship it token=[hidden] n=3 ok=true bearer_value=[hidden]");
  assert.ok(!d.includes("abc123"));
  assert.ok(summarizeDetail({ a: "x".repeat(500) }).length <= 160);
  assert.equal(summarizeDetail(null), "");
});

test("promotion and sandbox rows keep distinct keys even when ids collide (id 7 in both)", () => {
  const merged = mergeAudit(parsePromotionAudit(promo), parseSandboxAudit(sandbox).rows);
  assert.equal(merged.length, 4);
  assert.equal(new Set(merged.map((r) => r.key)).size, 4);
  assert.deepEqual(merged.map((r) => r.key), ["sandbox:7", "promotion:7", "promotion:1", "sandbox:6"]);
});

test("merging the same page twice does not duplicate rows (load-more overlap)", () => {
  const p = parsePromotionAudit(promo);
  assert.equal(mergeAudit(p, p).length, 2);
});

test("malformed rows are dropped, not rendered", () => {
  assert.deepEqual(parsePromotionAudit({ nope: 1 }), []);
  assert.equal(parsePromotionAudit([{ id: "x", action: "a", createdAt: "t" }, null, 5]).length, 0);
  assert.deepEqual(parseSandboxAudit(null), { rows: [], nextBefore: 0, count: 0 });
  assert.equal(parseSandboxAudit({ events: [{ id: 1 }] }).rows.length, 0);
});

test("sandbox actor falls back to system; page reports count + cursor for load-older", () => {
  const p = parseSandboxAudit(sandbox);
  assert.equal(p.rows[1].actor, "system");
  assert.equal(p.nextBefore, 6);
  assert.equal(p.count, 2);
});

test("filterAudit by source and free text", () => {
  const rows = mergeAudit(parsePromotionAudit(promo), parseSandboxAudit(sandbox).rows);
  assert.equal(filterAudit(rows, "promotion", "").length, 2);
  assert.equal(filterAudit(rows, "all", "EVIL").length, 1);
  assert.equal(filterAudit(rows, "sandbox", "support").length, 0);
  assert.equal(filterAudit(rows, "all", "  ").length, 4);
});

test("promotion limit grows to the server cap and stops there (over the cap the server resets to 100)", () => {
  const seen = [100];
  for (let n = nextPromotionLimit(100); n !== null; n = nextPromotionLimit(n)) { seen.push(n); assert.ok(n <= PROMOTION_LIMIT_MAX); }
  assert.equal(seen[seen.length - 1], PROMOTION_LIMIT_MAX);
  assert.equal(nextPromotionLimit(PROMOTION_LIMIT_MAX), null);
});

test("clipToComplete: with two capped streams, older rows of the longer-reaching one are clipped", () => {
  const rows = mergeAudit(
    parsePromotionAudit([
      { id: 3, action: "a", createdAt: "2026-10-30T00:00:00Z" },
      { id: 2, action: "a", createdAt: "2026-10-20T00:00:00Z" },
    ]),
    parseSandboxAudit({ events: [
      { id: 9, action: "x", at: "2026-10-29T00:00:00Z" },
      { id: 8, action: "x", at: "2026-10-25T00:00:00Z" },
      { id: 7, action: "x", at: "2026-10-26T00:00:00Z" },
    ], nextBefore: 7 }).rows,
  );
  const both = clipToComplete(rows, { promotion: true, sandbox: true });
  assert.equal(both.cutoff, Date.parse("2026-10-25T00:00:00Z"));
  assert.deepEqual(both.rows.map((r) => r.key).sort(), ["promotion:3", "sandbox:7", "sandbox:8", "sandbox:9"]);
  assert.equal(clipToComplete(rows, { promotion: true }).cutoff, Date.parse("2026-10-20T00:00:00Z"));
  const none = clipToComplete(rows, {});
  assert.equal(none.cutoff, null);
  assert.equal(none.rows.length, rows.length);
});
