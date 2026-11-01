// The Gate tab's verdict from real eval data: the latest run, judged the way CI
// judges it (regressed vs the pinned baseline → fail, the 422), else by its own
// pass/fail. Pure; unit-tested.
import type { EvalBaseline, EvalRun } from "./api";

export interface GateVerdict {
  state: "pass" | "fail" | "regressed" | "none";
  title: string;
  detail: string;
  run?: EvalRun;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

// Server tolerance (eval_assert.go aggregateRegressed).
const TOL = 0.01;

/**
 * Aggregate-score regression, mirroring the server's 422 rule: no comparison
 * without a branch; otherwise score + 0.01 < baseline and |baseline - score| > 0.01.
 * The run list doesn't keep the server's call (a run whose /run answered 422
 * lists as regressed:false), so derive it: same branch as the baseline, run
 * after the pin, not the baseline itself. Per-case regressions (a baseline-
 * passing case now failing) also 422 server-side but need the case results,
 * so they only show in the run's result view, not here.
 */
export function isRegressed(run: EvalRun, baseline: EvalBaseline | null): boolean {
  if (run.regressed) return true;
  if (!run.branch) return false;
  if (!baseline || baseline.evalRunId === run.id) return false;
  if (run.branch !== baseline.branch) return false;
  if (baseline.setAt && Date.parse(run.createdAt) < Date.parse(baseline.setAt)) return false;
  return run.score + TOL < baseline.score && Math.abs(baseline.score - run.score) > TOL;
}

/** Newest run of each suite on `branch`. */
export function latestPerSuite(runs: EvalRun[], branch: string): EvalRun[] {
  const best = new Map<string, EvalRun>();
  for (const r of runs) {
    if (r.branch !== branch) continue;
    const cur = best.get(r.suiteId);
    if (!cur || Date.parse(r.createdAt) > Date.parse(cur.createdAt)) best.set(r.suiteId, r);
  }
  return [...best.values()];
}

const RANK = { regressed: 0, fail: 1, pass: 2 } as const;

/** Gate over the latest run of every suite on the branch; the worst one decides. */
export function gateVerdict(runs: EvalRun[], baseline: EvalBaseline | null, branch = "main"): GateVerdict {
  const latest = latestPerSuite(runs, branch);
  if (latest.length === 0) return { state: "none", title: "No eval results", detail: `Nothing has scored this agent on ${branch} yet, so there is no quality signal to gate on.` };
  const judged = latest.map((r) => ({ r, state: isRegressed(r, baseline) ? ("regressed" as const) : r.passed ? ("pass" as const) : ("fail" as const) }));
  judged.sort((a, b) => RANK[a.state] - RANK[b.state] || Date.parse(b.r.createdAt) - Date.parse(a.r.createdAt));
  const { r, state } = judged[0];
  const suites = latest.length > 1 ? ` (${judged.filter((j) => j.state === state).length} of ${latest.length} suites)` : "";
  const on = r.agentVersion ? `version ${r.agentVersion}` : "the working copy";
  const base = baseline && baseline.evalRunId !== r.id ? ` Baseline: ${pct(baseline.score)}.` : "";
  if (state === "regressed") return { state, run: r, title: "Evals regressed", detail: `Latest run scored ${pct(r.score)} on ${on}, below the pinned baseline${suites}.${base}` };
  if (state === "fail") return { state, run: r, title: "Evals failing", detail: `Latest run scored ${pct(r.score)} on ${on} (${r.casesPassed}/${r.casesTotal} cases)${suites}.${base}` };
  return {
    state,
    run: r,
    title: "Evals passing",
    detail: `Latest run scored ${pct(r.score)} on ${on}${suites}.${base || (baseline ? " This run is the baseline." : " No baseline pinned yet — pin one so regressions are caught.")}`,
  };
}
