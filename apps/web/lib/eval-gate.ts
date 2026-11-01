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

export function gateVerdict(runs: EvalRun[], baseline: EvalBaseline | null): GateVerdict {
  const latest = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!latest) return { state: "none", title: "No eval results", detail: "Nothing has scored this agent yet, so there is no quality signal to gate on." };
  const on = latest.agentVersion ? `version ${latest.agentVersion}` : "the working copy";
  const base = baseline && baseline.evalRunId !== latest.id ? ` Baseline: ${pct(baseline.score)}.` : "";
  if (latest.regressed || (baseline && baseline.evalRunId !== latest.id && latest.score < baseline.score)) {
    return { state: "regressed", run: latest, title: "Evals regressed", detail: `Latest run scored ${pct(latest.score)} on ${on}, below the pinned baseline.${base} CI fails this change with 422.` };
  }
  if (!latest.passed) return { state: "fail", run: latest, title: "Evals failing", detail: `Latest run scored ${pct(latest.score)} on ${on} (${latest.casesPassed}/${latest.casesTotal} cases).${base}` };
  return {
    state: "pass",
    run: latest,
    title: "Evals passing",
    detail: `Latest run scored ${pct(latest.score)} on ${on}.${base || (baseline ? " This run is the baseline." : " No baseline pinned yet — pin one so regressions are caught.")}`,
  };
}
