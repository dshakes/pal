// Minimal SSE frame parser + the run-event mapping. Pure; unit-tested.
//
// Why not EventSource: the control-plane names every frame after its journal
// kind (`event: step_started`), and EventSource.onmessage only receives
// unnamed frames — so the dashboard never saw a single run event. Parsing the
// stream ourselves accepts every kind, and lets the browser send the bearer
// token as a header instead of a ?token= URL parameter.
import type { StreamEvent } from "./types";

export interface SSEFrame {
  event: string;
  data: string;
}

/** Split buffered text into complete frames; returns the unparsed remainder. */
export function parseSSE(buffer: string): { frames: SSEFrame[]; rest: string } {
  const frames: SSEFrame[] = [];
  // SSE allows CRLF, LF or a bare CR as the line ending. A trailing lone CR may
  // be the first half of a CRLF split across chunks, so it stays in `rest`.
  const held = buffer.endsWith("\r") ? "\r" : "";
  const text = (held ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n");
  const blocks = text.split("\n\n");
  const rest = (blocks.pop() ?? "") + held;
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue; // comment / heartbeat
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) frames.push({ event, data: data.join("\n") });
  }
  return { frames, rest };
}

/** A journal row as the server sends it → the dashboard's StreamEvent. */
export function toStreamEvent(runId: string, frame: SSEFrame): StreamEvent | null {
  try {
    const o = JSON.parse(frame.data) as Record<string, unknown>;
    if (typeof o.seq !== "number") return null;
    return {
      runId,
      seq: o.seq,
      stepId: typeof o.stepId === "string" && o.stepId ? o.stepId : undefined,
      kind: (typeof o.kind === "string" ? o.kind : frame.event) as StreamEvent["kind"],
      ts: new Date(typeof o.createdAt === "string" ? o.createdAt : typeof o.ts === "string" ? o.ts : Date.now()),
      data: (o.payload ?? o.data ?? {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

// ── The live run stream ─────────────────────────────────────────────────────

/** connecting → live → (reconnecting → live)* → ended | disconnected. */
export type StreamState = "connecting" | "live" | "reconnecting" | "ended" | "disconnected";

export interface RunStreamOptions {
  runId: string;
  url: string;
  headers?: Record<string, string>;
  onEvent: (e: StreamEvent) => void;
  onState: (s: StreamState) => void;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** 401/403/404 will not change on retry; 5xx, 429 and network errors might. */
export function isTerminalStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

/**
 * Reads a run's SSE stream until the server closes it (run terminal → "ended"),
 * the server refuses for good, or retries run out ("disconnected"). The server
 * replays the whole journal on every connection, so events are deduped by seq;
 * a connection that delivered new events earns a fresh retry budget.
 * Returns close().
 */
export function openRunStream(o: RunStreamOptions): () => void {
  const ctrl = new AbortController();
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = o.maxRetries ?? 5;
  let lastSeq = -1;
  const setState = (s: StreamState) => { if (!ctrl.signal.aborted) o.onState(s); };

  const run = async () => {
    let attempt = 0;
    setState("connecting");
    while (!ctrl.signal.aborted) {
      const seqAtStart = lastSeq;
      try {
        const res = await doFetch(o.url, {
          headers: { Accept: "text/event-stream", ...o.headers },
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (isTerminalStatus(res.status)) return setState("disconnected");
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        setState("live");
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return setState("ended"); // the server closes when the run is terminal
          const { frames, rest } = parseSSE(buf + dec.decode(value, { stream: true }));
          buf = rest;
          for (const f of frames) {
            const e = toStreamEvent(o.runId, f);
            if (e && e.seq > lastSeq) { lastSeq = e.seq; o.onEvent(e); }
          }
        }
      } catch {
        if (ctrl.signal.aborted) return;
      }
      attempt = lastSeq > seqAtStart ? 1 : attempt + 1;
      if (attempt > maxRetries) return setState("disconnected");
      setState("reconnecting");
      await sleep(1000 * 2 ** (attempt - 1));
    }
  };
  void run();
  return () => ctrl.abort();
}
