// OAuth sign-in starts with a TOP-LEVEL NAVIGATION to the control plane's
// public host, never through the same-origin /api/pal proxy: the start
// response sets a browser-binding cookie on the API host and 302s to the
// provider, and the proxy (correctly) refuses document navigations and drops
// Set-Cookie. The base is the API's public URL (PAL_PUBLIC_API_URL, injected at
// request time; localhost:8080 in local dev), see lib/public-url.ts.
import { publicApiBase } from "./public-url.ts";

export function oauthStartUrl(provider: string, invite?: string, base: string = publicApiBase()): string {
  const q = new URLSearchParams({ redirect: "1" });
  if (invite) q.set("invite", invite);
  return `${base.replace(/\/+$/, "")}/auth/oauth/${encodeURIComponent(provider)}/start?${q.toString()}`;
}
