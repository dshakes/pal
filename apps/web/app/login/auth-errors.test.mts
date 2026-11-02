import test from "node:test";
import assert from "node:assert/strict";
import { describeAuthError, oauthErrorMessage, safeNextPath } from "./auth-errors.ts";

test("status-specific copy", () => {
  assert.equal(describeAuthError(new Error('API 429: {"error":"too many login attempts"}'), "signin").kind, "rate_limited");
  const inv = describeAuthError(new Error('API 401: {"error":"invalid credentials"}'), "signin");
  assert.equal(inv.kind, "invalid");
  assert.match(inv.message, /incorrect/i);
  assert.equal(describeAuthError(new Error('API 403: {"code":"email_unverified"}'), "signin").kind, "unverified");
  assert.equal(describeAuthError(new TypeError("Failed to fetch"), "signin").kind, "unreachable");
  const un = describeAuthError(new TypeError("Failed to fetch"), "signin", "http://localhost:8080");
  assert.match(un.message, /http:\/\/localhost:8080/);
  assert.match(un.message, /CORS/);
  assert.equal(describeAuthError(new Error("API 500: oops"), "signin").kind, "server");
});

test("sign-up surfaces the server's reason", () => {
  const v = describeAuthError(new Error('API 403: {"error":"sign-up is invite-only"}'), "signup");
  assert.equal(v.kind, "closed");
  assert.equal(v.message, "Sign-up is invite-only");
  assert.equal(describeAuthError(new Error('API 400: {"error":"password too short"}'), "signup").message, "Password too short");
});

test("safeNextPath blocks open redirects and loops", () => {
  assert.equal(safeNextPath("/agents/x?y=1"), "/agents/x?y=1");
  assert.equal(safeNextPath("https://evil.example"), "/");
  assert.equal(safeNextPath("//evil.example"), "/");
  assert.equal(safeNextPath("/\\evil.example"), "/");
  assert.equal(safeNextPath("/login?next=/x"), "/");
  assert.equal(safeNextPath(null), "/");
});

test("oauthErrorMessage: known codes map to copy, raw query text never rendered", () => {
  assert.equal(oauthErrorMessage(null, null), null);
  const u = oauthErrorMessage("email_unverified", "github")!;
  assert.equal(u.kind, "unverified");
  assert.match(u.message, /GitHub email address isn't verified/);
  assert.match(oauthErrorMessage("link_refused", "google")!.message, /Sign in with your password/);
  assert.equal(oauthErrorMessage("signup_closed", null)!.kind, "closed");
  assert.match(oauthErrorMessage("state_invalid", "google")!.message, /wasn't started in this browser/);
  // Unknown provider is not echoed; unknown code / free text gets the generic line.
  assert.match(oauthErrorMessage("oauth_denied", "<img src=x>")!.message, /with your provider was cancelled/);
  const evil = "Your account is locked, call +1-555-0100";
  const g = oauthErrorMessage(evil, "google")!;
  assert.ok(!g.message.includes("555"));
  assert.equal(g.message, "That sign-in didn't complete. Try again or use email.");
  assert.equal(oauthErrorMessage("__proto__", null)!.message, "That sign-in didn't complete. Try again or use email.");
  assert.equal(oauthErrorMessage("toString", null)!.message, "That sign-in didn't complete. Try again or use email.");
});
