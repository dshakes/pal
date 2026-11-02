// Guards on the bridge proxy (a confused deputy: it adds the bridge bearer
// itself) and the shared session / CSRF helpers in lib/server-session.ts.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { clearSessionCache, getSession, rejectCrossSiteWrite } from "./server-session.ts";
import * as route from "../app/api/bridge/[channel]/[...path]/route.ts";
import { POST as sessionPOST } from "../app/api/auth/session/route.ts";
import { middleware } from "../middleware.ts";

const CP = "http://cp.test";
const WA = "http://wa.test";
const IM = "http://im.test";
const TENANT = "00000000-0000-0000-0000-000000000001";
const GOOD = "good-token";

interface Call { url: string; init?: RequestInit }
let calls: Call[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.PAL_API_URL = CP;
  process.env.PAL_BRIDGE_URL = WA;
  process.env.PAL_IMESSAGE_BRIDGE_URL = IM;
  process.env.PAL_BRIDGE_TOKEN = "wa-secret";
  process.env.PAL_IMESSAGE_BRIDGE_TOKEN = "im-secret";
  clearSessionCache();
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${CP}/auth/me`) {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === `Bearer ${GOOD}`) {
        return Response.json({ id: "u1", tenantId: TENANT, role: "owner" });
      }
      // tenantId present so only the status check can reject it.
      return Response.json({ error: "invalid", tenantId: TENANT }, { status: 401 });
    }
    return Response.json({ ok: true, echoed: url });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const bridgeCalls = () => calls.filter((c) => !c.url.startsWith(CP));

function req(
  method: string,
  path: string,
  opts: { token?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const headers = new Headers({ host: "dash.test", ...opts.headers });
  if (opts.token) headers.set("cookie", `pal_token=${opts.token}`);
  return new NextRequest(`http://dash.test${path}`, { method, headers, body: opts.body });
}

const JSON_SAME_ORIGIN = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

async function call(
  method: "GET" | "POST" | "DELETE",
  channel: string,
  segments: string[],
  opts: Parameters<typeof req>[2] = {},
) {
  const r = req(method, `/api/bridge/${channel}/${segments.join("/")}`, opts);
  return route[method](r, { params: Promise.resolve({ channel, path: segments }) });
}

test("no cookie → 401, bridge never called", async () => {
  const res = await call("GET", "whatsapp", ["session", TENANT, "bot"]);
  assert.equal(res.status, 401);
  assert.equal(bridgeCalls().length, 0);
});

test("invalid token → 401", async () => {
  const res = await call("POST", "whatsapp", ["session", TENANT, "send"], {
    token: "forged", headers: JSON_SAME_ORIGIN, body: "{}",
  });
  assert.equal(res.status, 401);
  assert.equal(bridgeCalls().length, 0);
});

test("tenant mismatch → 403", async () => {
  const res = await call("GET", "whatsapp", ["session", "other-tenant", "bot"], { token: GOOD });
  assert.equal(res.status, 403);
  assert.equal(bridgeCalls().length, 0);
});

