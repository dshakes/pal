// Pure rules for the same-origin API proxy (app/api/pal/[...path]/route.ts).
//
// The browser never holds the session JWT: it lives in the HttpOnly
// `pal_token` cookie and the proxy turns it into `Authorization: Bearer` on
// the server side. A cookie that rides along automatically is a CSRF target,
// so every proxied request must look like the dashboard's own fetch():
//
//   - Writes go through the shared guard (lib/server-session.ts
//     rejectCrossSiteWrite): Sec-Fetch-Site same-origin, or a same-host
//     Origin when the browser sends no fetch metadata, and a JSON body.
//   - Reads too, because some GET routes have side effects (e.g.
//     GET /v1/connectors/{id}/execute): Sec-Fetch-Site, when sent, must be
//     same-origin (or "none"), refusing cross-site and sibling-subdomain GETs.
//   - Sec-Fetch-Dest, when sent, must be "empty" (fetch / EventSource). This
//     refuses <img src>, <script src>, import() and navigations, so injected
//     markup inside the dashboard cannot fire authenticated requests either.
// The cookie itself is SameSite=Lax, so other sites' subresource requests do
// not carry it in the first place.

import { rejectCrossSiteWrite } from "./server-session.ts";

export { SESSION_COOKIE } from "./server-session.ts";

/** Why the proxy must refuse this request, or null when it may forward it. */
export function proxyRefusal(req: { method: string; headers: Headers }): string | null {
  const site = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return `cross-site request (Sec-Fetch-Site: ${site})`;
  const dest = req.headers.get("sec-fetch-dest")?.toLowerCase();
  if (dest && dest !== "empty") return `not a fetch (Sec-Fetch-Dest: ${dest})`;
  return rejectCrossSiteWrite({ method: req.method.toUpperCase(), headers: req.headers });
}

/**
 * The control-plane path a proxy path maps to, or null when it must not be
 * proxied. Only the public API surface: /v1/* and /auth/*. Never /internal/*
 * (service-token routes), and no dot segments or embedded slashes.
 */
export function upstreamPath(segments: readonly string[]): string | null {
  if (segments.length < 2) return null;
  if (segments[0] !== "v1" && segments[0] !== "auth") return null;
  for (const s of segments) {
    if (s === "" || s === "." || s === ".." || s.includes("/") || s.includes("\\")) return null;
  }
  return "/" + segments.map(encodeURIComponent).join("/");
}

/** Responses to these calls carry a fresh session `token`, which the proxy
 *  moves into the HttpOnly cookie instead of handing it to JavaScript. */
const SESSION_MINTING = new Set(["/auth/login", "/auth/signup", "/auth/oauth/exchange", "/v1/kiosk/session"]);

export function mintsSession(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && SESSION_MINTING.has(path);
}

/** Cookie lifetime in seconds = the JWT's remaining lifetime (exp - now),
 *  so the cookie never outlives the session. Null when unreadable/expired. */
export function cookieMaxAge(jwt: string, nowSec: number = Math.floor(Date.now() / 1000)): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: unknown };
    if (typeof json.exp !== "number") return null;
    const left = Math.floor(json.exp - nowSec);
    return left > 0 ? left : null;
  } catch {
    return null;
  }
}

/** Request headers worth forwarding upstream. Authorization is NEVER taken
 *  from the browser: the proxy sets it from the cookie. */
export const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "idempotency-key", "last-event-id", "x-forwarded-for", "x-request-id"];

/** Response headers never copied back (hop-by-hop, re-encoded by fetch, or cookies). */
export const DROP_RESPONSE_HEADERS = new Set(["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);
