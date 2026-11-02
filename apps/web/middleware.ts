import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildCsp } from "./lib/security-headers";

const PUBLIC_PATHS = ["/login", "/onboarding", "/api", "/auth", "/kiosk"];

// The control-plane base URL. Server-side env (PAL_API_URL) wins; the
// public URL is the next.config rewrite target. Falls back to local dev.
function controlPlaneBaseUrl(): string {
  return (
    process.env.PAL_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8080"
  );
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

// Every page gets a fresh CSP nonce (lib/security-headers.ts). The request
// header lets Next stamp its own scripts and app/layout.tsx read x-nonce.
function withCsp(request: NextRequest): { headers: Headers; csp: string } {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  return { headers, csp };
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const { headers, csp } = withCsp(request);
  const next = () => {
    const r = NextResponse.next({ request: { headers } });
    r.headers.set("Content-Security-Policy", csp);
    return r;
  };

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return next();
  }

  const token = request.cookies.get("pal_token")?.value;

  // Presence is necessary but NOT sufficient — a non-empty cookie used to be
  // enough to authenticate, which let a garbage value (or a client-minted
  // demo_token_*) through. We now hand the token to the control-plane's
  // /auth/me, which validates the HS256 signature, expiry and revocation
  // (token_version) with state we don't (and shouldn't) hold here.
  if (!token) {
    return redirectToLogin(request);
  }

  let valid = false;
  try {
    const res = await fetch(`${controlPlaneBaseUrl()}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      // Never serve a cached auth decision.
      cache: "no-store",
      // Don't let a slow/unreachable control-plane hang every navigation.
      signal: AbortSignal.timeout(5000),
    });
    valid = res.status === 200;
  } catch {
    // Network failure / timeout reaching the control-plane. Fail closed —
    // an unverifiable token is treated as unauthenticated.
    valid = false;
  }

  if (!valid) {
    return redirectToLogin(request);
  }

  return next();
}

export const config = {
  matcher: ["/((?!_next|favicon\\.ico|.*\\..*).*)"],
};
