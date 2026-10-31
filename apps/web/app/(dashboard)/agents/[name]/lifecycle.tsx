"use client";
// Agent lifecycle (v3): the rail plus the panels that are new in slice 2 —
// Evals, Gate, Promote, Debug. Design / Test / Observe and the configuration
// tabs keep their existing bodies in page.tsx (rebuilt in slice 3).
// Real API data only. Where the backend has no endpoint yet (aggregate gate
// status, run replay) the panel shows what IS real and names what's missing.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { AlertTriangle, CheckCircle2, CircleDashed, FlaskConical, XCircle } from "lucide-react";
import { api, type EvalRun, type EvalSuite } from "@/lib/api";
import type { Run } from "@/lib/types";
import { CONFIG, LIFECYCLE, type AgentTab } from "@/lib/lifecycle";
import { ts } from "@/lib/overview";
import { DataTable } from "@/components/data-table";
import { ExplainInline } from "@/components/explain-inline";
import { Skeleton } from "@/components/skeleton";
import { AgentEnvironments } from "../../deployments/agent-environments";

// ── Rail ────────────────────────────────────────────────────────────────────

/**
 * The lifecycle is a sequence, so the rail numbers its steps; the config tabs
 * sit apart, unnumbered. role="tablist" with roving arrow-key focus.
 */
