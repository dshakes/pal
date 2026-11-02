// Same-origin proxy to the control plane: /api/pal/<path> -> PAL_API_URL/<path>.
//
// The session JWT stays in the HttpOnly `pal_token` cookie; this handler adds
// it as `Authorization: Bearer` server-side, so no page script (or XSS) can
// read or exfiltrate it. CSRF rules are in lib/pal-proxy.ts.
//
//   - Responses stream straight through (SSE included; invariant #4): the
//     upstream body is returned as-is, never buffered, and a client
//     disconnect aborts the upstream request.
//   - Login / sign-up / OAuth exchange / kiosk: the returned `token` is moved
//     into the cookie and stripped from the JSON the browser sees.
//   - POST /auth/logout revokes every session server-side, then clears the
//     cookie whatever the upstream said.
//
//   - Exactly one X-Forwarded-For hop is sent: the client IP this server
//     determined (lib/client-ip.ts, from the peer stamped by peer-ip.cjs).
//     Anything the browser sent as X-Forwarded-For / X-Real-IP / Forwarded is
//     dropped. The control plane honours it only from PAL_TRUSTED_PROXIES, so
//     list the dashboard pods there; behind an ingress, list the ingress in
//     PAL_DASHBOARD_TRUSTED_PROXIES.
//   - Request bodies are capped at MAX_REQUEST_BODY_BYTES (413); this route is
//     reachable before sign-in.

import { NextRequest, NextResponse } from "next/server";
import {
  DROP_RESPONSE_HEADERS,
  FORWARD_REQUEST_HEADERS,
  LEGACY_SESSION_COOKIE,
  MAX_REQUEST_BODY_BYTES,
  SESSION_COOKIE,
  cookieMaxAge,
  mintsSession,
  proxyRefusal,
  readCapped,
  sessionToken,
  upstreamPath,
} from "../../../../lib/pal-proxy.ts";
import { clientIp, parseCidrs, stampedPeer } from "../../../../lib/client-ip.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiBase(): string {
  return (process.env.PAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");
}

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});

const tooLarge = () => NextResponse.json({ error: "request body too large" }, { status: 413 });

/** One-release migration: a session still under the legacy cookie name is
 *  re-issued under the current one and the legacy cookie cleared.
 *  Remove after LEGACY_COOKIE_REMOVE_AFTER (lib/server-session.ts, 2027-02-01). */
function migrateLegacyCookie(req: NextRequest, res: { headers: Headers }): void {
  if (SESSION_COOKIE === LEGACY_SESSION_COOKIE) return;
  const legacy = req.cookies.get(LEGACY_SESSION_COOKIE)?.value;
  if (!legacy) return;
  const fresh = NextResponse.next();
  fresh.cookies.set(LEGACY_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  const maxAge = cookieMaxAge(legacy);
  if (!req.cookies.get(SESSION_COOKIE)?.value && maxAge) fresh.cookies.set(SESSION_COOKIE, legacy, cookieOptions(maxAge));
  for (const c of fresh.headers.getSetCookie()) res.headers.append("set-cookie", c);
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const refusal = proxyRefusal(req);
  if (refusal) return NextResponse.json({ error: "forbidden", reason: refusal }, { status: 403 });

  const path = upstreamPath((await ctx.params).path);
  if (!path) return NextResponse.json({ error: "not found" }, { status: 404 });

  const headers = new Headers();
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const ip = clientIp(stampedPeer(req.headers), req.headers.get("x-forwarded-for"), parseCidrs(process.env.PAL_DASHBOARD_TRUSTED_PROXIES));
  if (ip) headers.set("x-forwarded-for", ip);
  const token = sessionToken(req.cookies);
  if (token) headers.set("authorization", `Bearer ${token}`);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (hasBody) {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_REQUEST_BODY_BYTES) return tooLarge();
    const read = await readCapped(req.body, MAX_REQUEST_BODY_BYTES);
    if (read === null) return tooLarge();
    body = read;
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}${path}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: req.signal,
    });
  } catch {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json({ error: "control plane unreachable" }, { status: 502 });
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!DROP_RESPONSE_HEADERS.has(k)) outHeaders.set(k, v);
  });

  if (path === "/auth/logout" && req.method === "POST") {
    const res = new NextResponse(upstream.status === 204 ? null : await upstream.text(), { status: upstream.status, headers: outHeaders });
    res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
    if (SESSION_COOKIE !== LEGACY_SESSION_COOKIE) res.cookies.set(LEGACY_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }

  if (mintsSession(req.method, path) && upstream.ok && upstream.headers.get("content-type")?.includes("application/json")) {
    const body = (await upstream.json()) as Record<string, unknown>;
    const minted = typeof body.token === "string" ? body.token : null;
    if (minted) delete body.token;
    const res = NextResponse.json(body, { status: upstream.status });
    const maxAge = minted ? cookieMaxAge(minted) : null;
    if (minted && maxAge) res.cookies.set(SESSION_COOKIE, minted, cookieOptions(maxAge));
    return res;
  }

  // Stream through untouched (SSE, file contents, JSON).
  migrateLegacyCookie(req, { headers: outHeaders });
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
