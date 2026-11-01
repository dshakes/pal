"use client";
// Agent · Evals and Agent · Gate (v3). Real endpoints only:
//   suites ............ GET/POST /v1/eval-suites
//   generate .......... POST /v1/eval-suites/generate  (a draft; saved only on approve)
//   run ............... POST /v1/eval-suites/{id}/run   (hermetic, LLM judge; 422 = regressed)
//   baseline .......... GET/POST /v1/eval-baselines
//   analytics ......... GET /v1/eval-observability/{failures,trends}
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { AlertTriangle, CheckCircle2, CircleDashed, FlaskConical, Pin, Play, Sparkles, XCircle } from "lucide-react";
import {
  api,
  type EvalBaseline,
  type EvalFailures,
  type EvalRun,
  type EvalRunResult,
  type EvalSuite,
  type EvalTrends,
  type GeneratedEvalSuite,
} from "@/lib/api";
import { apiErrorText } from "@/lib/observability";
import { ts } from "@/lib/overview";
import { formatCost } from "@/lib/format";
import { gateVerdict, isRegressed } from "@/lib/eval-gate";
import { Button } from "@/components/button";
import { DataTable } from "@/components/data-table";
import { Modal } from "@/components/modal";
import { useCan } from "@/components/role-gate";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { RunResultView, ScoreTrend } from "../../eval-suites/eval-views";
import { Section } from "./lifecycle";

const BRANCH = "main";
const pct = (x: number) => `${Math.round(x * 100)}%`;

function useEvals(agentName: string) {
  const [suites, setSuites] = useState<EvalSuite[] | null>(null);
  const [runs, setRuns] = useState<EvalRun[] | null>(null);
  const [baseline, setBaseline] = useState<EvalBaseline | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const [s, r, b] = await Promise.all([
        api.listEvalSuites(agentName),
        api.listEvalRuns({ agentName }),
        api.getEvalBaseline(agentName, BRANCH),
      ]);
      setSuites(s);
      setRuns(r);
      setBaseline(b);
      setError(null);
    } catch (e) {
      setError(apiErrorText(e, "Couldn’t load evals"));
    }
  }, [agentName]);
  useEffect(() => { void reload(); }, [reload]);
  return { suites, runs, baseline, error, reload };
}

// ── Evals ─────────────────────────────────────────────────────────────────────

