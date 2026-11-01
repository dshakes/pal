import test from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_NAV, isSettingsActive, settingsTabAllowed, visibleSettingsNav } from "./settings-nav.ts";

test("tab entries match ?tab=, default tab is general", () => {
  const general = SETTINGS_NAV.find((i) => i.label === "General")!;
  const keys = SETTINGS_NAV.find((i) => i.label === "API keys")!;
  assert.ok(isSettingsActive(general, "/settings", null));
  assert.ok(!isSettingsActive(keys, "/settings", null));
  assert.ok(isSettingsActive(keys, "/settings", "api-keys"));
});

test("sub-page entries match their own path only", () => {
  const devices = { href: "/settings/devices", label: "Devices", icon: "smartphone" as const };
  assert.ok(isSettingsActive(devices, "/settings/devices", null));
  assert.ok(!isSettingsActive(devices, "/settings", null));
  const general = SETTINGS_NAV[0];
  assert.ok(!isSettingsActive(general, "/settings/devices", null));
});

test("hrefs are unique", () => {
  assert.equal(new Set(SETTINGS_NAV.map((i) => i.href)).size, SETTINGS_NAV.length);
});

test("role-aware nav: members never see admin-only entries; owners/admins see all", () => {
  const labels = (r: string) => visibleSettingsNav(r).map((i) => i.label);
  for (const r of ["member", "viewer", "kiosk", "nonsense"]) {
    for (const hidden of ["API keys", "Audit log", "Single sign-on"]) assert.ok(!labels(r).includes(hidden), `${r} must not see ${hidden}`);
    assert.ok(labels(r).includes("Billing"), `${r} can read billing`);
  }
  for (const r of ["owner", "admin"]) assert.equal(labels(r).length, SETTINGS_NAV.length, r);
  assert.equal(settingsTabAllowed("member", "api-keys"), false);
  assert.equal(settingsTabAllowed("admin", "api-keys"), true);
  assert.equal(settingsTabAllowed("viewer", "billing"), true);
  assert.equal(settingsTabAllowed("viewer", "general"), true);
});
