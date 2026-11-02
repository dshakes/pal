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
// Deploy note: the control plane rate-limits sign-in per client IP. It sees
// this server as the peer, so the dashboard must be inside PAL_TRUSTED_PROXIES
// (it forwards X-Forwarded-For); otherwise every sign-in shares one bucket.

import { NextRequest, NextResponse } from "next/server";
import {
  DROP_RESPONSE_HEADERS,
  FORWARD_REQUEST_HEADERS,
  SESSION_COOKIE,
  cookieMaxAge,
  mintsSession,
  proxyRefusal,
  upstreamPath,
} from "../../../../lib/pal-proxy.ts";

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
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) headers.set("authorization", `Bearer ${token}`);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}${path}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      // Request bodies are small JSON/file payloads; buffering them is fine.
      body: hasBody ? await req.arrayBuffer() : undefined,
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
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
