import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { MAX_REQUEST_BODY_BYTES, cookieMaxAge, mintsSession, proxyRefusal, upstreamPath } from "./pal-proxy.ts";
import { buildCsp, CODE_RUNNER_WORKER_CSP } from "./security-headers.ts";
import * as route from "../app/api/pal/[...path]/route.ts";

const facts = (o: { method?: string; headers?: Record<string, string | null> }) => {
  const base: Record<string, string | null> = {
    host: "dash.example", origin: "https://dash.example", "sec-fetch-site": "same-origin",
    "sec-fetch-dest": "empty", "content-type": "application/json", ...o.headers,
  };
  const h = new Headers();
  for (const [k, v] of Object.entries(base)) if (v !== null) h.set(k, v);
  return { method: o.method ?? "POST", headers: h };
};

test("proxyRefusal: CSRF table", () => {
  const cases: Array<[string, Parameters<typeof facts>[0], boolean]> = [
    ["same-origin fetch POST", {}, true],
    ["same-origin GET", { method: "GET", headers: { origin: null } }, true],
    ["EventSource GET (dest empty, no Origin)", { method: "GET", headers: { origin: null, "content-type": null } }, true],
    ["old browser, no fetch metadata, right Origin", { headers: { "sec-fetch-site": null, "sec-fetch-dest": null } }, true],
    ["cross-site POST", { headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } }, false],
    ["cross-site GET (side-effecting GET routes)", { method: "GET", headers: { "sec-fetch-site": "cross-site", origin: null } }, false],
    ["sibling subdomain", { headers: { "sec-fetch-site": "same-site", origin: "https://evil.dash.example" } }, false],
    ["<img src> inside the dashboard", { method: "GET", headers: { "sec-fetch-dest": "image", origin: null } }, false],
    ["import() / <script src>", { method: "GET", headers: { "sec-fetch-dest": "script", origin: null } }, false],
    ["top-level navigation", { method: "GET", headers: { "sec-fetch-site": "none", "sec-fetch-dest": "document", origin: null } }, false],
    ["POST typed by the address bar (Sec-Fetch-Site none)", { headers: { "sec-fetch-site": "none" } }, false],
    ["simple text/plain POST (no preflight)", { headers: { "content-type": "text/plain" } }, false],
    ["POST without Origin or metadata", { headers: { origin: null, "sec-fetch-site": null, "sec-fetch-dest": null } }, false],
    ["POST with foreign Origin, no metadata", { headers: { origin: "https://evil.example", "sec-fetch-site": null, "sec-fetch-dest": null } }, false],
    ["DELETE with null Origin (sandboxed frame)", { method: "DELETE", headers: { origin: "null", "sec-fetch-site": null, "sec-fetch-dest": null } }, false],
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
  // No cookie: a page-supplied Authorization header is still not forwarded.
  await route.GET(req("/api/pal/v1/agents", { headers: { authorization: "Bearer FORGED", "sec-fetch-site": "same-origin" } }), params("v1", "agents"));
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), null);
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
    method: "POST", headers: { origin: "http://dash.example", "content-type": "application/json", cookie: "pal_token=OLD" },
  }), params("auth", "logout"));
  assert.match(res.headers.get("set-cookie") ?? "", /pal_token=;.*Max-Age=0/i);
});

test("route: SSE streams through unbuffered", async (t) => {
  let pull!: (s: string) => void;
  const stream = new ReadableStream<Uint8Array>({ start(c) { pull = (s) => c.enqueue(new TextEncoder().encode(s)); } });
  stubFetch(t, () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  // The upstream never closes; a proxy that buffered would never answer at all.
  const res = await Promise.race([
    route.GET(req("/api/pal/v1/runs/r1/events", { headers: { cookie: "pal_token=T", "sec-fetch-dest": "empty" } }), params("v1", "runs", "r1", "events")),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("proxy buffered the stream")), 2000)),
  ]);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  pull("event: step_started\ndata: {}\n\n");
  // The first frame arrives while the upstream is still open: nothing waited for the end.
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /step_started/);
  await reader.cancel();
});

