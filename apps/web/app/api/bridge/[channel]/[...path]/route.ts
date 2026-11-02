// Server-side proxy for all bridge REST calls.
//
// The dashboard client never talks to the bridge directly; it calls
// /api/bridge/<channel>/<path> (same-origin) and this handler forwards
// to the real bridge with the shared secret injected from a server-only
// env var.  The token never reaches the browser.
//
// Env vars (server-only, NOT NEXT_PUBLIC):
//   PAL_BRIDGE_TOKEN            — shared secret for the WhatsApp bridge
//   PAL_IMESSAGE_BRIDGE_TOKEN   — shared secret for the iMessage bridge
//   NEXT_PUBLIC_PAL_BRIDGE_URL  — bridge base URL (URL is not a secret)
//   NEXT_PUBLIC_PAL_IMESSAGE_BRIDGE_URL
//
// Because this handler adds the bridge's bearer itself, it is a confused
// deputy unless it checks the caller first. Every request needs:
//   1. a valid dashboard session (HttpOnly pal_token, checked via /auth/me),
//   2. a known channel and an allowlisted path: `health` or
//      `session/<the session's own tenant>/...`,
//   3. for writes: same-origin + Content-Type application/json (CSRF).
// The middleware also gates /api, but it skips paths containing a dot (a
// WhatsApp jid), so this handler must not rely on it.

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, getSession, rejectCrossSiteWrite } from "../../../../../lib/server-session.ts";

type Channel = "whatsapp" | "imessage";

function isChannel(c: string): c is Channel {
  return c === "whatsapp" || c === "imessage";
}

/**
 * Upstream path for an allowlisted request, or null. Segments arrive decoded,
 * so `..`, `.`, empty and separator-bearing segments are refused and every
 * segment is re-encoded: nothing can climb out of session/<tenant>/.
 */
function bridgeUpstreamPath(segments: string[], tenantId: string): string | null {
  if (segments.some((s) => !s || s === "." || s === ".." || /[/\\]/.test(s))) return null;
  const ok =
    (segments.length === 1 && segments[0] === "health") ||
    (segments.length >= 3 && segments[0] === "session" && segments[1] === tenantId);
  return ok ? segments.map(encodeURIComponent).join("/") : null;
}

function bridgeConfig(channel: Channel): { url: string; token: string } {
  if (channel === "imessage") {
    return {
      url: (
        process.env.PAL_IMESSAGE_BRIDGE_URL ||
        (process.env.NEXT_PUBLIC_PAL_IMESSAGE_BRIDGE_URL || process.env.NEXT_PUBLIC_PAL_IMESSAGE_BRIDGE_URL) ||
        "http://localhost:3200"
      ).replace(/\/$/, ""),
      token: process.env.PAL_IMESSAGE_BRIDGE_TOKEN || "",
    };
  }
  return {
    url: (
      process.env.PAL_BRIDGE_URL ||
      (process.env.NEXT_PUBLIC_PAL_BRIDGE_URL || process.env.NEXT_PUBLIC_PAL_BRIDGE_URL) ||
      "http://localhost:3100"
    ).replace(/\/$/, ""),
    token: process.env.PAL_BRIDGE_TOKEN || "",
  };
}

async function proxyToBridge(
  req: NextRequest,
  channel: Channel,
  bridgePath: string,
): Promise<NextResponse> {
  const { url: bridgeBase, token } = bridgeConfig(channel);

  // Preserve query string from the original request.
  const search = req.nextUrl.search;
  const targetUrl = `${bridgeBase}/${bridgePath}${search}`;

  // Writes are already guaranteed JSON by rejectCrossSiteWrite; never default.
  const headers: Record<string, string> = {};
  const contentType = req.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let body: BodyInit | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Buffer the body so we can forward it.  Bridge payloads are small
    // (JSON commands), so reading into memory is fine.
    body = await req.text();
    // Remove Content-Type override for empty bodies.
    if (!body) delete headers["Content-Type"];
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body || undefined,
      // Never cache bridge responses — they are always live state.
      cache: "no-store",
    });

    const responseBody = await upstream.text();
    return new NextResponse(responseBody || null, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch (err) {
    // Bridge unreachable — surface a 503 so the client's
    // bridge_offline state triggers correctly.
    const msg = err instanceof Error ? err.message : "bridge unreachable";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}

interface RouteContext {
  params: Promise<{ channel: string; path: string[] }>;
}

async function handle(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { channel, path } = await context.params;
  if (!isChannel(channel)) {
    return NextResponse.json({ error: "unknown channel" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const csrf = rejectCrossSiteWrite(req);
  if (csrf) {
    return NextResponse.json({ error: csrf }, { status: 403 });
  }
  if (path[0] === "session" && path[1] !== undefined && path[1] !== session.tenantId) {
    return NextResponse.json({ error: "tenant mismatch" }, { status: 403 });
  }
  const upstreamPath = bridgeUpstreamPath(path, session.tenantId);
  if (!upstreamPath) {
    return NextResponse.json({ error: "path not allowed" }, { status: 404 });
  }
  return proxyToBridge(req, channel, upstreamPath);
}

export function GET(req: NextRequest, context: RouteContext) {
  return handle(req, context);
}

export function POST(req: NextRequest, context: RouteContext) {
  return handle(req, context);
}

export function PUT(req: NextRequest, context: RouteContext) {
  return handle(req, context);
}

export function DELETE(req: NextRequest, context: RouteContext) {
  return handle(req, context);
}

export function PATCH(req: NextRequest, context: RouteContext) {
  return handle(req, context);
}
