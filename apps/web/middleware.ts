import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, fetchSession } from "./lib/server-session.ts";

const PUBLIC_PREFIXES = ["/login", "/onboarding", "/auth", "/kiosk"];

// Only these API routes are reachable without a session:
//   /api/signals       — iPhone Shortcuts sink; its own PAL_SIGNAL_TOKEN, fail-closed
//   /api/auth/session  — sets/clears the cookie at login/logout (CSRF-guarded)
// Every other /api route needs a valid session, and should re-check it itself:
// the matcher below skips any path containing a dot.
const PUBLIC_API = new Set(["/api/signals", "/api/auth/session"]);

function isPublic(pathname: string): boolean {
  return PUBLIC_API.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

// Redirect to /login and clear the (invalid/expired/forged) cookie so the
// browser stops re-sending it and the user gets a clean re-auth.
function redirectToLogin(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", pathname);
  const res = NextResponse.redirect(loginUrl);
  res.cookies.delete("pal_token");
  return res;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) {
    return NextResponse.next();
  }
  const isApi = pathname === "/api" || pathname.startsWith("/api/");

  const token = request.cookies.get(SESSION_COOKIE)?.value;

  // Presence is necessary but NOT sufficient — a non-empty cookie used to be
  // enough to authenticate, which let a garbage value (or a client-minted
  // demo_token_*) through. We now hand the token to the control-plane's
  // /auth/me, which validates the HS256 signature + expiry with the shared
  // JWT_SECRET we don't (and shouldn't) hold here. Non-200 → unauthenticated.
  // Uncached on purpose (never serve a stale auth decision to a navigation);
  // fetchSession fails closed on network error / timeout.
  const valid = token ? (await fetchSession(token)) !== null : false;

  if (!valid) {
    // An API caller wants a status, not an HTML login redirect.
    if (isApi) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return redirectToLogin(request);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|favicon\\.ico|.*\\..*).*)"],
};
