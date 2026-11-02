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

export function buildCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${TURNSTILE}${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
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