test("cross-site POST → 403", async () => {
  const res = await call("POST", "whatsapp", ["session", TENANT, "send"], {
    token: GOOD,
    headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 403);
  assert.equal(bridgeCalls().length, 0);
});

test("same-site (other localhost port) POST → 403", async () => {
  const res = await call("POST", "whatsapp", ["session", TENANT, "send"], {
    token: GOOD,
    headers: { "sec-fetch-site": "same-site", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 403);
});

test("text/plain POST (no-cors simple request) → 403", async () => {
  const res = await call("POST", "whatsapp", ["session", TENANT, "send"], {
    token: GOOD,
    headers: { "sec-fetch-site": "same-origin", "content-type": "text/plain;charset=UTF-8" },
    body: '{"to":"x","text":"pwned"}',
  });
  assert.equal(res.status, 403);
  assert.equal(bridgeCalls().length, 0);
});

test("POST with no content type (Blob body) → 403", async () => {
  const res = await call("POST", "whatsapp", ["session", TENANT, "reset"], {
    token: GOOD, headers: { "sec-fetch-site": "same-origin" },
  });
  assert.equal(res.status, 403);
});

test("unknown channel → 404 (no longer falls through to WhatsApp)", async () => {
  const res = await call("GET", "telegram", ["session", TENANT, "bot"], { token: GOOD });
  assert.equal(res.status, 404);
  assert.equal(bridgeCalls().length, 0);
});

test("path outside the allowlist → 404", async () => {
  for (const segs of [["send"], ["session", TENANT], ["session", TENANT, ".."], ["session", TENANT, "../../x"], ["admin"]]) {
    const res = await call("GET", "whatsapp", segs, { token: GOOD });
    assert.equal(res.status, 404, segs.join("/"));
  }
  assert.equal(bridgeCalls().length, 0);
});

test("same-origin JSON POST with a valid session → forwarded with the bearer", async () => {
  const res = await call("POST", "imessage", ["session", TENANT, "bot", "mute"], {
    token: GOOD, headers: JSON_SAME_ORIGIN, body: '{"a":1}',
  });
  assert.equal(res.status, 200);
  const [up] = bridgeCalls();
  assert.equal(up.url, `${IM}/session/${TENANT}/bot/mute`);
  const h = new Headers(up.init?.headers);
  assert.equal(h.get("authorization"), "Bearer im-secret");
  assert.equal(h.get("content-type"), "application/json");
  assert.equal(up.init?.body, '{"a":1}');
});

test("Origin fallback: no Sec-Fetch-Site but matching Origin is accepted; mismatched rejected", async () => {
  const ok = await call("POST", "whatsapp", ["session", TENANT, "start"], {
    token: GOOD, headers: { origin: "http://dash.test", "content-type": "application/json" },
  });
  assert.equal(ok.status, 200);
  const bad = await call("POST", "whatsapp", ["session", TENANT, "start"], {
    token: GOOD, headers: { origin: "http://evil.test", "content-type": "application/json" },
  });
  assert.equal(bad.status, 403);
});

test("GET health with a session is forwarded to the right bridge", async () => {
  const res = await call("GET", "whatsapp", ["health"], { token: GOOD });
  assert.equal(res.status, 200);
  assert.equal(bridgeCalls()[0].url, `${WA}/health`);
});

test("getSession caches successes for one /auth/me call", async () => {
  assert.equal((await getSession(GOOD))?.tenantId, TENANT);
  assert.equal((await getSession(GOOD))?.tenantId, TENANT);
  assert.equal(calls.filter((c) => c.url === `${CP}/auth/me`).length, 1);
  assert.equal(await getSession("forged"), null);
  assert.equal(await getSession(undefined), null);
});

test("rejectCrossSiteWrite lets GET through and refuses headerless writes", () => {
  assert.equal(rejectCrossSiteWrite({ method: "GET", headers: new Headers() }), null);
  assert.notEqual(rejectCrossSiteWrite({ method: "POST", headers: new Headers({ "content-type": "application/json" }) }), null);
  assert.equal(
    rejectCrossSiteWrite({ method: "PUT", headers: new Headers({ "sec-fetch-site": "same-origin", "content-type": "application/json; charset=utf-8" }) }),
    null,
  );
});

test("/api/auth/session POST: login CSRF guarded (cross-site / text/plain → 403)", async () => {
  const cross = await sessionPOST(req("POST", "/api/auth/session", {
    headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: '{"token":"attacker"}',
  }));
  assert.equal(cross.status, 403);
  const plain = await sessionPOST(req("POST", "/api/auth/session", {
    headers: { "sec-fetch-site": "same-origin", "content-type": "text/plain" }, body: '{"token":"attacker"}',
  }));
  assert.equal(plain.status, 403);
});

test("middleware: /api is no longer blanket-public", async () => {
  const api = await middleware(req("GET", `/api/bridge/whatsapp/session/${TENANT}/bot`));
  assert.equal(api.status, 401);
  const forged = await middleware(req("GET", "/api/anything", { token: "forged" }));
  assert.equal(forged.status, 401);
  const ok = await middleware(req("GET", `/api/bridge/whatsapp/session/${TENANT}/bot`, { token: GOOD }));
  assert.equal(ok.headers.get("x-middleware-next"), "1");
  for (const p of ["/api/signals", "/api/auth/session"]) {
    const pub = await middleware(req("POST", p));
    assert.equal(pub.headers.get("x-middleware-next"), "1", p);
  }
  // Pages still redirect to /login rather than 401.
  const page = await middleware(req("GET", "/agents"));
  assert.equal(page.status, 307);
});
