import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { cookieMaxAge, mintsSession, proxyRefusal, upstreamPath } from "./pal-proxy.ts";
import { buildCsp, CODE_RUNNER_WORKER_CSP } from "./security-headers.ts";
import * as route from "../app/api/pal/[...path]/route.ts";

const facts = (o: Partial<Parameters<typeof proxyRefusal>[0]>) => ({
  method: "POST", host: "dash.example", origin: "https://dash.example",
  secFetchSite: "same-origin", secFetchDest: "empty", ...o,
});

test("proxyRefusal: CSRF table", () => {
  const cases: Array<[string, Partial<Parameters<typeof proxyRefusal>[0]>, boolean]> = [
    ["same-origin fetch POST", {}, true],
    ["same-origin GET", { method: "GET", origin: null }, true],
    ["EventSource GET (dest empty)", { method: "GET", origin: null }, true],
    ["old browser, no fetch metadata, right Origin", { secFetchSite: null, secFetchDest: null }, true],
    ["Origin matches X-Forwarded-Host", { host: "10.0.0.7:3000", forwardedHost: "dash.example" }, true],
    ["cross-site POST", { secFetchSite: "cross-site", origin: "https://evil.example" }, false],
    ["cross-site GET (side-effecting GET routes)", { method: "GET", secFetchSite: "cross-site", origin: null }, false],
    ["sibling subdomain", { secFetchSite: "same-site", origin: "https://evil.dash.example" }, false],
    ["<img src> inside the dashboard", { method: "GET", secFetchDest: "image", origin: null }, false],
    ["import() / <script src>", { method: "GET", secFetchDest: "script", origin: null }, false],
    ["top-level navigation", { method: "GET", secFetchSite: "none", secFetchDest: "document", origin: null }, false],
    ["POST without Origin", { origin: null, secFetchSite: null, secFetchDest: null }, false],
    ["POST with foreign Origin, no metadata", { origin: "https://evil.example", secFetchSite: null, secFetchDest: null }, false],
    ["DELETE with null Origin (sandboxed frame)", { method: "DELETE", origin: "null", secFetchSite: null, secFetchDest: null }, false],
  ];
  for (const [name, o, ok] of cases) {
    assert.equal(proxyRefusal(facts(o)) === null, ok, name);
  }
});

test("upstreamPath: only /v1 and /auth, no traversal", () => {
  assert.equal(upstreamPath(["v1", "agents"]), "/v1/agents");
  assert.equal(upstreamPath(["v1", "agents", "a b"]), "/v1/agents/a%20b");
  assert.equal(upstreamPath(["auth", "me"]), "/auth/me");
  for (const bad of [["internal", "auth", "introspect-key"], ["v1"], ["v1", ".."], ["v1", "..", "internal"], ["v1", "a/b"], ["mcp", "x"], ["v1", ""]]) {
    assert.equal(upstreamPath(bad), null, bad.join("/"));
  }
});

test("mintsSession + cookieMaxAge", () => {
  assert.ok(mintsSession("POST", "/auth/login"));
  assert.ok(mintsSession("post", "/v1/kiosk/session"));
  assert.ok(!mintsSession("GET", "/auth/login"));
  assert.ok(!mintsSession("POST", "/v1/agents"));
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
  assert.equal(cookieMaxAge(jwt(1_000 + 3600), 1_000), 3600);
  assert.equal(cookieMaxAge(jwt(900), 1_000), null);
  assert.equal(cookieMaxAge("garbage", 1_000), null);
});

test("CSP: nonce'd, no unsafe-eval in prod, framing denied; worker has no network", () => {
  const prod = buildCsp("abc", false);
  assert.match(prod, /script-src 'self' 'nonce-abc' 'strict-dynamic'/);
  assert.doesNotMatch(prod, /unsafe-eval/);
  assert.doesNotMatch(prod, /script-src[^;]*unsafe-inline/);
  assert.match(prod, /frame-ancestors 'none'/);
  assert.match(prod, /object-src 'none'/);
  assert.match(prod, /connect-src 'self'(;|$)/);
  assert.match(buildCsp("abc", true), /unsafe-eval/);
  assert.match(CODE_RUNNER_WORKER_CSP, /default-src 'none'/);
});

// ---- the route handler itself (fetch stubbed) ----

type Call = { url: string; init: RequestInit };
function stubFetch(t: import("node:test").TestContext, respond: (c: Call) => Response): Call[] {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = real; });
  return calls;
}
const params = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new NextRequest(`http://dash.example${path}`, { method: init.method ?? "GET", headers: { host: "dash.example", ...init.headers }, body: init.body });

test("route: a cross-site POST is refused before anything is forwarded", async (t) => {
  const calls = stubFetch(t, () => new Response("{}"));
  const res = await route.POST(req("/api/pal/v1/runs", {
    method: "POST", body: "{}",
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-dest": "empty", cookie: "pal_token=T" },
  }), params("v1", "runs"));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("route: forwards the cookie as Bearer, never the browser's Authorization", async (t) => {
  process.env.PAL_API_URL = "http://cp.internal:8080";
  const calls = stubFetch(t, () => new Response('{"ok":true}', { headers: { "content-type": "application/json", "set-cookie": "x=y" } }));
  const res = await route.GET(req("/api/pal/v1/agents?limit=2", {
    headers: { cookie: "pal_token=SESSION", authorization: "Bearer FORGED", "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" },
  }), params("v1", "agents"));
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, "http://cp.internal:8080/v1/agents?limit=2");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer SESSION");
  assert.equal(res.headers.get("set-cookie"), null);
});

test("route: login moves the token into an HttpOnly cookie and out of the body", async (t) => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const tok = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
  stubFetch(t, () => new Response(JSON.stringify({ token: tok, user: { id: "u" } }), { headers: { "content-type": "application/json" } }));
  const res = await route.POST(req("/api/pal/auth/login", {
    method: "POST", body: "{}", headers: { origin: "http://dash.example", "sec-fetch-site": "same-origin", "content-type": "application/json" },
  }), params("auth", "login"));
  const body = await res.json();
  assert.equal(body.token, undefined);
  assert.equal(body.user.id, "u");
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`pal_token=${tok.replace(/\./g, "\\.")}`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=lax/i);
});

test("route: logout clears the cookie even when the control plane refuses", async (t) => {
  stubFetch(t, () => new Response('{"error":"unauthorized"}', { status: 401 }));
  const res = await route.POST(req("/api/pal/auth/logout", {
    method: "POST", headers: { origin: "http://dash.example", cookie: "pal_token=OLD" },
  }), params("auth", "logout"));
  assert.match(res.headers.get("set-cookie") ?? "", /pal_token=;.*Max-Age=0/i);
});

test("route: SSE streams through unbuffered", async (t) => {
  let pull!: (s: string) => void;
  const stream = new ReadableStream<Uint8Array>({ start(c) { pull = (s) => c.enqueue(new TextEncoder().encode(s)); } });
  stubFetch(t, () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  const res = await route.GET(req("/api/pal/v1/runs/r1/events", { headers: { cookie: "pal_token=T", "sec-fetch-dest": "empty" } }), params("v1", "runs", "r1", "events"));
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  pull("event: step_started\ndata: {}\n\n");
  // The first frame arrives while the upstream is still open: nothing waited for the end.
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /step_started/);
  await reader.cancel();
});

test("route: /internal is never proxied", async (t) => {
  const calls = stubFetch(t, () => new Response("{}"));
  const res = await route.POST(req("/api/pal/internal/auth/introspect-key", { method: "POST", headers: { origin: "http://dash.example" } }), params("internal", "auth", "introspect-key"));
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});
