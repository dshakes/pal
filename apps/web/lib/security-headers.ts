// Dashboard security headers (S-3). The CSP carries a per-request nonce, so it
// is set by middleware.ts; app/layout.tsx stamps the same nonce on its two
// inline scripts and Next applies it to its own bootstrap scripts.
//
// script-src is 'nonce-…' + 'strict-dynamic': only scripts the server emitted
// (and what they load) run; injected markup cannot execute script. No
// 'unsafe-eval' outside `next dev` (React's dev overlay needs it). The JS
// snippet runner uses public/code-runner-worker.js, which carries its own,
// stricter CSP (next.config.ts), so the page never needs 'unsafe-eval'.
// The browser only talks to this origin (the /api/pal proxy), hence
// connect-src 'self'.

const TURNSTILE = "https://challenges.cloudflare.com";

/** Exact ws origins of the local bridges (the dashboard's WebSocket connects to them directly
 *  with a single-use ticket). Never a wildcard: only the configured bridge URLs + loopback defaults. */
export function bridgeWsOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const urls = [
    env.NEXT_PUBLIC_PAL_BRIDGE_URL || "http://localhost:3100",
    env.NEXT_PUBLIC_PAL_IMESSAGE_BRIDGE_URL || "http://localhost:3200",
    "http://127.0.0.1:3100",
    "http://127.0.0.1:3200",
  ];
  const out = new Set<string>();
  for (const u of urls) {
    try {
      const o = new URL(u);
      if (o.protocol === "http:" || o.protocol === "https:") out.add(`${o.protocol === "https:" ? "wss:" : "ws:"}//${o.host}`);
    } catch { /* ignore malformed */ }
  }
  return [...out];
}

export function buildCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${TURNSTILE}${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${bridgeWsOrigins().join(" ")}${dev ? " ws: wss:" : ""}`,
    "worker-src 'self'",
    `frame-src ${TURNSTILE}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Static headers on every dashboard response (next.config.ts). */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

/** The snippet runner's worker: it may evaluate code and nothing else — no
 *  network, no imports — so LLM-written JS cannot call the API as the user. */
export const CODE_RUNNER_WORKER_CSP = "default-src 'none'; script-src 'unsafe-eval'";
