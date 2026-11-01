"use client";

// Per-agent reliability (ADR 0056): SLO targets with error-budget burn, a run
// activity chart, and opt-in sampled production evals with per-version drift.
// Every verdict (burn alerts, drift) is the server's; this page lays it out.

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ArrowLeft } from "lucide-react";
import { api, type Incident, type ProdEvals, type SliStatus } from "@/lib/api";
import type { Run } from "@/lib/types";
import {
  apiErrorText,
  budgetPct,
  fmtMs,
  fmtUsd,
  incidentTone,
  kindLabel,
  parseProdEvalDraft,
  parseSloDraft,
  prettyRule,
  sloToDraft,
  sloTone,
  windowLabel,
  type ProdEvalDraft,
  type SloDraft,
} from "@/lib/observability";
import { bucketRuns } from "@/lib/timeseries";
import { ts } from "@/lib/overview";
import { Button } from "@/components/button";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { TimeSeries, type ChartSeries } from "@/components/time-series";
import { TonePill } from "@/components/tone-pill";
import { useToast } from "@/components/toast";
import { useCan } from "@/components/role-gate";

const inputCls =
  "focus-ring w-full rounded-md border border-line-strong bg-canvas px-3 py-1.5 text-[13px] text-fg disabled:opacity-60";
const card = "rounded-[12px] border border-line bg-panel p-4";
const BAR = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", muted: "bg-fg-3" } as const;
const RUNS_CAP = 100; // the runs list returns the newest 100

const fmtCount = (v: number) => (Number.isInteger(v) ? String(v) : "");
const fmtCost = (v: number) => fmtUsd(v);

interface Loaded {
  slis: SliStatus[];
  configured: boolean;
  slo: SloDraft;
  pe: ProdEvals;
  peDraft: ProdEvalDraft;
}

const DEFAULT_SLO: SloDraft = { objective: "0.95", latencyMs: "", costUsd: "", minScore: "", windowDays: "28" };

