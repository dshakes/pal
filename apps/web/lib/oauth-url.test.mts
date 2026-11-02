import test from "node:test";
import assert from "node:assert/strict";
import { oauthStartUrl } from "./oauth-url.ts";

test("OAuth start is a navigation to the API host, never the /api/pal proxy", () => {
  const u = new URL(oauthStartUrl("google", undefined, "https://api.acme.example/"));
  assert.equal(u.origin, "https://api.acme.example");
  assert.equal(u.pathname, "/auth/oauth/google/start");
  assert.equal(u.searchParams.get("redirect"), "1");
  assert.ok(!u.pathname.startsWith("/api/pal"));
});

test("invite code is carried; provider is path-encoded", () => {
  const u = new URL(oauthStartUrl("git hub", "abc.123", "http://localhost:8080"));
  assert.equal(u.pathname, "/auth/oauth/git%20hub/start");
  assert.equal(u.searchParams.get("invite"), "abc.123");
});

test("default base comes from the injected public API URL", () => {
  (globalThis as Record<string, unknown>).window = { __NEXT_PUBLIC_API_URL: "https://api.injected.example", location: { hostname: "dash.example", origin: "https://dash.example" } };
  try {
    assert.equal(new URL(oauthStartUrl("github")).origin, "https://api.injected.example");
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});

// api.ts pulls in `@/` aliases the node test runner cannot resolve, so pin the
// wiring by source: the login page navigates via api.oauthStartUrl, and that
// must delegate to the API-host builder above, never build from this.baseUrl
// (= /api/pal in the browser).
test("the login page's OAuth navigation goes through the API-host builder", async () => {
  const { readFileSync } = await import("node:fs");
  const apiSrc = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  const login = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  assert.match(apiSrc, /oauthStartUrl\(provider: string, invite\?: string\): string \{\s*return oauthStartUrl\(provider, invite\);/);
  assert.doesNotMatch(apiSrc, /\$\{this\.baseUrl\}\/auth\/oauth\//);
  assert.match(login, /window\.location\.href = api\.oauthStartUrl\(/);
});
