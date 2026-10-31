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
  const text = buffer.replace(/\r\n/g, "\n");
  const blocks = text.split("\n\n");
  const rest = blocks.pop() ?? "";
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