export function EvalsPanel({ agentName }: { agentName: string }) {
  const toast = useToast();
  const canWrite = useCan("agents:write");
  const canRun = useCan("runs:execute");
  const { suites, runs, baseline, error, reload } = useEvals(agentName);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{ suite: string; run: EvalRunResult } | null>(null);
  const [genOpen, setGenOpen] = useState(false);

  const latestBySuite = useMemo(() => {
    const m = new Map<string, EvalRun>();
    for (const r of runs ?? []) {
      const cur = m.get(r.suiteId);
      if (!cur || ts(r.createdAt) > ts(cur.createdAt)) m.set(r.suiteId, r);
    }
    return m;
  }, [runs]);

  const run = async (s: EvalSuite) => {
    setRunning(s.id);
    try {
      const r = await api.runEvalSuite(s.id, { branch: BRANCH });
      setResult({ suite: s.name, run: r });
      void reload();
    } catch (e) {
      toast.error(apiErrorText(e, "The eval run failed"));
    } finally {
      setRunning(null);
    }
  };

  const pin = async (r: EvalRun) => {
    try {
      await api.setEvalBaseline({ agentName, branch: r.branch || BRANCH, evalRunId: r.id });
      toast.success(`Baseline for ${r.branch || BRANCH} set to this run`);
      void reload();
    } catch (e) {
      toast.error(apiErrorText(e, "Couldn’t pin the baseline"));
    }
  };

  if (error) return <p role="alert" className="text-[13px] text-bad">{error}</p>;
  const suiteName = (id: string) => suites?.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="space-y-8">
      <Section
        title="Suites"
        action={
          canWrite ? (
            <Button size="sm" variant="secondary" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => setGenOpen(true)}>
              Draft a suite from runs
            </Button>
          ) : undefined
        }
      >
        <DataTable<EvalSuite>
          label="Eval suites"
          loading={suites === null}
          rows={suites ?? []}
          rowKey={(s) => s.id}
          pageSize={0}
          emptyIcon={FlaskConical}
          emptyTitle="No eval suites yet"
          emptyDescription="A suite is a set of inputs with what a good answer looks like. Draft one from this agent’s real runs, review it, then save it."
          columns={[
            { key: "name", header: "Suite", render: (s) => <span className="font-medium text-fg">{s.name}</span> },
            { key: "cases", header: "Cases", align: "right", render: (s) => <span className="num">{s.cases.length}</span> },
            {
              key: "latest",
              header: "Latest",
              align: "right",
              render: (s) => {
                const r = latestBySuite.get(s.id);
                if (!r) return <span className="text-fg-3">Not run</span>;
                return (
                  <span className={clsx("num", isRegressed(r, baseline ?? null) ? "text-bad" : r.passed ? "text-ok" : "text-warn")}>
                    {pct(r.score)}
                    {isRegressed(r, baseline ?? null) && <span className="ml-1.5 text-[12px]">regressed</span>}
                  </span>
                );
              },
            },
            {
              key: "run",
              header: "Run",
              headerHidden: true,
              align: "right",
              render: (s) =>
                canRun ? (
                  <Button size="sm" variant="ghost" icon={<Play className="h-3.5 w-3.5" />} loading={running === s.id} disabled={!!running} onClick={() => void run(s)}>
                    Run
                  </Button>
                ) : null,
            },
          ]}
        />
      </Section>

      <Section title="Runs">
        <DataTable<EvalRun>
          label="Eval runs"
          loading={runs === null}
          rows={(runs ?? []).slice(0, 50)}
          rowKey={(r) => r.id}
          pageSize={10}
          defaultSort={{ key: "when", dir: "desc" }}
          emptyTitle="No eval runs yet"
          emptyDescription="Run a suite above, or from CI with pal eval run. Results land here."
          columns={[
            { key: "suite", header: "Suite", render: (r) => <span className="text-fg">{suiteName(r.suiteId)}</span> },
            {
              key: "result",
              header: "Result",
              render: (r) => {
                const reg = isRegressed(r, baseline ?? null);
                return (
                <span className={clsx("inline-flex items-center gap-1.5", reg ? "text-bad" : r.passed ? "text-ok" : "text-warn")}>
                  {r.passed && !reg ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <XCircle className="h-3.5 w-3.5" aria-hidden />}
                  {reg ? "Regressed" : r.passed ? "Passed" : "Failed"}
                  {baseline?.evalRunId === r.id && (
                    <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
                      <Pin className="h-2.5 w-2.5" aria-hidden /> baseline
                    </span>
                  )}
                </span>
                );
              },
            },
            { key: "score", header: "Score", align: "right", render: (r) => <span className="num">{pct(r.score)} <span className="text-fg-3">({r.casesPassed}/{r.casesTotal})</span></span> },
            { key: "cost", header: "Cost", align: "right", hideOnMobile: true, render: (r) => <span className="num text-fg-2">{formatCost(r.totalCostUsd)}</span> },
            {
              key: "when",
              header: "When",
              hideOnMobile: true,
              sortable: true,
              sortFn: (a, b) => ts(a.createdAt) - ts(b.createdAt),
              className: "whitespace-nowrap text-fg-3",
              render: (r) => formatDistanceToNowStrict(ts(r.createdAt), { addSuffix: true }),
            },
            {
              key: "pin",
              header: "Baseline",
              headerHidden: true,
              align: "right",
              render: (r) =>
                canWrite && baseline?.evalRunId !== r.id ? (
                  <Button size="sm" variant="ghost" icon={<Pin className="h-3.5 w-3.5" />} onClick={() => void pin(r)}>
                    Pin as baseline
                  </Button>
                ) : null,
            },
          ]}
        />
      </Section>

      <EvalAnalytics agentName={agentName} refreshKey={runs?.length ?? 0} />

      <Modal open={!!result} onClose={() => setResult(null)} title={result ? `${result.suite}: ${pct(result.run.score)}` : ""} description={result?.run.regressed ? "Scored below the pinned baseline — CI would fail this change (HTTP 422)." : undefined} size="xl">
        {result && <RunResultView run={result.run} />}
      </Modal>
      <GenerateSuiteModal open={genOpen} onClose={() => setGenOpen(false)} agentName={agentName} onSaved={() => { setGenOpen(false); void reload(); }} />
    </div>
  );
}

