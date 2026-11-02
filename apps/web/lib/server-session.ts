// Server-side dashboard session validation + same-origin write guard.
//
// Shared by middleware.ts and any Route Handler that acts with a server-held
// secret (e.g. the bridge proxy). Edge- and Node-safe: plain fetch + Web Crypto,
// no next/headers, so middleware can import it.
//
// A session is the HttpOnly `pal_token` cookie. We hold no JWT secret here, so
// the control-plane's GET /auth/me is the only authority on it.

export const SESSION_COOKIE = "pal_token";

export interface DashboardSession {
  userId: string;
  tenantId: string;
  role: string;
}

// The bridges are single-owner appliances on the owner's Mac: a session started
// for ANY tenant reads the same chat.db / Mail / contacts and sends from the
// same accounts. So only the owner tenant's owner/admin may drive them —
// "same tenant as the path" is not enough.
const DEV_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const BRIDGE_ROLES = new Set(["owner", "admin"]);

export function bridgeOwnerTenant(): string {
  return (process.env.PAL_BRIDGE_OWNER_TENANT || DEV_TENANT_ID).trim();
}

export function mayDriveBridge(session: DashboardSession): boolean {
  return session.tenantId === bridgeOwnerTenant() && BRIDGE_ROLES.has(session.role);
}

export function controlPlaneBaseUrl(): string {
  return (
    process.env.PAL_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8080"
  );
}

/** Uncached: asks the control-plane. null = unauthenticated (fails closed). */
export async function fetchSession(token: string): Promise<DashboardSession | null> {
  if (!token) return null;
  try {
    const res = await fetch(`${controlPlaneBaseUrl()}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) return null;
    const me = (await res.json()) as { id?: unknown; tenantId?: unknown; role?: unknown };
    if (typeof me.tenantId !== "string" || !me.tenantId) return null;
    return {
      userId: typeof me.id === "string" ? me.id : "",
      tenantId: me.tenantId,
      role: typeof me.role === "string" ? me.role : "",
    };
  } catch {
    return null;
  }
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 1000;
const cache = new Map<string, { session: DashboardSession; exp: number }>();

async function tokenKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Cached /auth/me (30s, keyed by SHA-256 of the token so raw tokens are never
 * map keys). Only successes are cached: a control-plane blip can't pin a
 * rejection, and a revoked token stays usable for at most CACHE_TTL_MS.
 */
export async function getSession(token: string | undefined): Promise<DashboardSession | null> {
  if (!token) return null;
  const key = await tokenKey(token);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.session;
  const session = await fetchSession(token);
  if (!session) {
    cache.delete(key);
    return null;
  }
  // ponytail: wipe-on-full instead of LRU; fine at dashboard scale.
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { session, exp: now + CACHE_TTL_MS });
  return session;
}

/** Test hook. */
export function clearSessionCache(): void {
  cache.clear();
}

/**
 * CSRF guard for state-changing requests. Returns a reason string to reject
 * with 403, or null when the request is a same-origin JSON write.
 *
 * - Sec-Fetch-Site must be `same-origin`; when a browser omits it, Origin must
 *   be present and its host must equal the request Host.
 * - Content-Type must be application/json. A cross-site page can only send a
 *   "simple" (no-preflight) POST, whose type is text/plain, form-encoded,
 *   multipart, or absent (Blob) — never JSON.
 *
 * GET/HEAD pass: they must not have side effects.
 */
export function rejectCrossSiteWrite(req: { method: string; headers: Headers }): string | null {
  if (req.method === "GET" || req.method === "HEAD") return null;

  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    if (site !== "same-origin") return `cross-site request (sec-fetch-site: ${site})`;
  } else {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    let originHost: string | null = null;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch {
      originHost = null;
    }
    if (!originHost || !host || originHost !== host) return "origin mismatch";
  }

  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return "content-type must be application/json";
  return null;
}
