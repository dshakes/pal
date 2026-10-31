// Pure helpers behind the Runtime Overview (no React, no fetch) — unit-tested
// in overview.test.mts. Every number comes from real runs; nothing is filled in.
import type { Run } from "./types";

const HOUR = 3_600_000;

export function ts(d: Date | string | undefined): number {
  if (!d) return NaN;
  return d instanceof Date ? d.getTime() : Date.parse(d);
}

export interface Bucket { ok: number; fail: number; other: number }

/** Split the last `spanMs` into `n` equal buckets, oldest first. */
export function bucketRuns(runs: Run[], now: number, n = 48, spanMs = 24 * HOUR): Bucket[] {
  const width = spanMs / n;
  const out = Array.from({ length: n }, () => ({ ok: 0, fail: 0, other: 0 }));
  for (const r of runs) {
    const age = now - ts(r.createdAt);
    if (!(age >= 0 && age < spanMs)) continue;
    const b = out[n - 1 - Math.floor(age / width)];
    if (r.status === "failed") b.fail += 1;
    else if (r.status === "succeeded") b.ok += 1;
    else b.other += 1;
  }
  return out;
}

export type Tone = "ok" | "bad" | "idle";

export interface Verdict { tone: Tone; text: string }

/**
 * One plain sentence that says whether the workspace is healthy right now —
 * the first thing the Overview shows. Deterministic; names the agents that
 * failed so the reader knows where to look.
 */
export function verdict(runs: Run[], now: number): Verdict {
  const day = runs.filter((r) => now - ts(r.createdAt) < 24 * HOUR);
  const live = runs.filter((r) => r.status === "running" || r.status === "queued").length;
  const liveNote = live ? ` ${live} running now.` : "";
  if (day.length === 0) return { tone: "idle", text: `No runs in the last 24 hours.${liveNote}` };
  const failed = day.filter((r) => r.status === "failed");
  if (failed.length === 0) {
    const n = day.length;
    return { tone: "ok", text: `${n === 1 ? "The only run" : `All ${n} runs`} in the last 24 hours succeeded.${liveNote}` };
  }
  const byAgent = new Map<string, number>();
  for (const r of failed) byAgent.set(r.agentName, (byAgent.get(r.agentName) ?? 0) + 1);
  const names = [...byAgent.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  const shown = names.slice(0, 2);
  const rest = names.length - shown.length;
  const where = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(" and ");
  return { tone: "bad", text: `${failed.length} of ${day.length} runs failed in the last 24 hours, on ${where}.${liveNote}` };
}
