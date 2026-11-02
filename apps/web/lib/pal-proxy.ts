// Pure rules for the same-origin API proxy (app/api/pal/[...path]/route.ts).
//
// The browser never holds the session JWT: it lives in the HttpOnly
// `pal_token` cookie and the proxy turns it into `Authorization: Bearer` on
// the server side. A cookie that rides along automatically is a CSRF target,
// so every proxied request must look like the dashboard's own fetch():
//
//   - Sec-Fetch-Site, when sent, must be same-origin (or "none"). This refuses
//     cross-site AND sibling-subdomain requests, including GETs (some GET
//     routes have side effects, e.g. GET /v1/connectors/{id}/execute).
//   - Sec-Fetch-Dest, when sent, must be "empty" (fetch / EventSource). This
//     refuses <img src>, <script src>, import() and navigations, so injected
//     markup inside the dashboard cannot fire authenticated requests either.
//   - State-changing methods must carry an Origin equal to this host. Browsers
//     always send Origin on those, and a page cannot forge it.
// The cookie itself is SameSite=Lax, so other sites' subresource requests do
// not carry it in the first place.

export const SESSION_COOKIE = "pal_token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface ProxyRequestFacts {
  method: string;
  host: string | null;
  forwardedHost?: string | null;
  origin: string | null;
  secFetchSite: string | null;
  secFetchDest: string | null;
}

/** Why the proxy must refuse this request, or null when it may forward it. */
export function proxyRefusal(r: ProxyRequestFacts): string | null {
  const site = r.secFetchSite?.toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return `cross-site request (Sec-Fetch-Site: ${site})`;
  const dest = r.secFetchDest?.toLowerCase();
  if (dest && dest !== "empty") return `not a fetch (Sec-Fetch-Dest: ${dest})`;
  if (SAFE_METHODS.has(r.method.toUpperCase())) return null;
  if (!r.origin) return "missing Origin header";
  let originHost: string;
  try {
    originHost = new URL(r.origin).host;
  } catch {
    return "malformed Origin header";
  }
  const hosts = [r.host, r.forwardedHost?.split(",")[0]?.trim()].filter(Boolean);
  if (!hosts.includes(originHost)) return "cross-origin request";
  return null;
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
