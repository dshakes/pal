import test from "node:test";
import assert from "node:assert/strict";
import { parseSSE, toStreamEvent } from "./sse.ts";

test("sse: named frames, heartbeats and partial chunks", () => {
  const a = parseSSE('event: step_started\ndata: {"seq":1}\n\n: heartbeat\n\nevent: step_comp');
  assert.deepEqual(a.frames, [{ event: "step_started", data: '{"seq":1}' }]);
  assert.equal(a.rest, "event: step_comp");
  const b = parseSSE(a.rest + 'leted\ndata: {"seq":2}\n\n');
  assert.deepEqual(b.frames, [{ event: "step_completed", data: '{"seq":2}' }]);
  assert.equal(b.rest, "");
});

test("sse: CRLF and multi-line data join", () => {
  const { frames } = parseSSE("data: a\r\ndata: b\r\n\r\n");
  assert.deepEqual(frames, [{ event: "message", data: "a\nb" }]);
});

test("sse: journal row maps to StreamEvent (createdAt→ts, payload→data)", () => {
  const e = toStreamEvent("r1", { event: "step_completed", data: '{"seq":3,"kind":"step_completed","stepId":"draft","payload":{"tokens_in":5},"createdAt":"2026-10-31T17:31:36Z"}' });
  assert.equal(e?.seq, 3);
  assert.equal(e?.stepId, "draft");
  assert.equal(e?.kind, "step_completed");
  assert.equal(e?.ts.toISOString(), "2026-10-31T17:31:36.000Z");
  assert.deepEqual(e?.data, { tokens_in: 5 });
  assert.equal(toStreamEvent("r1", { event: "x", data: "not json" }), null);
  assert.equal(toStreamEvent("r1", { event: "x", data: '{"kind":"log"}' }), null);
});
