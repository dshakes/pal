"use client";
// Agent lifecycle (v3): the rail plus the panels that are new in slice 2 —
// Evals, Gate, Promote, Debug. Design / Test / Observe and the configuration
// tabs keep their existing bodies in page.tsx (rebuilt in slice 3).
// Real API data only. Where the backend has no endpoint yet (aggregate gate
// status, run replay) the panel shows what IS real and names what's missing.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { api } from "@/lib/api";
import type { Run } from "@/lib/types";
import { CONFIG, LIFECYCLE, type AgentTab } from "@/lib/lifecycle";
import { ts } from "@/lib/overview";
import { apiErrorText, budgetPct, budgetTone, incidentTone, type Incident } from "@/lib/observability";
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
  // On narrow screens the rail scrolls sideways; keep the active tab in view
  // (horizontal only, so the page itself never jumps).
  useEffect(() => {
    const el = document.getElementById(`agent-tab-${active}`);
    const box = el?.closest(".overflow-x-auto");
    if (!el || !box) return;
    const d = el.getBoundingClientRect().left - box.getBoundingClientRect().left;
    if (d < 0 || d + el.offsetWidth > box.clientWidth) box.scrollLeft += d - 16;
  }, [active]);
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
    <div className="flex items-end gap-1 overflow-x-auto border-b border-line">
      <div className="flex shrink-0 items-end gap-1" role="tablist" aria-label="Agent lifecycle" onKeyDown={onKey}>
        {LIFECYCLE.map((t, i) => tab(t.key, t.label, i + 1, t.hint))}
        <span aria-hidden className="mx-2 mb-2.5 h-5 w-px shrink-0 bg-line" />
        {CONFIG.map((t) => tab(t.key, t.label))}
      </div>
      <nav aria-label="Agent pages" className="flex shrink-0 items-end gap-1">
        {routes.map((r) => (
          <Link key={r.href} href={r.href} className="focus-ring shrink-0 rounded-md px-2.5 pb-2 pt-1.5 text-[13.5px] font-medium text-fg-3 hover:text-fg">
            {r.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────

export function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
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

export function Missing({ title, children }: { title: string; children: React.ReactNode }) {
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

// Evals + Gate live in ./evals-panel; re-exported so the page keeps one import.
export { EvalsPanel, GatePanel } from "./evals-panel";

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
        Re-running a past failure against a candidate version isn’t available yet. Until it is, use the Test tab with the failing input.
      </Missing>
    </div>
  );
}

// ── Observe: reliability strip (ADR 0056 / #408) ────────────────────────────

const TONE_TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad", muted: "text-fg-3" } as const;

/** SLO error budgets + open incidents for one agent; full detail lives on the
 * agent's Reliability page and /incidents. */
export function ReliabilityStrip({ agentName }: { agentName: string }) {
  const [slo, setSlo] = useState<Awaited<ReturnType<typeof api.getSloStatus>> | null>(null);
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([api.getSloStatus(agentName), api.listIncidents({ agent: agentName })])
      .then(([s, i]) => { if (live) { setSlo(s); setIncidents(i.filter((x) => x.status !== "resolved")); } })
      .catch((e) => live && setError(apiErrorText(e, "Couldn’t load reliability")));
    return () => { live = false; };
  }, [agentName]);
  const base = `/agents/${encodeURIComponent(agentName)}`;
  return (
    <Section title="Reliability" action={<Link href={`${base}/reliability`} className="text-[12.5px] text-accent hover:underline">SLOs &amp; prod evals</Link>}>
      {error ? (
        <p className="rounded-lg border border-line bg-panel p-4 text-[13px] text-bad">{error}</p>
      ) : !slo || !incidents ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="min-w-0 rounded-lg border border-line bg-panel p-4">
            <p className="text-[12.5px] text-fg-3">Error budget</p>
            {!slo.configured || !slo.slis?.length ? (
              <p className="mt-1 text-[13px] text-fg-2">No SLO set. <Link href={`${base}/reliability`} className="text-accent hover:underline">Set targets</Link></p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {slo.slis.map((s) => (
                  <li key={s.name} className="flex min-w-0 items-baseline justify-between gap-3 text-[13px]">
                    <span className="min-w-0 truncate text-fg-2">{s.name} <span className="text-fg-3">· {s.target}</span></span>
                    <span className={clsx("num shrink-0 font-medium", TONE_TEXT[budgetTone(s.budgetRemaining)])}>{s.budgetRemaining < 0 ? "Budget exhausted" : `${budgetPct(s.budgetRemaining)}% left`}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0 rounded-lg border border-line bg-panel p-4">
            <p className="text-[12.5px] text-fg-3">Open incidents</p>
            {incidents.length === 0 ? (
              <p className="mt-1 text-[13px] text-fg-2">None open.</p>
            ) : (
              <ul className="mt-1.5 space-y-1">
                {incidents.slice(0, 3).map((i) => (
                  <li key={i.id} className="flex min-w-0 items-baseline justify-between gap-3 text-[13px]">
                    <Link href={`/incidents/${encodeURIComponent(i.id)}`} className={clsx("min-w-0 truncate hover:underline", TONE_TEXT[incidentTone(i)])}>{i.title}</Link>
                    <span className="shrink-0 text-fg-3">{formatDistanceToNowStrict(new Date(i.openedAt))} ago</span>
                  </li>
                ))}
                {incidents.length > 3 && (
                  <li><Link href="/incidents" className="text-[12.5px] text-accent hover:underline">All {incidents.length}</Link></li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
