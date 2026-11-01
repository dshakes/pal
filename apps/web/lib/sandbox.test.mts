import { test } from "node:test";
import assert from "node:assert/strict";
import { autoSuspends, fmtBytes, logRetryDelay, shouldRetryLogs, formatLogFrame, isDir, joinPath, lifecycleMessage, parentPath, pushLog, runtimeFailure, validateForkCount, vmActions, vmTone } from "./sandbox.ts";

test("vmActions follow the lifecycle", () => {
  assert.deepEqual(vmActions("running"), { pause: true, resume: false, fork: true, terminate: true });
  assert.deepEqual(vmActions("paused"), { pause: false, resume: true, fork: true, terminate: true });
  assert.deepEqual(vmActions("draining"), { pause: false, resume: false, fork: false, terminate: true });
  assert.deepEqual(vmActions("terminated"), { pause: false, resume: false, fork: false, terminate: false });
  assert.deepEqual(vmActions("failed"), { pause: false, resume: false, fork: false, terminate: false });
});

test("vmTone", () => {
  assert.equal(vmTone("running"), "live");
  assert.equal(vmTone("paused"), "hold");
  assert.equal(vmTone("failed"), "bad");
  assert.equal(vmTone("whatever"), "neutral");
});

test("validateForkCount is whole numbers >= 1; the server owns the ceiling", () => {
  assert.equal(validateForkCount("1"), 1);
  assert.equal(validateForkCount("100"), 100);
  assert.equal(validateForkCount("500"), 500); // PAL_MAX_FORK_COUNT may be raised server-side
  for (const bad of ["0", "1.5", "", " ", "abc", "-1"]) assert.equal(validateForkCount(bad), null, bad);
});

test("log reconnect backs off to a cap and gives up on 4xx", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(logRetryDelay), [3000, 6000, 12000, 24000, 48000, 60000, 60000]);
  assert.equal(shouldRetryLogs(new Error("API 404: not found")), false);
  assert.equal(shouldRetryLogs(new Error("API 403: forbidden")), false);
  assert.equal(shouldRetryLogs(new Error("API 502: bad gateway")), true);
  assert.equal(shouldRetryLogs(new TypeError("network error")), true);
});

test("autoSuspends reads idleTimeoutSecs in either casing", () => {
  assert.equal(autoSuspends({ idleTimeoutSecs: 60 }), true);
  assert.equal(autoSuspends({ idle_timeout_secs: 5 }), true);
  assert.equal(autoSuspends({ idleTimeoutSecs: 0 }), false);
  assert.equal(autoSuspends(null), false);
  assert.equal(autoSuspends({}), false);
});

test("runtimeFailure / lifecycleMessage read the server's {error, reason}", () => {
  const e = new Error('API 409: {"error":"conflict","reason":"vm is draining"}');
  assert.deepEqual(runtimeFailure(e), { status: 409, message: "conflict: vm is draining" });
  assert.match(lifecycleMessage("Pause", e), /current state.*vm is draining/);
  assert.match(lifecycleMessage("Fork", new Error('API 402: {"error":"quota exceeded","reason":"max vms"}')), /runtime quota.*max vms/);
  assert.match(lifecycleMessage("Resume", new Error('API 403: {"error":"forbidden"}')), /owner or admin/);
  assert.match(lifecycleMessage("Resume", new Error("API 502: not json")), /Resume failed: not json/);
  assert.deepEqual(runtimeFailure(new Error("network down")), { status: 0, message: "network down" });
});

test("log helpers cap and format", () => {
  let l: string[] = [];
  for (let i = 0; i < 7; i++) l = pushLog(l, String(i), 5);
  assert.deepEqual(l, ["2", "3", "4", "5", "6"]);
  assert.equal(formatLogFrame('{"stream":"stderr","text":"boom","at":"2026-01-01T10:11:12Z"}'), "[10:11:12] [stderr] boom");
  assert.equal(formatLogFrame("raw line"), "raw line");
});

test("file paths stay inside the workspace", () => {
  assert.equal(joinPath(".", "a"), "a");
  assert.equal(joinPath("src/", "a.ts"), "src/a.ts");
  assert.equal(parentPath("."), null);
  assert.equal(parentPath("src"), ".");
  assert.equal(parentPath("src/lib"), "src");
  assert.equal(isDir({ name: "x", type: "dir" }), true);
  assert.equal(isDir({ name: "x", type: "symlink" }), false);
  assert.equal(fmtBytes(undefined), "—");
  assert.equal(fmtBytes(2048), "2.0 KiB");
});
