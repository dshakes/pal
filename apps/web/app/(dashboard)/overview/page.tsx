"use client";

// /overview — PAL Runtime home. Reads top-down like an on-call handover:
//   1. one sentence that says whether things are fine (lib/overview.verdict)
//   2. the four numbers that matter, as one instrument strip
//   3. what ran when (48 half-hour slots)
//   4. what needs attention, with a one-click server-grounded "Why?"
// Every number is a real API read; a source that fails shows "—", never a
// made-up value. The page describes itself to the agent panel (⌘\).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { AlertCircle, Bot, Plus, RefreshCw, Sparkles } from "lucide-react";
import { api, type FleetUsage } from "@/lib/api";
import type { Agent, Run } from "@/lib/types";
import { formatCost } from "@/lib/format";
import { bucketRuns, ts, verdict, type Bucket, type Tone } from "@/lib/overview";
import { runtimeApi } from "@/lib/runtime-api";
import type { VmRow } from "@/lib/runtime-types";
import { useModels } from "@/lib/model-context";
import { openAsk } from "@/lib/ask-events";
import { PageHeader } from "@/components/page-header";
import { Button, LinkButton } from "@/components/button";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ExplainInline } from "@/components/explain-inline";
import { DataTable } from "@/components/data-table";
import { RoleGate } from "@/components/role-gate";
import { useAgentSurface, useAgentSurfaceToggle } from "@/components/agent-surface";

const HOUR = 3_600_000;

