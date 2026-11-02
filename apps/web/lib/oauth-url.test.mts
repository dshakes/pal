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