function EvalAnalytics({ agentName, refreshKey }: { agentName: string; refreshKey: number }) {
  const [trends, setTrends] = useState<EvalTrends | null>(null);
  const [failures, setFailures] = useState<EvalFailures | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([api.getEvalTrends({ agentName, branch: BRANCH }), api.getEvalFailures({ agentName, branch: BRANCH })])
      .then(([t, f]) => { if (live) { setTrends(t); setFailures(f); } })
      .catch((e) => live && setError(apiErrorText(e, "Couldn’t load eval analytics")));
    return () => { live = false; };
  }, [agentName, refreshKey]);
  if (error) return <p role="alert" className="text-[13px] text-bad">{error}</p>;
  if (!trends || !failures) return <Skeleton className="h-24 w-full" />;
  if (trends.points.length === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="min-w-0 rounded-lg border border-line bg-panel p-4">
        <p className="text-[12.5px] text-fg-3">{trends.points.length === 1 ? "Score of the only run" : `Score over the last ${trends.points.length} runs`}</p>
        <div className="mt-2 flex items-end justify-between gap-3">
          <span className={clsx("num text-[20px] font-semibold", trends.regressing ? "text-bad" : "text-fg")}>{pct(trends.points[trends.points.length - 1].score)}</span>
          <div className="w-32 text-accent"><ScoreTrend values={trends.points.map((p) => p.score)} /></div>
        </div>
        <p className="mt-1 text-[12.5px] text-fg-3">
          {trends.regressing ? "Below the average of earlier runs." : trends.points.length > 1 ? "At or above the average of earlier runs." : "One run so far."}
        </p>
      </div>
      <div className="min-w-0 rounded-lg border border-line bg-panel p-4">
        <p className="text-[12.5px] text-fg-3">Most-failed cases ({failures.runsScanned} run{failures.runsScanned === 1 ? "" : "s"} scanned)</p>
        {failures.clusters.length === 0 ? (
          <p className="mt-2 text-[13px] text-fg-2">No case has failed.</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {failures.clusters.slice(0, 4).map((c) => (
              <li key={c.case} className="flex min-w-0 items-baseline justify-between gap-3 text-[13px]" title={c.sampleError || undefined}>
                <span className="min-w-0 truncate text-fg-2">{c.case}</span>
                <span className="num shrink-0 text-bad">{c.failures}/{c.seen}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function GenerateSuiteModal({ open, onClose, agentName, onSaved }: { open: boolean; onClose: () => void; agentName: string; onSaved: () => void }) {
  const toast = useToast();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState<"draft" | "save" | null>(null);
  const [draft, setDraft] = useState<GeneratedEvalSuite | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!open) { setDraft(null); setError(null); } }, [open]);

  const generate = async () => {
    setBusy("draft");
    setError(null);
    try {
      setDraft(await api.generateEvalSuite({ agentName, goal: goal.trim() || undefined, maxCases: 8 }));
    } catch (e) {
      setError(apiErrorText(e, "Couldn’t draft a suite"));
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    if (!draft) return;
    setBusy("save");
    try {
      await api.upsertEvalSuite(draft.draft);
      toast.success(`Saved “${draft.draft.name}”`);
      onSaved();
    } catch (e) {
      setError(apiErrorText(e, "Couldn’t save the suite"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Draft a suite from real runs"
      description="The agent reads its own runs and feedback and proposes cases. Nothing is saved until you approve."
      size="lg"
      footer={
        draft ? (
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>Start over</Button>
            <Button onClick={() => void save()} loading={busy === "save"} disabled={!draft.draft.cases.length}>Save {draft.draft.cases.length} cases</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void generate()} loading={busy === "draft"}>Draft cases</Button>
          </>
        )
      }
    >
      {error && <p role="alert" className="mb-3 rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
      {!draft ? (
        <div>
          <label htmlFor="gen-goal" className="mb-1 block text-[12.5px] font-medium text-fg-2">What should the suite check? <span className="font-normal text-fg-3">(optional)</span></label>
          <input id="gen-goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. release notes always list breaking changes first" className="focus-ring w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13.5px] text-fg placeholder:text-fg-3" />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] text-fg-2">
            <span className="font-medium text-fg">{draft.draft.name}</span> · grounded in {draft.evidence.runs} run{draft.evidence.runs === 1 ? "" : "s"} and {draft.evidence.feedback} feedback item{draft.evidence.feedback === 1 ? "" : "s"} · drafted by {draft.model} for {formatCost(draft.costUsd)}
          </p>
          {draft.draft.cases.length === 0 ? (
            <p className="flex items-center gap-2 text-[13px] text-warn"><AlertTriangle className="h-4 w-4" aria-hidden /> No case survived grounding. Run the agent a few times, then try again.</p>
          ) : (
            <ul className="max-h-[50vh] divide-y divide-line overflow-auto rounded-lg border border-line">
              {draft.draft.cases.map((c) => {
                const prov = draft.provenance.find((p) => p.case === c.name);
                return (
                  <li key={c.name} className="p-3 text-[13px]">
                    <p className="font-medium text-fg">{c.name}</p>
                    <p className="mt-0.5 line-clamp-2 font-mono text-[12px] text-fg-2">{c.input}</p>
                    {c.expected && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-fg-3">Expect: {c.expected}</p>}
                    {prov && <p className="mt-0.5 text-[12px] text-fg-3">From {prov.source}{prov.grounding ? ` · ${prov.grounding}` : ""}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {draft.dropped.length > 0 && <p className="text-[12.5px] text-fg-3">{draft.dropped.length} candidate case{draft.dropped.length === 1 ? " was" : "s were"} dropped for weak grounding.</p>}
        </div>
      )}
    </Modal>
  );
}

// ── Gate ──────────────────────────────────────────────────────────────────────

/**
 * The one real ship signal today: the latest eval run against the pinned
 * baseline (the same comparison CI uses for its 422). Policy / injection /
 * secret-lint have no per-version endpoint yet, so they say so.
 */
export function GatePanel({ agentName }: { agentName: string }) {
  const { runs, baseline, error } = useEvals(agentName);
  if (error) return <p role="alert" className="text-[13px] text-bad">{error}</p>;
  const loading = runs === null || baseline === undefined;
  const v = loading ? null : gateVerdict(runs, baseline ?? null);
  return (
    <div className="space-y-4">
      <Section title="Ship check">
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          <li className="flex items-start gap-3 p-4">
            {!v ? (
              <Skeleton className="h-5 w-full" />
            ) : (
              <>
                {v.state === "pass" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
                ) : v.state === "none" ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-bad" aria-hidden />
                )}
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium text-fg">{v.title}</p>
                  <p className="text-[13px] text-fg-3">{v.detail}</p>
                </div>
              </>
            )}
          </li>
          <li className="flex items-start gap-3 p-4">
            <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" aria-hidden />
            <div>
              <p className="text-[13.5px] font-medium text-fg-2">Policy check, prompt-injection scan, secret lint</p>
              <p className="text-[13px] text-fg-3">Not available yet. These checks don’t report a result per version.</p>
            </div>
          </li>
        </ul>
      </Section>
      <p className="text-[12.5px] text-fg-3">Promotion still runs its own server-side gates (version, order, budget, evals). They show on the Promote tab when you promote.</p>
    </div>
  );
}
