import test from "node:test";
import assert from "node:assert/strict";
import { shouldShowProviderBanner } from "./model-banner.ts";

const base = { kiosk: false, loading: false, loaded: true, isConfigured: false };

test("banner shows only when the API confirmed no provider", () => {
  assert.equal(shouldShowProviderBanner(base), true);
});
test("failed/unauthenticated fetch (not loaded) never claims keys are missing", () => {
  assert.equal(shouldShowProviderBanner({ ...base, loaded: false }), false);
});
test("hidden while loading, when configured, and in kiosk", () => {
  assert.equal(shouldShowProviderBanner({ ...base, loading: true }), false);
  assert.equal(shouldShowProviderBanner({ ...base, isConfigured: true }), false);
  assert.equal(shouldShowProviderBanner({ ...base, kiosk: true }), false);
});
