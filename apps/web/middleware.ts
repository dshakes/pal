import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE, fetchSession, sessionToken } from "./lib/server-session.ts";
import { buildCsp } from "./lib/security-headers.ts";

const PUBLIC_PREFIXES = ["/login", "/onboarding", "/auth", "/kiosk"];

// Only these API routes are reachable without a session:
//   /api/signals  — iPhone Shortcuts sink; its own PAL_SIGNAL_TOKEN, fail-closed
//   /api/pal/*    — the same-origin control-plane proxy. It must serve sign-in
//                   and the other pre-auth /auth/* calls, and the control plane
//                   authenticates everything else itself from the forwarded
//                   cookie. Its CSRF guard is lib/pal-proxy.ts.
// Every other /api route needs a valid session, and should re-check it itself:
// the matcher below skips any path containing a dot.
const PUBLIC_API = new Set(["/api/signals"]);

function isPublic(pathname: string): boolean {
  return PUBLIC_API.has(pathname) || pathname.startsWith("/api/pal/") || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

// Redirect to /login and clear the (invalid/expired/forged/revoked) cookie so
// the browser stops re-sending it and the user gets a clean re-auth.
function redirectToLogin(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", pathname);
  const res = NextResponse.redirect(loginUrl);
  res.cookies.delete(SESSION_COOKIE);
  res.cookies.delete(LEGACY_SESSION_COOKIE);
  return res;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Every page gets a fresh CSP nonce (lib/security-headers.ts). The request
  // header lets Next stamp its own scripts and app/layout.tsx read x-nonce.
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const next = () => {
    const r = NextResponse.next({ request: { headers } });
    r.headers.set("Content-Security-Policy", csp);
    return r;
  };

  if (isPublic(pathname)) {
    return next();
  }
  const isApi = pathname === "/api" || pathname.startsWith("/api/");

  const token = sessionToken(request.cookies);

  // Presence is necessary but NOT sufficient — a non-empty cookie used to be
  // enough to authenticate, which let a garbage value (or a client-minted
  // demo_token_*) through. We now hand the token to the control-plane's
  // /auth/me, which validates the signature, expiry and revocation
  // (token_version) with state we don't (and shouldn't) hold here.
  // Uncached on purpose (never serve a stale auth decision to a navigation);
  // fetchSession fails closed on network error / timeout.
  const valid = token ? (await fetchSession(token)) !== null : false;

  if (!valid) {
    // An API caller wants a status, not an HTML login redirect.
    if (isApi) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return redirectToLogin(request);
  }

  return next();
}

export const config = {
  matcher: ["/((?!_next|favicon\\.ico|.*\\..*).*)"],
};