test("route: a spoofed X-Forwarded-For from the browser is never forwarded", async (t) => {
  const calls = stubFetch(t, () => new Response("{}", { headers: { "content-type": "application/json" } }));
  const g = globalThis as { __palPeerIpPreload?: boolean };
  // Without the peer-ip.cjs preload the stamp header is client-controlled: forward nothing.
  delete g.__palPeerIpPreload;
  await route.POST(req("/api/pal/auth/forgot", {
    method: "POST", body: "{}",
    headers: { origin: "http://dash.example", "content-type": "application/json", "x-pal-peer-ip": "6.6.6.6", "x-forwarded-for": "7.7.7.7" },
  }), params("auth", "forgot"));
  assert.equal(new Headers(calls[0].init.headers).get("x-forwarded-for"), null);
  calls.length = 0;
  g.__palPeerIpPreload = true;
  t.after(() => { delete g.__palPeerIpPreload; });
  delete process.env.PAL_DASHBOARD_TRUSTED_PROXIES;
  await route.POST(req("/api/pal/auth/forgot", {
    method: "POST", body: "{}",
    headers: {
      origin: "http://dash.example", "sec-fetch-site": "same-origin", "content-type": "application/json",
      "x-pal-peer-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8", forwarded: "for=9.9.9.9",
    },
  }), params("auth", "forgot"));
  const h = new Headers(calls[0].init.headers);
  assert.equal(h.get("x-forwarded-for"), "203.0.113.9");
  assert.equal(h.get("x-real-ip"), null);
  assert.equal(h.get("forwarded"), null);
  // Behind a configured ingress, the client comes from the ingress's hop.
  process.env.PAL_DASHBOARD_TRUSTED_PROXIES = "10.0.0.0/8";
  await route.POST(req("/api/pal/auth/forgot", {
    method: "POST", body: "{}",
    headers: { origin: "http://dash.example", "content-type": "application/json", "x-pal-peer-ip": "10.0.0.5", "x-forwarded-for": "6.6.6.6, 198.51.100.7" },
  }), params("auth", "forgot"));
  assert.equal(new Headers(calls[1].init.headers).get("x-forwarded-for"), "198.51.100.7");
  delete process.env.PAL_DASHBOARD_TRUSTED_PROXIES;
});

test("route: bodies over the cap are refused (413) before anything is forwarded", async (t) => {
  const calls = stubFetch(t, () => new Response("{}"));
  const base = { origin: "http://dash.example", "content-type": "application/json" };
  const declared = await route.POST(req("/api/pal/auth/signup", {
    method: "POST", body: "{}", headers: { ...base, "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
  }), params("auth", "signup"));
  assert.equal(declared.status, 413);
  // No (or a lying) Content-Length: the streamed read is cut off at the cap.
  const big = "x".repeat(MAX_REQUEST_BODY_BYTES + 10);
  const streamed = await route.POST(new NextRequest("http://dash.example/api/pal/auth/signup", {
    method: "POST", headers: { host: "dash.example", ...base }, body: new Blob([big]).stream(), duplex: "half",
  } as RequestInit & { duplex: "half" }), params("auth", "signup"));
  assert.equal(streamed.status, 413);
  assert.equal(calls.length, 0);
  const ok = await route.POST(req("/api/pal/auth/signup", { method: "POST", body: "{\"a\":1}", headers: base }), params("auth", "signup"));
  assert.notEqual(ok.status, 413);
});

test("route: /internal is never proxied", async (t) => {
  const calls = stubFetch(t, () => new Response("{}"));
  const res = await route.POST(req("/api/pal/internal/auth/introspect-key", { method: "POST", headers: { origin: "http://dash.example", "content-type": "application/json" } }), params("internal", "auth", "introspect-key"));
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});