export default function AgentReliabilityPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: raw } = use(params);
  const name = decodeURIComponent(raw);
  const toast = useToast();
  const canWrite = useCan("agents:write");
  const [data, setData] = useState<Loaded | null>(null);
  const [slo, setSlo] = useState<SloDraft>(DEFAULT_SLO);
  const [pe, setPe] = useState<ProdEvalDraft | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [runsErr, setRunsErr] = useState<string | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [saving, setSaving] = useState<"slo" | "pe" | null>(null);
  const [formErr, setFormErr] = useState<{ slo?: string; pe?: string }>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.getSloStatus(name), api.getProdEvals(name)]);
      const draft = s.slo ? sloToDraft(s.slo) : DEFAULT_SLO;
      const peDraft: ProdEvalDraft = {
        enabled: p.config.enabled,
        sampleRate: String(p.config.sampleRate),
        dailyBudgetUsd: String(p.config.dailyBudgetUsd),
        rubric: p.config.rubric,
      };
      setData({ slis: s.slis ?? [], configured: s.configured, slo: draft, pe: p, peDraft });
      setSlo(draft);
      setPe(peDraft);
      setError(null);
    } catch (e) {
      setError(apiErrorText(e, "Failed to load reliability"));
    }
  }, [name]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let live = true;
    api.listRuns({ agentName: name }).then((r) => live && (setRuns(r), setRunsErr(null))).catch((e) => live && setRunsErr(apiErrorText(e, "Couldn’t load runs")));
    api.listIncidents({ agent: name, status: "active" }).then((i) => live && setIncidents(i)).catch(() => undefined); // strip is secondary; the Incidents page shows the real error
    return () => { live = false; };
  }, [name]);

  const series = useMemo(
    () => (runs ? bucketRuns(runs.map((r) => ({ at: ts(r.createdAt), failed: r.status === "failed", costUsd: r.costUsd ?? 0 }))) : null),
    [runs],
  );
  const runSeries = useMemo<ChartSeries[]>(
    () => (series ? [{ label: "Runs", values: series.runs, token: "accent", bars: true }, { label: "Failed", values: series.failed, token: "bad", bars: true }] : []),
    [series],
  );
  const costSeries = useMemo<ChartSeries[]>(() => (series ? [{ label: "Cost (USD)", values: series.costUsd, token: "ok" }] : []), [series]);

  const saveSlo = async () => {
    const parsed = parseSloDraft(slo);
    if (!parsed.ok) return setFormErr((f) => ({ ...f, slo: parsed.error }));
    setFormErr((f) => ({ ...f, slo: undefined }));
    setSaving("slo");
    try {
      await api.putSlo(name, parsed.value);
      toast.success("SLO saved");
      await load();
    } catch (e) {
      toast.error(apiErrorText(e, "Save failed"));
    } finally {
      setSaving(null);
    }
  };
  const savePe = async () => {
    if (!pe || !data) return;
    const parsed = parseProdEvalDraft(pe, data.pe.config.judgeModel);
    if (!parsed.ok) return setFormErr((f) => ({ ...f, pe: parsed.error }));
    setFormErr((f) => ({ ...f, pe: undefined }));
    setSaving("pe");
    try {
      await api.putProdEvals(name, parsed.value);
      toast.success("Production evals saved");
      await load();
    } catch (e) {
      toast.error(apiErrorText(e, "Save failed"));
    } finally {
      setSaving(null);
    }
  };

  const base = `/agents/${encodeURIComponent(name)}`;
  const header = (
    <PageHeader
      title="Reliability"
      description={`Error budgets, run activity and sampled production quality for ${name}.`}
      secondaryAction={
        <Link href={base} className="focus-ring inline-flex items-center gap-1 rounded text-[13px] text-fg-3 hover:text-fg">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {name}
        </Link>
      }
    />
  );

  if (error) {
    return (
      <div className="flex-1 overflow-auto">
        {header}
        <div role="alert" className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-[12px] border border-bad/40 bg-bad-soft p-4 text-[13px] text-bad md:mx-8">
          <span>{error}</span>
          <Button variant="secondary" size="sm" onClick={() => void load()}>Retry</Button>
        </div>
      </div>
    );
  }
  if (!data || !pe) {
    return (
      <div className="flex-1 overflow-auto">
        {header}
        <div className="space-y-3 px-4 py-6 md:px-8"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>
      </div>
    );
  }

  const set = <K extends keyof SloDraft>(k: K, v: string) => setSlo((d) => ({ ...d, [k]: v }));
  const field = (label: string, k: keyof SloDraft, mode: "decimal" | "numeric") => (
    <label className="text-[12px] text-fg-3">
      {label}
      <input className={clsx(inputCls, "mt-1")} inputMode={mode} value={slo[k]} disabled={!canWrite} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  const runsNote = runs && runs.length >= RUNS_CAP ? `the newest ${RUNS_CAP} runs` : `${runs?.length ?? 0} runs`;

  return (
    <div className="flex-1 overflow-auto">
      {header}
      <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 md:px-8">
        <section aria-label="Service level objectives" className={card}>
          <h2 className="text-[14px] font-semibold text-fg">Service level objectives</h2>
          <p className="mb-4 mt-1 text-[12.5px] text-fg-3">
            Each target is a share of runs that must be good; the gap is the error budget. Burn alerts use the platform’s
            multi-window rules (14.4x over 1h/5m, 6x over 6h/30m, 3x over 1d/2h, 1x over 3d/6h) and are evaluated by the server.
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {field("Objective (0 to 1)", "objective", "decimal")}
            {field("Latency limit per run (ms)", "latencyMs", "numeric")}
            {field("Cost per run USD", "costUsd", "decimal")}
            {field("Min eval score (0 to 1)", "minScore", "decimal")}
            {field("Window (days, 1 to 90)", "windowDays", "numeric")}
          </div>
          {formErr.slo && <p role="alert" className="mt-3 text-[12.5px] text-bad">{formErr.slo}</p>}
          <div className="mt-3 flex items-center gap-3">
            {canWrite ? (
              <Button variant="primary" size="sm" loading={saving === "slo"} onClick={saveSlo}>
                {data.configured ? "Update SLO" : "Enable SLO"}
              </Button>
            ) : (
              <p className="text-[12.5px] text-fg-3">Your role can read this but not change it.</p>
            )}
          </div>

          {data.configured && (
            <ul className="mt-5 space-y-5" aria-label="Objective status">
              {data.slis.map((s) => {
                const tone = sloTone(s);
                return (
                  <li key={s.name} data-testid={`sli-${s.name}`}>
                    <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12.5px]">
                      <span className="font-medium capitalize text-fg">{s.name}</span>
                      <span className="text-fg-3">{s.target}</span>
                      {s.alerts.map((a) => (
                        <TonePill key={a.rule} tone={a.severity === "page" ? "bad" : "warn"}>
                          {a.severity}: burning {a.longBurn.toFixed(1)}x ({prettyRule(a.rule)})
                        </TonePill>
                      ))}
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded bg-raised"
                      role="progressbar"
                      aria-label={`${s.name} error budget remaining`}
                      aria-valuenow={budgetPct(s.budgetRemaining)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div className={clsx("h-2", BAR[tone])} style={{ width: `${budgetPct(s.budgetRemaining)}%` }} />
                    </div>
                    <p className="num mt-1 text-[12px] text-fg-3">
                      {s.total === 0
                        ? "No runs in the window yet."
                        : `${(s.attainment * 100).toFixed(2)}% good (${s.good}/${s.total}) · budget ${s.budgetRemaining < 0 ? "exhausted" : `${budgetPct(s.budgetRemaining)}% left`}`}
                      {s.measured !== undefined && s.measuredLabel
                        ? ` · ${s.measuredLabel}: ${s.measuredLabel.includes("latency") ? fmtMs(s.measured) : fmtUsd(s.measured)}`
                        : ""}
                    </p>
                    {s.burnRates.length > 0 && (
                      <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-fg-3" aria-label={`${s.name} burn rate by window`}>
                        {s.burnRates.map((b) => (
                          <div key={b.window} className="flex gap-1.5">
                            <dt>{windowLabel(b.window)}</dt>
                            <dd className="num text-fg-2">{b.events === 0 ? "no runs" : `${b.burn.toFixed(1)}x`}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Run activity" className={card}>
          <h2 className="text-[14px] font-semibold text-fg">Run activity</h2>
          <p className="mb-3 mt-1 text-[12.5px] text-fg-3">Counts and cost per time bucket from {runsNote}. Descriptive only; SLO status above is the server’s call.</p>
          {runsErr ? (
            <p role="alert" className="text-[13px] text-bad">{runsErr}</p>
          ) : !runs ? (
            <Skeleton className="h-44 w-full" />
          ) : !series ? (
            <p className="text-[13px] text-fg-3">No runs yet.</p>
          ) : (
            <div className="grid gap-5 md:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1 text-[12.5px] font-medium text-fg-2">Runs and failures</p>
                <TimeSeries x={series.x} series={runSeries} minTop={4} ariaLabel="Runs and failed runs over time" fmt={fmtCount} />
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-[12.5px] font-medium text-fg-2">Cost</p>
                <TimeSeries x={series.x} series={costSeries} minTop={0.01} ariaLabel="Cost over time" fmt={fmtCost} />
              </div>
            </div>
          )}
        </section>

        {incidents.length > 0 && (
          <section aria-label="Open incidents" className={card}>
            <h2 className="text-[14px] font-semibold text-fg">Open incidents</h2>
            <ul className="mt-2 space-y-1.5">
              {incidents.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <TonePill tone={incidentTone(i)}>{i.severity}</TonePill>
                  <Link href={`/incidents/${encodeURIComponent(i.id)}`} className="focus-ring rounded text-fg hover:underline">{i.title}</Link>
                  <span className="text-fg-3">{kindLabel(i.kind)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="Production evals" className={card}>
          <h2 className="text-[14px] font-semibold text-fg">Production evals</h2>
          <p className="mb-4 mt-1 text-[12.5px] text-fg-3">
            Off by default. When on, a deterministic sample of real succeeded runs is scored by the LLM judge (a different model
            than the one that produced the run). Spend is capped per day and counted against this agent’s budget.
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <label className="flex items-center gap-2 text-[13px] text-fg-2">
              <input type="checkbox" checked={pe.enabled} disabled={!canWrite} onChange={(e) => setPe({ ...pe, enabled: e.target.checked })} />
              Score sampled runs
            </label>
            <label className="text-[12px] text-fg-3">
              Sample rate (0 to 1)
              <input className={clsx(inputCls, "mt-1")} inputMode="decimal" value={pe.sampleRate} disabled={!canWrite} onChange={(e) => setPe({ ...pe, sampleRate: e.target.value })} />
            </label>
            <label className="text-[12px] text-fg-3">
              Daily budget USD
              <input className={clsx(inputCls, "mt-1")} inputMode="decimal" value={pe.dailyBudgetUsd} disabled={!canWrite} onChange={(e) => setPe({ ...pe, dailyBudgetUsd: e.target.value })} />
            </label>
            <p className="num self-end text-[12.5px] text-fg-3">Spent today {fmtUsd(data.pe.spentTodayUsd)}</p>
          </div>
          <label className="mt-3 block text-[12px] text-fg-3">
            Rubric (blank uses the default)
            <textarea className={clsx(inputCls, "mt-1 h-20")} value={pe.rubric} disabled={!canWrite} onChange={(e) => setPe({ ...pe, rubric: e.target.value })} />
          </label>
          {formErr.pe && <p role="alert" className="mt-3 text-[12.5px] text-bad">{formErr.pe}</p>}
          {canWrite && (
            <div className="mt-3">
              <Button variant="primary" size="sm" loading={saving === "pe"} onClick={savePe}>Save</Button>
            </div>
          )}

          <h3 className="mb-2 mt-6 text-[12px] font-medium uppercase tracking-wide text-fg-3">
            Score by version ({data.pe.scored} scored, 30 days)
          </h3>
          {data.pe.versions.length === 0 ? (
            <p className="text-[13px] text-fg-3">No scored runs yet. Turn scoring on and runs are sampled as they succeed.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]">
                <thead className="text-fg-3">
                  <tr>
                    <th scope="col" className="py-1 pr-4 font-medium">Version</th>
                    <th scope="col" className="py-1 pr-4 font-medium">Runs</th>
                    <th scope="col" className="py-1 pr-4 font-medium">Mean score</th>
                    <th scope="col" className="py-1 pr-4 font-medium">Pass rate</th>
                    <th scope="col" className="py-1 font-medium">Change vs previous</th>
                  </tr>
                </thead>
                <tbody className="num font-mono text-fg-2">
                  {data.pe.versions.map((v) => (
                    <tr key={v.version} className="border-t border-line">
                      <td className="py-1.5 pr-4">{v.version || "unknown"}</td>
                      <td className="py-1.5 pr-4">{v.n}</td>
                      <td className="py-1.5 pr-4">{v.meanScore.toFixed(2)}</td>
                      <td className="py-1.5 pr-4">{(v.passRate * 100).toFixed(0)}%</td>
                      <td className="py-1.5">
                        {v.deltaVsPrev === undefined || v.deltaVsPrev === null ? (
                          "baseline"
                        ) : (
                          <span className={v.drifted ? "text-bad" : undefined}>
                            {v.deltaVsPrev >= 0 ? "+" : ""}
                            {v.deltaVsPrev.toFixed(2)}
                            {v.drifted ? " drift" : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
