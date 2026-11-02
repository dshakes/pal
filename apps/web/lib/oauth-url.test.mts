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

// The login page itself is a React client component the node runner cannot
// render, so pin its wiring by source: it navigates with THIS builder, and no
// OAuth start URL is built from the api client (whose browser base is /api/pal).
test("the login page's OAuth start uses the API-host builder, never /api/pal", async () => {
  const { readFileSync } = await import("node:fs");
  const login = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  const apiSrc = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(login, /import \{ oauthStartUrl \} from "@\/lib\/oauth-url";/);
  assert.match(login, /window\.location\.href = oauthStartUrl\(/);
  assert.doesNotMatch(login, /api\.oauthStart/);
  assert.doesNotMatch(apiSrc, /\/auth\/oauth\/\$\{/);
  // And what that builder yields in a browser on the dashboard host:
  (globalThis as Record<string, unknown>).window = { __NEXT_PUBLIC_API_URL: "https://api.acme.example", location: { hostname: "dash.acme.example", origin: "https://dash.acme.example" } };
  try {
    const u = new URL(oauthStartUrl("google"));
    assert.equal(u.origin, "https://api.acme.example");
    assert.ok(!u.pathname.startsWith("/api/pal"));
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});
