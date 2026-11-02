import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { WsTicketStore, authorizeWs, allowedWsOrigins, type WsAuthInput } from "./bridge-ws-auth.ts";
import { tokenPolicy } from "./bridge-http-guard.ts";

const allowed = allowedWsOrigins(undefined, {});
const enforce = tokenPolicy("s3cret", "PAL_BRIDGE_TOKEN", {});
const base = (tickets: WsTicketStore, over: Partial<WsAuthInput> = {}): WsAuthInput => ({
  origin: undefined, allowedOrigins: allowed, policy: enforce, token: "s3cret", tenantId: "t1", tickets, ...over,
});

describe("WsTicketStore", () => {
  test("single use", () => {
    const s = new WsTicketStore();
    const { ticket } = s.issue("t1", 1000);
    assert.equal(s.redeem(ticket, "t1", 1001), true);
    assert.equal(s.redeem(ticket, "t1", 1002), false);
  });
  test("expires after the TTL", () => {
    const s = new WsTicketStore(60_000);
    const { ticket } = s.issue("t1", 0);
    assert.equal(s.redeem(ticket, "t1", 60_001), false);
  });
  test("bound to the tenant; a wrong-tenant attempt burns it", () => {
    const s = new WsTicketStore();
    const { ticket } = s.issue("t1", 0);
    assert.equal(s.redeem(ticket, "t2", 1), false);
    assert.equal(s.redeem(ticket, "t1", 2), false);
  });
  test("unknown / missing tickets fail; store is bounded", () => {
    const s = new WsTicketStore(60_000, 3);
    assert.equal(s.redeem("nope", "t1"), false);
    assert.equal(s.redeem(undefined, "t1"), false);
    for (let i = 0; i < 10; i++) s.issue("t1", 0);
    assert.ok((s as unknown as { tickets: Map<string, unknown> }).tickets.size <= 3);
  });
});

describe("authorizeWs", () => {
  test("a foreign Origin is refused even with a valid ticket", () => {
    const s = new WsTicketStore();
    const { ticket } = s.issue("t1");
    const r = authorizeWs(base(s, { origin: "https://evil.example", ticket }));
    assert.deepEqual(r, { ok: false, status: 403, reason: "origin not allowed" });
  });
  test("dashboard origin without ticket/token is refused (401)", () => {
    const r = authorizeWs(base(new WsTicketStore(), { origin: "http://localhost:3001" }));
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 401);
  });
  test("no Origin (non-browser) and no credentials is refused", () => {
    assert.equal(authorizeWs(base(new WsTicketStore())).ok, false);
  });
  test("dashboard origin + fresh ticket is accepted once, then refused", () => {
    const s = new WsTicketStore();
    const { ticket } = s.issue("t1");
    assert.equal(authorizeWs(base(s, { origin: "http://localhost:3001", ticket })).ok, true);
    assert.equal(authorizeWs(base(s, { origin: "http://localhost:3001", ticket })).ok, false);
  });
  test("Bearer token works for non-browser clients; a wrong token does not", () => {
    assert.equal(authorizeWs(base(new WsTicketStore(), { bearer: "s3cret" })).ok, true);
    assert.equal(authorizeWs(base(new WsTicketStore(), { bearer: "wrong!" })).ok, false);
  });
  test("token unset => refused outright (fail-closed), even from the dashboard", () => {
    const policy = tokenPolicy("", "PAL_BRIDGE_TOKEN", {});
    const s = new WsTicketStore();
    const { ticket } = s.issue("t1");
    const r = authorizeWs(base(s, { policy, token: "", origin: "http://localhost:3001", ticket }));
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 403);
  });
  test("dev hatch opens auth but NOT the Origin check", () => {
    const policy = tokenPolicy("", "PAL_BRIDGE_TOKEN", { PAL_BRIDGE_ALLOW_NO_TOKEN: "1" });
    assert.equal(authorizeWs(base(new WsTicketStore(), { policy, token: "", origin: "http://localhost:3001" })).ok, true);
    assert.equal(authorizeWs(base(new WsTicketStore(), { policy, token: "", origin: "https://evil.example" })).ok, false);
  });
  test("origin allowlist: defaults, CORS list and env; '*' is never honoured", () => {
    const o = allowedWsOrigins("http://dash.local:3001/, *", { PAL_BRIDGE_ALLOWED_ORIGINS: "https://x.example" });
    assert.ok(o.includes("http://localhost:3001") && o.includes("http://127.0.0.1:3001"));
    assert.ok(o.includes("http://dash.local:3001") && o.includes("https://x.example"));
    assert.ok(!o.includes("*"));
  });
});