export function LifecycleRail({
  active, onSelect, routes,
}: {
  active: AgentTab;
  onSelect: (t: AgentTab) => void;
  routes: Array<{ label: string; href: string }>;
}) {
  const order = [...LIFECYCLE, ...CONFIG].map((t) => t.key);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = order.indexOf(active);
    const next = order[(i + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    onSelect(next);
    requestAnimationFrame(() => document.getElementById(`agent-tab-${next}`)?.focus());
  };
  const tab = (key: AgentTab, label: string, n?: number, hint?: string) => {
    const on = key === active;
    return (
      <button
        key={key}
        id={`agent-tab-${key}`}
        role="tab"
        type="button"
        aria-selected={on}
        aria-controls="agent-tabpanel"
        tabIndex={on ? 0 : -1}
        onClick={() => onSelect(key)}
        className={clsx(
          "focus-ring group relative flex shrink-0 flex-col items-start rounded-md px-2.5 pb-2 pt-1.5 text-left transition-colors",
          on ? "text-fg" : "text-fg-3 hover:text-fg",
        )}
      >
        <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
          {n !== undefined && (
            <span className={clsx("num flex h-4 w-4 items-center justify-center rounded-full text-[10px]", on ? "bg-accent text-on-accent" : "bg-raised text-fg-3")}>
              {n}
            </span>
          )}
          {label}
        </span>
        {hint && <span className="hidden text-[11.5px] text-fg-3 2xl:block">{hint}</span>}
        {on && <span aria-hidden className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-accent" />}
      </button>
    );
  };
  return (
    <div className="flex items-end gap-1 overflow-x-auto border-b border-line" role="tablist" aria-label="Agent lifecycle" onKeyDown={onKey}>
      {LIFECYCLE.map((t, i) => tab(t.key, t.label, i + 1, t.hint))}
      <span aria-hidden className="mx-2 mb-2.5 h-5 w-px shrink-0 bg-line" />
      {CONFIG.map((t) => tab(t.key, t.label))}
      {routes.map((r) => (
        <Link key={r.href} href={r.href} className="focus-ring shrink-0 rounded-md px-2.5 pb-2 pt-1.5 text-[13.5px] font-medium text-fg-3 hover:text-fg">
          {r.label}
        </Link>
      ))}
    </div>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Missing({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-[12px] border border-dashed border-line-strong bg-panel p-4">
      <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" aria-hidden />
      <div>
        <p className="text-[13.5px] font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-[13px] text-fg-3">{children}</p>
      </div>
    </div>
  );
}

function useEvalData(agentName: string) {
  const [suites, setSuites] = useState<EvalSuite[] | null>(null);
  const [runs, setRuns] = useState<EvalRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    Promise.all([api.listEvalSuites(agentName), api.listEvalRuns({ agentName })])
      .then(([s, r]) => { if (!off) { setSuites(s); setRuns(r); } })
      .catch((e) => { if (!off) setError(e instanceof Error ? e.message : "Couldn’t load evals"); });
    return () => { off = true; };
  }, [agentName]);
  return { suites, runs, error };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

// ── Evals ───────────────────────────────────────────────────────────────────

export function EvalsPanel({ agentName }: { agentName: string }) {
  const router = useRouter();
  const { suites, runs, error } = useEvalData(agentName);
  const latestBySuite = useMemo(() => {
    const m = new Map<string, EvalRun>();
    for (const r of runs ?? []) {
      const cur = m.get(r.suiteId);
      if (!cur || ts(r.createdAt) > ts(cur.createdAt)) m.set(r.suiteId, r);
    }
    return m;
  }, [runs]);

  if (error) return <p role="alert" className="text-[13px] text-bad">{error}</p>;
  return (
    <div className="space-y-6">
      <Section title="Suites" action={<Link href="/eval-suites" className="focus-ring rounded text-[12.5px] font-medium text-accent hover:underline">All suites</Link>}>
        <DataTable<EvalSuite>
          label="Eval suites"
          loading={suites === null}
          rows={suites ?? []}
          rowKey={(s) => s.id}
          pageSize={0}
          onRowClick={() => router.push(`/eval-suites`)}
          emptyIcon={FlaskConical}
          emptyTitle="No eval suites yet"
          emptyDescription="A suite is a set of inputs with what a good answer looks like. Add one so every change is scored before it ships."
          emptyAction={<Link href="/eval-suites" className="focus-ring rounded-md bg-action px-3 py-1.5 text-[13px] font-medium text-on-action hover:bg-action/90">Create a suite</Link>}
          columns={[
            { key: "name", header: "Suite", render: (s) => <span className="font-medium text-fg">{s.name}</span> },
            { key: "cases", header: "Cases", align: "right", render: (s) => <span className="num">{s.cases.length}</span> },
            {
              key: "latest",
              header: "Latest score",
              align: "right",
              render: (s) => {
                const r = latestBySuite.get(s.id);
                return r ? <span className={clsx("num", r.passed ? "text-ok" : "text-bad")}>{pct(r.score)}</span> : <span className="text-fg-3">Not run</span>;
              },
            },
          ]}
        />
      </Section>
      <Section title="Recent eval runs">
        <EvalRunsTable runs={runs} suites={suites} />
      </Section>
    </div>
  );
}

function EvalRunsTable({ runs, suites }: { runs: EvalRun[] | null; suites: EvalSuite[] | null }) {
  const name = (id: string) => suites?.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  return (
    <DataTable<EvalRun>
      label="Eval runs"
      loading={runs === null}
      rows={(runs ?? []).slice(0, 20)}
      rowKey={(r) => r.id}
      pageSize={10}
      defaultSort={{ key: "when", dir: "desc" }}
      emptyTitle="No eval runs yet"
      emptyDescription="Run a suite from the Evals page or with `pal eval run`. Results land here."
      columns={[
        { key: "suite", header: "Suite", render: (r) => <span className="text-fg">{name(r.suiteId)}</span> },
        {
          key: "result",
          header: "Result",
          render: (r) => (
            <span className={clsx("inline-flex items-center gap-1.5", r.passed ? "text-ok" : "text-bad")}>
              {r.passed ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <XCircle className="h-3.5 w-3.5" aria-hidden />}
              {r.passed ? "Passed" : r.regressed ? "Regressed" : "Failed"}
            </span>
          ),
        },
        { key: "score", header: "Score", align: "right", render: (r) => <span className="num">{pct(r.score)} <span className="text-fg-3">({r.casesPassed}/{r.casesTotal})</span></span> },
        { key: "version", header: "Version", hideOnMobile: true, render: (r) => <span className="font-mono text-[12px] text-fg-2">{r.agentVersion || "—"}</span> },
        {
          key: "when",
          header: "When",
          hideOnMobile: true,
          sortable: true,
          sortFn: (a, b) => ts(a.createdAt) - ts(b.createdAt),
          className: "whitespace-nowrap text-fg-3",
          render: (r) => formatDistanceToNowStrict(ts(r.createdAt), { addSuffix: true }),
        },
      ]}
    />
  );
}

// ── Gate ────────────────────────────────────────────────────────────────────

/**
 * What the gate knows today. The per-version aggregate (regression + policy +
 * injection + secret-lint, plan §4 gap #1) has no endpoint yet, so this shows
 * the one real signal — the latest eval result — and lists the rest as
 * missing rather than guessing a green.
 */
export function GatePanel({ agentName }: { agentName: string }) {
  const { runs, error } = useEvalData(agentName);
  const latest = useMemo(() => [...(runs ?? [])].sort((a, b) => ts(b.createdAt) - ts(a.createdAt))[0], [runs]);
  if (error) return <p role="alert" className="text-[13px] text-bad">{error}</p>;
  return (
    <div className="space-y-4">
      <Section title="Ship check">
        <ul className="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-panel">
          <li className="flex items-start gap-3 p-4">
            {runs === null ? (
              <Skeleton className="h-5 w-full" />
            ) : latest ? (
              <>
                {latest.passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-ok" aria-hidden /> : <XCircle className="mt-0.5 h-4 w-4 text-bad" aria-hidden />}
                <div>
                  <p className="text-[13.5px] font-medium text-fg">Evals {latest.passed ? "passed" : latest.regressed ? "regressed" : "failed"}</p>
                  <p className="text-[13px] text-fg-3">
                    Latest run scored {pct(latest.score)} on {latest.agentVersion || "the working copy"}, {formatDistanceToNowStrict(ts(latest.createdAt), { addSuffix: true })}.
                  </p>
                </div>
              </>
            ) : (
              <>
                <AlertTriangle className="mt-0.5 h-4 w-4 text-warn" aria-hidden />
                <div>
                  <p className="text-[13.5px] font-medium text-fg">No eval results</p>
                  <p className="text-[13px] text-fg-3">Nothing has scored this agent yet, so there is no quality signal to gate on.</p>
                </div>
              </>
            )}
          </li>
          {["Policy check", "Prompt-injection scan", "Secret lint"].map((g) => (
            <li key={g} className="flex items-start gap-3 p-4">
              <CircleDashed className="mt-0.5 h-4 w-4 text-fg-3" aria-hidden />
              <div>
                <p className="text-[13.5px] font-medium text-fg-2">{g}</p>
                <p className="text-[13px] text-fg-3">Not reported yet. The control plane doesn’t expose a per-version gate result.</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>
      <p className="text-[12.5px] text-fg-3">Promotion still runs its own server-side gates (version, order, budget, evals). They show on the Promote tab when you promote.</p>
    </div>
  );
}

// ── Promote ─────────────────────────────────────────────────────────────────

export function PromotePanel({ agentName }: { agentName: string }) {
  return <AgentEnvironments fixedAgent={agentName} />;
}

// ── Debug ───────────────────────────────────────────────────────────────────

export function DebugPanel({ runs, loading }: { runs: Run[]; loading: boolean }) {
  const failed = useMemo(() => runs.filter((r) => r.status === "failed").sort((a, b) => ts(b.createdAt) - ts(a.createdAt)), [runs]);
  return (
    <div className="space-y-6">
      <Section title="Failed runs">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : failed.length === 0 ? (
          <div className="rounded-[12px] border border-line bg-panel p-6 text-center">
            <CheckCircle2 className="mx-auto h-5 w-5 text-ok" aria-hidden />
            <p className="mt-2 text-[13.5px] font-medium text-fg">No failed runs</p>
            <p className="text-[13px] text-fg-3">When a run fails it shows up here with a one-click explanation.</p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {failed.slice(0, 10).map((r) => (
              <li key={r.id} className="rounded-[12px] border border-line bg-panel p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/runs/${encodeURIComponent(r.id)}`} className="focus-ring rounded font-mono text-[13px] text-fg hover:underline">
                    {r.id.slice(0, 8)}
                  </Link>
                  <span className="text-[12px] text-fg-3">{formatDistanceToNowStrict(ts(r.createdAt), { addSuffix: true })}</span>
                </div>
                {r.error && (
                  <p className="mt-1 break-words text-[13px] text-fg-2">
                    <span className="text-bad">{r.error.code}</span>{r.error.message ? `: ${r.error.message}` : ""}
                  </p>
                )}
                <ExplainInline request={{ kind: "run", runId: r.id }} label="Explain" size="xs" className="mt-2.5" />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Missing title="Replay a run against a new version">
        Re-running a past failure against a candidate version needs the run-replay endpoint (plan §4 gap #4). Until then, use the Test tab with the failing input.
      </Missing>
    </div>
  );
}
