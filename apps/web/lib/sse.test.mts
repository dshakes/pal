import test from "node:test";
import assert from "node:assert/strict";
import { acceptEvent, mergeEvent, openRunStream, parseSSE, toStreamEvent } from "./sse.ts";

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

test("parseSSE: bare CR line endings, and a CR split across chunks", () => {
  const r = parseSSE('event: step_started\rdata: {"seq":1}\r\rdata: {"seq":2}\r');
  assert.deepEqual(r.frames, [{ event: "step_started", data: '{"seq":1}' }]);
  // The trailing CR may be half of a CRLF; it must not end the frame yet.
  const next = parseSSE(r.rest + "\n\n");
  assert.deepEqual(next.frames, [{ event: "message", data: '{"seq":2}' }]);
});

// ── openRunStream: retry policy + state ───────────────────────────────────────

const frame = (seq: number) => `event: step_started\ndata: {"seq":${seq},"kind":"step_started"}\n\n`;

/** fetch stub that answers each call from a script: a status or an SSE body. */
function scripted(steps: Array<number | string>) {
  const calls: number[] = [];
  const f = (async () => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push(calls.length);
    return typeof step === "number" ? new Response("nope", { status: step }) : new Response(step, { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function collect(steps: Array<number | string>, maxRetries = 5) {
  const { f, calls } = scripted(steps);
  const states: string[] = [];
  const seqs: number[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  openRunStream({
    runId: "r1",
    url: "http://x/v1/runs/r1/events",
    onEvent: (e) => seqs.push(e.seq),
    onState: (s) => { states.push(s); if (s === "ended" || s === "disconnected") resolveDone(); },
    maxRetries,
    fetchImpl: f,
    sleep: async () => {},
  });
  return done.then(() => ({ states, seqs, calls: calls.length }));
}

test("openRunStream: 503 and 429 back off and retry; replayed events dedupe by seq", async () => {
  const r = await collect([503, 429, frame(0) + frame(1)]);
  assert.equal(r.calls, 3);
  assert.deepEqual(r.seqs, [0, 1]);
  assert.deepEqual(r.states, ["connecting", "reconnecting", "reconnecting", "live", "ended"]);
});

test("openRunStream: 401/403/404 are terminal — one request, then disconnected", async () => {
  for (const status of [401, 403, 404]) {
    const r = await collect([status]);
    assert.equal(r.calls, 1, `status ${status}`);
    assert.deepEqual(r.states, ["connecting", "disconnected"]);
  }
});

test("openRunStream: retries run out → disconnected", async () => {
  const r = await collect([502], 2);
  assert.equal(r.calls, 3); // first try + 2 retries
  assert.deepEqual(r.states, ["connecting", "reconnecting", "reconnecting", "disconnected"]);
});

test("openRunStream: close() stops it without further state changes", async () => {
  const { f } = scripted([503]);
  const states: string[] = [];
  const close = openRunStream({
    runId: "r1", url: "http://x", onEvent: () => {}, onState: (s) => states.push(s),
    fetchImpl: f, sleep: () => new Promise((r) => setTimeout(r, 5)),
  });
  close();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(states, ["connecting"]);
});

// ── Journal identity: an approval's step_waiting is rewritten in place ────────

const ev = (seq: number, kind: string) => ({ runId: "r1", seq, kind, ts: new Date(0), data: {} }) as unknown as Parameters<typeof acceptEvent>[1];

test("acceptEvent: a seen seq is a duplicate unless it replaces a step_waiting marker", () => {
  const seen = new Map<number, string>();
  assert.equal(acceptEvent(seen, ev(7, "step_waiting")), true);
  assert.equal(acceptEvent(seen, ev(7, "step_waiting")), false);
  assert.equal(acceptEvent(seen, ev(7, "step_completed")), true);
  assert.equal(acceptEvent(seen, ev(7, "step_completed")), false);
  assert.equal(acceptEvent(seen, ev(6, "step_started")), true);
  assert.equal(acceptEvent(seen, ev(6, "step_completed")), false); // only step_waiting is ever rewritten
});

test("mergeEvent: replaces by seq, keeps seq order", () => {
  let list = [ev(6, "step_started"), ev(7, "step_waiting")];
  list = mergeEvent(list, ev(7, "step_completed"));
  assert.deepEqual(list.map((e) => `${e.seq}:${e.kind}`), ["6:step_started", "7:step_completed"]);
  list = mergeEvent(list, ev(8, "end"));
  list = mergeEvent(list, ev(5, "step_completed"));
  assert.deepEqual(list.map((e) => e.seq), [5, 6, 7, 8]);
});

test("openRunStream: after a mid-run drop, a replay that rewrote step_waiting delivers the new row", async () => {
  const waiting = 'data: {"seq":7,"kind":"step_waiting","stepId":"review"}\n\n';
  const completed = 'data: {"seq":7,"kind":"step_completed","stepId":"review"}\n\n';
  // First connection: two frames, then the connection breaks mid-run.
  let sent = false;
  const broken = () => new Response(new ReadableStream({
    pull(c) {
      if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(frame(6) + waiting)); }
      else c.error(new Error("socket hang up"));
    },
  }), { status: 200 });
  let n = 0;
  const kinds: string[] = [];
  await new Promise<void>((resolve) => {
    openRunStream({
      runId: "r1", url: "http://x", maxRetries: 3, sleep: async () => {},
      fetchImpl: (async () => (++n === 1 ? broken() : new Response(frame(6) + completed + frame(8), { status: 200 }))) as unknown as typeof fetch,
      onEvent: (e) => kinds.push(`${e.seq}:${e.kind}`),
      onState: (s) => { if (s === "ended" || s === "disconnected") resolve(); },
    });
  });
  assert.deepEqual(kinds, ["6:step_started", "7:step_waiting", "7:step_completed", "8:step_started"]);
});
