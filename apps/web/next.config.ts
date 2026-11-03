import type { NextConfig } from "next";
import { CODE_RUNNER_WORKER_CSP, STATIC_SECURITY_HEADERS } from "./lib/security-headers";

// Pin the trace root to this app. Without it, Next infers the root from the
// highest lockfile it finds, and a stray ~/package-lock.json on the host moved the
// standalone server to .next/standalone/<path>/server.js. The launchd wrapper and
// the Docker image both start .next/standalone/server.js, so the dashboard
// built cleanly and then crash-looped.

const nextConfig: NextConfig = {
  // Next 16 blocks dev resources (/_next/*) for hosts other than localhost; the e2e and
  // local tooling load the dashboard from 127.0.0.1. Dev-server only, no effect on `next start`.
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  outputFileTracingRoot: __dirname,
  // S-3: static security headers everywhere; the nonce'd CSP is per request
  // (proxy.ts). The snippet-runner worker gets its own no-network CSP.
  async headers() {
    return [
      { source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] },
      { source: "/code-runner-worker.js", headers: [{ key: "Content-Security-Policy", value: CODE_RUNNER_WORKER_CSP }] },
    ];
  },
};

export default nextConfig;
