import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG, LIFECYCLE, resolveTab } from "./lifecycle.ts";

test("lifecycle: the rail is the documented order", () => {
  assert.deepEqual(LIFECYCLE.map((t) => t.key), ["design", "test", "evals", "gate", "promote", "observe", "debug"]);
  assert.deepEqual(CONFIG.map((t) => t.key), ["schedule", "security", "settings"]);
});

test("lifecycle: ?tab= resolves current, legacy and unknown values", () => {
  assert.equal(resolveTab("promote"), "promote");
  assert.equal(resolveTab("security"), "security");
  assert.equal(resolveTab("build"), "design");
  assert.equal(resolveTab("chat"), "test");
  assert.equal(resolveTab("runs"), "observe");
  assert.equal(resolveTab("nope"), "design");
  assert.equal(resolveTab(null), "design");
});
