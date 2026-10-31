import test from "node:test";
import assert from "node:assert/strict";
import { can, toRole } from "./rbac.ts";

test("rbac: viewer is read-only, unknown roles fall to viewer", () => {
  for (const cap of ["agents:write", "runs:execute", "runtime:admin", "settings:write", "owner"] as const) {
    assert.equal(can("viewer", cap), false, cap);
    assert.equal(can(undefined, cap), false, cap);
    assert.equal(can("superuser", cap), false, cap);
  }
  assert.equal(toRole("OWNER"), "viewer");
});

test("rbac: member builds and runs, cannot administer", () => {
  assert.equal(can("member", "agents:write"), true);
  assert.equal(can("member", "runs:execute"), true);
  assert.equal(can("member", "runtime:admin"), false);
  assert.equal(can("member", "settings:write"), false);
});

test("rbac: only owner holds owner-level actions", () => {
  assert.equal(can("owner", "owner"), true);
  assert.equal(can("admin", "owner"), false);
  assert.equal(can("admin", "settings:write"), true);
  assert.equal(can("kiosk", "runtime:admin"), false);
});
