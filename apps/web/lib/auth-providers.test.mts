import test from "node:test";
import assert from "node:assert/strict";
import { visibleOAuthProviders } from "./auth-providers.ts";

test("only enabled, known providers show; unknown/off/absent do not", () => {
  assert.deepEqual(visibleOAuthProviders({ google: true, github: false, gitlab: true }), ["google"]);
  assert.deepEqual(visibleOAuthProviders(null), []);
  assert.deepEqual(visibleOAuthProviders(undefined), []);
});

test("sso is a slot: absent today, shown the moment the server reports it", () => {
  assert.deepEqual(visibleOAuthProviders({ google: true, github: true }), ["github", "google"]);
  assert.deepEqual(visibleOAuthProviders({ google: true, sso: true }), ["google", "sso"]);
  assert.deepEqual(visibleOAuthProviders({ sso: false }), []);
});
