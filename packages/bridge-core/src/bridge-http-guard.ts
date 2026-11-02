// HTTP hardening shared by both bridges (GA PR-1). The bridges bind to loopback
// but, with no token configured, any local web page could drive them via DNS
// rebinding. Two independent defences:
//   1. Host allowlist  — only loopback hosts (+ PAL_BRIDGE_ALLOWED_HOSTS) are served.
//   2. Token fail-closed — an unset token REFUSES (403) every /session route
//      unless the dev-only PAL_BRIDGE_ALLOW_NO_TOKEN=1 escape hatch is set
//      (ignored when PAL_ENV is prod/production/staging).

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/** Hostname part of a Host header (port stripped, IPv6 brackets handled), lowercased. */
export function hostnameOf(hostHeader: string | undefined): string {
  const h = (hostHeader ?? "").trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : "";
  }
  const i = h.lastIndexOf(":");
  return i > -1 && h.indexOf(":") === i ? h.slice(0, i) : h;
}

export function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => hostnameOf(s)).filter(Boolean);
}

export function isAllowedHost(hostHeader: string | undefined, extra: readonly string[] = []): boolean {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  return LOOPBACK.has(name) || extra.includes(name);
}

export function isProdLikeEnv(env: Record<string, string | undefined>): boolean {
  return ["prod", "production", "staging"].includes((env.PAL_ENV ?? "").trim().toLowerCase());
}

export type TokenPolicy =
  | { action: "enforce" }
  | { action: "open-dev"; warning: string }
  | { action: "refuse"; message: string };

/** What /session routes must do given the configured token and env. */
export function tokenPolicy(token: string, tokenEnvName: string, env: Record<string, string | undefined>): TokenPolicy {
  if (token) return { action: "enforce" };
  const hatch = (env.PAL_BRIDGE_ALLOW_NO_TOKEN ?? "").trim() === "1";
  if (hatch && !isProdLikeEnv(env)) {
    return { action: "open-dev", warning: `${tokenEnvName} is unset and PAL_BRIDGE_ALLOW_NO_TOKEN=1: /session routes are OPEN (dev only)` };
  }
  return {
    action: "refuse",
    message: `${tokenEnvName} is not set: refusing /session routes (set ${tokenEnvName}${hatch ? "; PAL_BRIDGE_ALLOW_NO_TOKEN is ignored in prod/staging" : ", or PAL_BRIDGE_ALLOW_NO_TOKEN=1 for local dev only"})`,
  };
}

/**
 * Auth headers for a call TO the peer bridge. Each bridge validates its OWN token
 * (WhatsApp: PAL_BRIDGE_TOKEN, iMessage: PAL_IMESSAGE_BRIDGE_TOKEN), so a caller must
 * send the token of the bridge it is dialling, never its own.
 */
export function peerAuthHeaders(
  peer: "whatsapp" | "imessage",
  extra: Record<string, string> = {},
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const tok = peer === "whatsapp" ? env.PAL_BRIDGE_TOKEN : env.PAL_IMESSAGE_BRIDGE_TOKEN;
  return tok ? { ...extra, Authorization: `Bearer ${tok}` } : { ...extra };
}
