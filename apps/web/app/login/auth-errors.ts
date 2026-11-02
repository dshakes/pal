// Maps sign-in / sign-up failures to clear, actionable copy. Pure — tested in
// auth-errors.test.mts. Input is the Error thrown by lib/api (messages look
// like `API <status>: <json body>`; a fetch TypeError means the API is down).

import { runtimeApiUrl } from "../../lib/runtime-config.ts";

export type AuthErrorKind = "rate_limited" | "unverified" | "invalid" | "unreachable" | "server" | "closed" | "other";

export interface AuthErrorView {
  kind: AuthErrorKind;
  message: string;
}

function serverReason(body: string): string | null {
  try {
    const v = JSON.parse(body) as { error?: unknown };
    return typeof v.error === "string" && v.error ? v.error : null;
  } catch {
    return null;
  }
}

export function describeAuthError(
  err: unknown,
  mode: "signin" | "signup",
  apiUrl: string = runtimeApiUrl() || "this dashboard's own origin",
): AuthErrorView {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return { kind: "unreachable", message: `Can't reach PAL at ${apiUrl}. Check that the dashboard address matches the one the API allows (CORS), that the API is up, and your connection.` };
  }
  if (/email_unverified|Verify your email/i.test(msg)) {
    return { kind: "unverified", message: "Verify your email first — we sent you a link. Didn't get it? Send a new one below." };
  }
  const m = msg.match(/API (\d+): ([\s\S]*)/);
  const status = m ? Number(m[1]) : 0;
  const reason = m ? serverReason(m[2]) : null;
  if (status === 429) {
    return { kind: "rate_limited", message: "Too many attempts. For your security, wait a few minutes before trying again." };
  }
  if (status === 401 || (mode === "signin" && /invalid credentials/i.test(msg))) {
    return { kind: "invalid", message: "Incorrect email or password." };
  }
  if (status >= 500) {
    return { kind: "server", message: "Something went wrong on our side. Try again in a moment." };
  }
  if (mode === "signup" && reason && /closed|invite/i.test(reason)) {
    return { kind: "closed", message: reason.charAt(0).toUpperCase() + reason.slice(1) };
  }
  if (reason) return { kind: "other", message: reason.charAt(0).toUpperCase() + reason.slice(1) };
  return { kind: "other", message: mode === "signin" ? "Couldn't sign in. Check your email and password." : "Couldn't create your account. Try again." };
}

/** Same-origin path only — never an open redirect. Defaults to "/". */
export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.startsWith("/login")) return "/";
  return raw;
}

// OAuth callback failures come back as /login?error=<code>[&provider=…]. Only
// these known codes map to copy; anything else gets the generic line. The raw
// query text is never rendered (it is attacker-controllable in a crafted link).
const OAUTH_ERROR_COPY: Record<string, { kind: AuthErrorKind; message: (p: string) => string }> = {
  email_unverified: { kind: "unverified", message: (p) => `Your ${p} email address isn't verified. Verify it with ${p}, then try again.` },
  link_refused: { kind: "other", message: () => "An account with this email already exists. Sign in with your password, then connect it in settings." },
  signup_closed: { kind: "closed", message: () => "Sign-up is closed on this workspace. Ask an admin for an invite." },
  invite_required: { kind: "closed", message: () => "This workspace is invite-only. Enter your invite code, then sign in again." },
  signup_rate_limited: { kind: "rate_limited", message: () => "Too many sign-up attempts. Wait a few minutes and try again." },
  signup_unavailable: { kind: "server", message: () => "Sign-up is temporarily unavailable. Try again shortly." },
  state_invalid: { kind: "other", message: () => "That sign-in wasn't started in this browser. Start it again from here." },
  state_expired: { kind: "other", message: () => "That sign-in link expired or was already used. Start it again." },
  oauth_denied: { kind: "other", message: (p) => `Sign-in with ${p} was cancelled.` },
  oauth_failed: { kind: "server", message: (p) => `We couldn't complete sign-in with ${p}. Try again or use email.` },
  internal: { kind: "server", message: () => "Something went wrong on our side. Try again shortly." },
};

const OAUTH_PROVIDER_NAMES: Record<string, string> = { google: "Google", github: "GitHub" };

export function oauthErrorMessage(code: string | null, provider: string | null): AuthErrorView | null {
  if (!code) return null;
  const p = (provider && Object.hasOwn(OAUTH_PROVIDER_NAMES, provider) && OAUTH_PROVIDER_NAMES[provider]) || "your provider";
  const entry = Object.hasOwn(OAUTH_ERROR_COPY, code) ? OAUTH_ERROR_COPY[code] : null;
  if (!entry) return { kind: "other", message: "That sign-in didn't complete. Try again or use email." };
  return { kind: entry.kind, message: entry.message(p) };
}
