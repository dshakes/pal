// Pure helpers for the Runs page (URL contract + session sizes); unit-tested.
import type { Run, RunStatus } from "./types";

export type RunStatusFilter = RunStatus | "all";
const STATUSES: RunStatusFilter[] = ["all", "queued", "running", "paused", "succeeded", "failed", "cancelled"];

export interface RunFilterState {
  status: RunStatusFilter;
  agent: string;
  session: string;
  q: string;
}

/** Read filters from ?status=&agent=&session=&q=; unknown status → all. */
export function runFilterFromQuery(p: { get(k: string): string | null }): RunFilterState {
  const s = p.get("status") ?? "all";
  return {
    status: (STATUSES as string[]).includes(s) ? (s as RunStatusFilter) : "all",
    agent: p.get("agent") ?? "",
    session: p.get("session") ?? "",
    q: p.get("q") ?? "",
  };
}

/** How many runs each session holds (only sessions with an id). */
export function sessionSizes(runs: Run[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of runs) if (r.sessionId) m.set(r.sessionId, (m.get(r.sessionId) ?? 0) + 1);
  return m;
}

/**
 * What the run-detail page shows. Once a run has loaded it stays on screen:
 * background polls refetch it every few seconds, and a failed or in-flight
 * poll must not swap it for a skeleton or "not found".
 */
export type RunPageView = "skeleton" | "not-found" | "load-failed" | "run";

export function runPageView(s: { hasRun: boolean; loading: boolean; error: Error | null }): RunPageView {
  if (s.hasRun) return "run";
  if (s.loading) return "skeleton";
  return s.error && !/\b404\b/.test(s.error.message) ? "load-failed" : "not-found";
}
