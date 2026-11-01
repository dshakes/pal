import test from "node:test";
import assert from "node:assert/strict";
import { ISOLATION_LEVELS, settingsPatch } from "./agent-settings.ts";

// Server's allowed set (rest.go validManifestIsolation), minus the empty string.
const SERVER_ALLOWED = ["shared", "microvm"];

test("isolation options are exactly what the server accepts", () => {
  assert.deepEqual(ISOLATION_LEVELS.map((l) => l.value), SERVER_ALLOWED);
});

test("settingsPatch: payload isolation is always in the server's allowed set", () => {
  for (const legacy of ["trusted", "standard", "untrusted", ""]) {
    assert.equal(settingsPatch({}, { model: "", isolation: legacy }).manifest, undefined);
  }
  for (const v of SERVER_ALLOWED) {
    assert.deepEqual(settingsPatch({}, { model: "", isolation: v }).manifest, { isolation: v });
  }
});

test("settingsPatch: model sent only when changed", () => {
  assert.deepEqual(settingsPatch({ model: "fast" }, { model: "fast", isolation: "" }), {});
  assert.deepEqual(settingsPatch({ model: "fast" }, { model: "balanced", isolation: "" }), { model: "balanced" });
  assert.deepEqual(settingsPatch({}, { model: "", isolation: "" }), {});
});