export default function OverviewPage() {
  const router = useRouter();
  const { isConfigured } = useModels();
  const surface = useAgentSurfaceToggle();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [usage, setUsage] = useState<FleetUsage | null>(null);
  const [vms, setVms] = useState<VmRow[] | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const [a, r, u, v] = await Promise.all([
      api.listAgents().catch(() => null),
      api.listRuns().catch(() => null),
      api.getFleetUsage(),
      runtimeApi.get<VmRow[] | { items: VmRow[] }>("/v1/runtime/vms?limit=100").then((x) => (Array.isArray(x) ? x : x.items ?? [])).catch(() => null),
    ]);
    setAgents(a);
    setRuns(r);
    setUsage(u);
    setVms(v);
    setLoading(false);
    setLoadedAt(Date.now());
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  const s = useMemo(() => {
    const all = runs ?? [];
    const day = all.filter((r) => now - ts(r.createdAt) < 24 * HOUR);
    const finished = day.filter((r) => r.status === "succeeded" || r.status === "failed");
    const ok = finished.filter((r) => r.status === "succeeded").length;
    const failures = all.filter((r) => r.status === "failed").sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
    const perAgent = new Map<string, { runs: number; failed: number; last?: Run }>();
    for (const r of day) {
      const e = perAgent.get(r.agentName) ?? { runs: 0, failed: 0 };
      e.runs += 1;
      if (r.status === "failed") e.failed += 1;
      if (!e.last || ts(r.createdAt) > ts(e.last.createdAt)) e.last = r;
      perAgent.set(r.agentName, e);
    }
    return {
      runs24: day.length,
      failed24: day.filter((r) => r.status === "failed").length,
      live: all.filter((r) => r.status === "running" || r.status === "queued").length,
      successRate: finished.length ? Math.round((ok / finished.length) * 100) : null,
      buckets: bucketRuns(all, now, 48),
      failures,
      perAgent,
      verdict: verdict(all, now),
    };
  }, [runs, now]);

  const runningVms = vms?.filter((v) => v.state === "running").length ?? null;
  const pausedVms = vms?.filter((v) => v.state === "paused").length ?? 0;
  const costToday = usage?.periods.today.costUsd;
  const costWeek = usage?.periods.week.costUsd;
  const noAgents = agents !== null && agents.length === 0;
  const allFailed = !loading && agents === null && runs === null;

  useAgentSurface({
    page: "Runtime overview",
    facts: [
      `${agents?.length ?? "unknown"} agents`,
      `${s.runs24} runs in the last 24h, ${s.failed24} failed`,
      `success rate ${s.successRate ?? "unknown"}%`,
      `${runningVms ?? "unknown"} sandboxes running`,
      costToday === undefined ? "spend today unknown" : `spend today ${formatCost(costToday)}`,
      isConfigured ? "a model provider is configured" : "no model provider key yet",
    ],
    suggestions: s.failures.length
      ? ["Why did my last run fail?", "Which agent fails most?", "Open runs"]
      : ["Create an agent that triages GitHub issues", "How many agents do I have?"],
    explain: s.failures.slice(0, 5).map((r) => ({
      id: r.id,
      label: `${r.agentName} run ${r.id.slice(0, 8)} failed`,
      sub: r.error?.message,
      request: { kind: "run" as const, runId: r.id },
    })),
  });

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Overview"
        description="Health, spend and sandboxes across this Runtime workspace."
        secondaryAction={
          <Button variant="ghost" size="md" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void load()}>
            Refresh
          </Button>
        }
        action={
          <RoleGate cap="agents:write">
            <LinkButton href="/agents/create" variant="primary" icon={<Plus className="h-3.5 w-3.5" />}>
              New agent
            </LinkButton>
          </RoleGate>
        }
      />

      <div className="mx-auto w-full max-w-[1200px] space-y-5 px-4 pb-8 pt-4 md:px-8">
        {allFailed ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[12px] border border-bad/40 bg-bad-soft px-4 py-3.5">
            <AlertCircle className="h-4 w-4 text-bad" aria-hidden />
            <p className="flex-1 text-[13px] text-fg">Couldn’t reach the control plane, so nothing below is current.</p>
            <Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>
          </div>
        ) : null}

        {/* 1 — the verdict */}
        <section aria-label="Status" className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          {loading ? (
            <Skeleton className="h-7 w-full max-w-[520px]" />
          ) : (
            <div className="flex min-w-0 items-start gap-3">
              <StatusGlyph tone={runs === null ? "idle" : s.verdict.tone} />
              <div className="min-w-0">
                <p className="text-[17px] font-medium leading-snug tracking-[-0.01em] text-fg md:text-[21px]" aria-live="polite">
                  {/* Non-breaking hyphens keep agent names like pr-triage on one line. */}
                  {(runs === null ? "Run history is unavailable right now." : s.verdict.text).replace(/-/g, "\u2011")}
                </p>
                {loadedAt && (
                  <p className="mt-0.5 text-[12px] text-fg-3">
                    {now - loadedAt < 10_000 ? "Updated just now" : `Updated ${formatDistanceToNowStrict(loadedAt, { addSuffix: true })}`}, refreshes every 20 seconds
                  </p>
                )}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={surface.toggle}
            className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 self-start rounded-md border border-accent/35 px-2.5 text-[13px] font-medium text-accent hover:bg-accent-soft md:self-auto"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Ask about this
          </button>
        </section>

        {/* 2 — instrument strip */}
        <section aria-label="At a glance" className="grid grid-cols-2 overflow-hidden rounded-[12px] border border-line bg-panel lg:grid-cols-4">
          <Stat
            href="/runs"
            label="Runs (24h)"
            value={loading ? null : runs === null ? "—" : String(s.runs24)}
            note={s.live ? `${s.live} live now` : "none live"}
            className="border-b border-r border-line lg:border-b-0"
          />
          <Stat
            href="/runs"
            label="Success rate"
            value={loading ? null : s.successRate === null ? "—" : `${s.successRate}%`}
            note={s.failed24 ? `${s.failed24} failed` : "no failures"}
            tone={s.successRate !== null && s.successRate < 90 ? "bad" : undefined}
            className="border-b border-line lg:border-b-0 lg:border-r"
          />
          <Stat
            href="/budgets"
            label="Spend today"
            value={loading ? null : costToday === undefined ? "—" : formatCost(costToday)}
            note={costWeek === undefined ? "usage unavailable" : `${formatCost(costWeek)} this week`}
            className="border-r border-line"
          />
          <Stat
            href="/runtime"
            label="Sandboxes running"
            value={loading ? null : runningVms === null ? "—" : String(runningVms)}
            note={vms === null ? "runtime unavailable" : pausedVms ? `${pausedVms} paused` : "microVM runtime"}
          />
        </section>

        {noAgents ? (
          <EmptyState
            icon={Bot}
            title="Build your first agent"
            description="Describe the job in plain words. PAL designs the agent, tests your model key, and runs it once so you can see it work."
            actionLabel="Start guided setup"
            actionHref="/onboarding"
            secondaryActionLabel="Browse templates"
            secondaryActionHref="/marketplace"
            suggestions={[
              { label: "Triage GitHub issues", onClick: () => openAsk({ query: "Create an agent that triages GitHub issues", submit: true }) },
              { label: "Summarize my inbox daily", onClick: () => openAsk({ query: "Create an agent that summarizes my inbox every morning", submit: true }) },
              { label: "Answer support questions", onClick: () => openAsk({ query: "Create an agent that answers support questions from our docs", submit: true }) },
            ]}
          />
        ) : (
          <>
            {/* 3 — when things ran */}
            <section aria-labelledby="activity-h" className="rounded-[12px] border border-line bg-panel px-4 pb-3 pt-3.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="activity-h" className="text-[14px] font-semibold text-fg">Runs, last 24 hours</h2>
                <span className="flex items-center gap-3 text-[12px] text-fg-3">
                  <Legend className="bg-accent" label="Succeeded" />
                  <Legend className="bg-bad" label="Failed" />
                  <Legend className="bg-line-strong" label="Other" />
                </span>
              </div>
              {loading ? <Skeleton className="mt-3 h-20 w-full" /> : <RunStrip buckets={s.buckets} />}
            </section>

            {/* 4 — what needs attention */}
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
              <section aria-labelledby="attention-h" className="min-w-0 space-y-2.5">
                <div className="flex items-baseline justify-between">
                  <h2 id="attention-h" className="text-[14px] font-semibold text-fg">Needs attention</h2>
                  <Link href="/runs" className="focus-ring rounded text-[12.5px] font-medium text-accent hover:underline">All runs</Link>
                </div>
                <DataTable<Run>
                  label="Failed runs"
                  fixed
                  loading={loading}
                  rows={s.failures.slice(0, 8)}
                  rowKey={(r) => r.id}
                  pageSize={0}
                  onRowClick={(r) => router.push(`/runs/${encodeURIComponent(r.id)}`)}
                  emptyTitle="Nothing needs you"
                  emptyDescription="No failed runs. Failures land here with a one-click explanation."
                  columns={[
                    {
                      key: "run",
                      header: "Run",
                      render: (r) => (
                        <div className="min-w-0">
                          <p className="truncate font-mono text-[12.5px] text-fg" title={`Run ${r.id}`}>{r.agentName}</p>
                          {r.error && (
                            <p className="density-detail mt-0.5 truncate text-[12px] text-fg-3" title={r.error.message}>
                              <span className="text-bad">{errorLabel(r.error.code)}</span>
                              {errorWhere(r.error.message)}
                            </p>
                          )}
                        </div>
                      ),
                    },
                    {
                      key: "when",
                      header: "When",
                      hideOnMobile: true,
                      width: 130,
                      className: "whitespace-nowrap text-fg-3",
                      render: (r) => (Number.isFinite(ts(r.createdAt)) ? formatDistanceToNowStrict(ts(r.createdAt), { addSuffix: true }) : "—"),
                    },
                    {
                      key: "why",
                      header: "Explain",
                      width: 96,
                      align: "right",
                      render: (r) => (
                        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="inline-block text-left">
                          <ExplainInline request={{ kind: "run", runId: r.id }} label="Why?" size="xs" />
                        </span>
                      ),
                    },
                  ]}
                />
              </section>

              <section aria-labelledby="agents-h" className="space-y-2.5">
                <div className="flex items-baseline justify-between">
                  <h2 id="agents-h" className="text-[14px] font-semibold text-fg">Agents, last 24 hours</h2>
                  <Link href="/agents" className="focus-ring rounded text-[12.5px] font-medium text-accent hover:underline">All agents</Link>
                </div>
                <ul className="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-panel">
                  {loading && <li className="p-3"><Skeleton className="h-5 w-full" /></li>}
                  {(agents ?? []).slice(0, 7).map((a) => {
                    const st = s.perAgent.get(a.name);
                    const tone: Tone = !st ? "idle" : st.last?.status === "failed" ? "bad" : "ok";
                    return (
                      <li key={a.id}>
                        <Link
                          href={`/agents/${encodeURIComponent(a.name)}`}
                          className="focus-ring flex items-center gap-2.5 px-3 py-2.5 text-[13px] hover:bg-raised"
                        >
                          <Dot tone={tone} />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{a.name}</span>
                          <span className="num shrink-0 text-[12px] text-fg-3">
                            {st ? `${st.runs} run${st.runs === 1 ? "" : "s"}${st.failed ? `, ${st.failed} failed` : ""}` : "idle"}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Short human label for a run error code ("llm_error" → "Model call failed"). */
function errorLabel(code?: string): string {
  const known: Record<string, string> = {
    llm_error: "Model call failed",
    budget_exceeded: "Over budget",
    timeout: "Timed out",
    step_timeout: "Step timed out",
    tool_error: "Tool failed",
    connector_error: "Connector failed",
  };
  if (!code) return "Failed";
  return known[code] ?? code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Where it failed, from the raw message: the unreachable host when there is one. The full text stays in the tooltip. */
function errorWhere(message?: string): string {
  if (!message) return "";
  const host = message.match(/https?:\/\/([^/"\s:]+)/)?.[1];
  if (host) return `, ${host.replace(/^api\./, "")} unreachable`;
  return `: ${message.length > 60 ? message.slice(0, 60) + "…" : message}`;
}

function Stat({
  label, value, note, href, tone, className,
}: {
  label: string;
  value: string | null;
  note: string;
  href: string;
  tone?: "bad";
  className?: string;
}) {
  return (
    <Link href={href} className={clsx("focus-ring group block px-4 py-3.5 transition-colors hover:bg-raised", className)}>
      <p className="text-[12.5px] text-fg-3">{label}</p>
      {value === null ? (
        <Skeleton className="mt-1.5 h-7 w-16" />
      ) : (
        <p className={clsx("num mt-0.5 font-display text-[28px] font-semibold leading-tight tracking-[-0.02em]", tone === "bad" ? "text-bad" : "text-fg")}>{value}</p>
      )}
      {/* Never state a fact before the data that backs it has loaded. */}
      {value === null ? <Skeleton className="mt-1.5 h-3 w-24" /> : <p className="mt-0.5 truncate text-[12px] text-fg-3">{note}</p>}
    </Link>
  );
}

function StatusGlyph({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "mt-[7px] flex h-3 w-3 shrink-0 items-center justify-center rounded-full ring-4",
        tone === "ok" && "bg-ok ring-ok-soft",
        tone === "bad" && "bg-bad ring-bad-soft",
        tone === "idle" && "bg-fg-3 ring-raised",
      )}
    />
  );
}

function Dot({ tone }: { tone: Tone }) {
  return (
    <span
      role="img"
      aria-label={tone === "bad" ? "last run failed" : tone === "ok" ? "healthy" : "no runs today"}
      className={clsx("h-2 w-2 shrink-0 rounded-full", tone === "ok" && "bg-ok", tone === "bad" && "bg-bad", tone === "idle" && "bg-line-strong")}
    />
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={clsx("h-2 w-2 rounded-[2px]", className)} />
      {label}
    </span>
  );
}

/** 48 half-hour slots. Height = runs in the slot; failures stack on top. */
function RunStrip({ buckets }: { buckets: Bucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.ok + b.fail + b.other));
  const total = buckets.reduce((n, b) => n + b.ok + b.fail + b.other, 0);
  if (total === 0) return <p className="py-8 text-center text-[13px] text-fg-3">No runs in the last 24 hours.</p>;
  const failed = buckets.reduce((n, b) => n + b.fail, 0);
  return (
    <figure className="relative mt-3 pt-4">
      <p className="absolute right-0 top-0 text-[11.5px] text-fg-3" aria-hidden>peak {max} per 30 min</p>
      <div
        className="flex h-20 items-end gap-[2px] border-b border-line"
        role="img"
        aria-label={`${total} runs in the last 24 hours, ${failed} failed`}
      >
        {buckets.map((b, i) => {
          const n = b.ok + b.fail + b.other;
          const hoursAgo = 24 - i / 2;
          return (
            <div
              key={i}
              className="flex h-full flex-1 flex-col justify-end"
              title={n ? `${n} run${n === 1 ? "" : "s"} (${b.fail} failed), ${hoursAgo.toFixed(1)}h to ${(hoursAgo - 0.5).toFixed(1)}h ago` : undefined}
            >
              {n > 0 ? (
                <div className="flex flex-col overflow-hidden rounded-t-[2px]" style={{ height: `${Math.max(8, (n / max) * 100)}%` }}>
                  <div className="bg-bad" style={{ flexGrow: b.fail }} />
                  <div className="bg-line-strong" style={{ flexGrow: b.other }} />
                  <div className="bg-accent" style={{ flexGrow: b.ok }} />
                </div>
              ) : (
                <div className="h-px bg-line-strong" />
              )}
            </div>
          );
        })}
      </div>
      <figcaption className="mt-1.5 flex justify-between text-[11.5px] text-fg-3">
        <span>24h ago</span>
        <span className="hidden sm:inline">18h</span>
        <span>12h</span>
        <span className="hidden sm:inline">6h</span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}
