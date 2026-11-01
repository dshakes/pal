"use client";

// Debug tab (ADR 0059). The debug agent reads the evidence the server collects
// (run trace, journal, the failing version's frozen snapshot vs the last good
// one, promotion audit, failed eval cases, budget, open incidents) and returns a
// root cause that cites it plus fix PROPOSALS. Nothing applies until a person
// confirms (components/debug-panel.tsx owns that gate); this tab only chooses
// what to point it at.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { CheckCircle2, CircleDashed, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { Run } from "@/lib/types";
import { ts } from "@/lib/overview";
import { apiErrorText, incidentTone, kindLabel, type Incident } from "@/lib/observability";
import { DebugThis } from "@/components/debug-panel";
import { ExplainInline } from "@/components/explain-inline";
import { useCanDebug } from "@/components/role-gate";
import { Skeleton } from "@/components/skeleton";
import { TonePill } from "@/components/tone-pill";

const SHOW = 10;

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
          {hint && <p className="text-[12.5px] text-fg-3">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function DebugPanel({ agentName }: { agentName: string }) {
  const canDebug = useCanDebug();
  const [failed, setFailed] = useState<Run[] | null>(null);
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, i] = await Promise.all([api.listRuns({ agentName, status: "failed" }), api.listIncidents({ agent: agentName, status: "active" })]);
      setFailed(r.filter((x) => x.status === "failed").sort((a, b) => ts(b.createdAt) - ts(a.createdAt)));
      setIncidents(i);
    } catch (e) {
      setError(apiErrorText(e, "Couldn’t load failures"));
    }
  }, [agentName]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      {!canDebug && (
        <p role="note" className="rounded-[12px] border border-line bg-panel p-3 text-[13px] text-fg-3">
          Your role can see failures here but can’t run the debug agent (it calls a model, which spends the workspace’s money).
        </p>
      )}

      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[12px] border border-bad/40 bg-bad-soft p-4 text-[13px] text-bad">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="focus-ring rounded border border-bad/40 px-2 py-0.5 text-[12.5px] hover:bg-bad/10">Retry</button>
        </div>
      ) : !failed || !incidents ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <>
          <Section title="Open incidents" hint="Anomalies and SLO burn the server detected on this agent.">
            {incidents.length === 0 ? (
              <p className="text-[13px] text-fg-3">None open.</p>
            ) : (
              <ul className="space-y-2.5">
                {incidents.map((i) => (
                  <li key={i.id} className="rounded-[12px] border border-line bg-panel p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <TonePill tone={incidentTone(i)}>{i.severity}</TonePill>
                      <Link href={`/incidents/${encodeURIComponent(i.id)}`} className="focus-ring rounded text-[13.5px] font-medium text-fg hover:underline">{i.title}</Link>
                      <span className="text-[12px] text-fg-3">{kindLabel(i.kind)}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[13px] text-fg-2">{i.summary}</p>
                    <div className="mt-2.5 flex flex-wrap items-start gap-2">
                      <DebugThis size="xs" label="Debug this incident" target={{ kind: "incident", incidentId: i.id }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Failed runs"
            hint={failed.length > SHOW ? `The ${SHOW} newest of ${failed.length} failed runs.` : undefined}
            action={
              <button type="button" onClick={() => void load()} className="focus-ring inline-flex items-center gap-1 rounded text-[12.5px] text-fg-3 hover:text-fg">
                <RefreshCw className="h-3 w-3" aria-hidden /> Refresh
              </button>
            }
          >
            {failed.length === 0 ? (
              <div className="rounded-[12px] border border-line bg-panel p-6 text-center">
                <CheckCircle2 className="mx-auto h-5 w-5 text-ok" aria-hidden />
                <p className="mt-2 text-[13.5px] font-medium text-fg">No failed runs</p>
                <p className="text-[13px] text-fg-3">When a run fails it shows up here, ready to debug.</p>
              </div>
            ) : (
              <ul className="space-y-2.5">
                {failed.slice(0, SHOW).map((r) => (
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
                    <div className="mt-2.5 flex flex-wrap items-start gap-2">
                      <ExplainInline request={{ kind: "run", runId: r.id }} label="Explain" size="xs" />
                      <DebugThis size="xs" label="Debug this run" target={{ kind: "run", runId: r.id }} />
                      <Link href={`/runs/${encodeURIComponent(r.id)}`} className="focus-ring inline-flex h-6 items-center rounded-md px-2 text-[11px] text-fg-3 hover:text-fg">
                        Open trace
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      <Section title="Replay and fix">
        <div className="flex gap-3 rounded-[12px] border border-dashed border-line-strong bg-panel p-4">
          <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" aria-hidden />
          <div className="space-y-1.5 text-[13px] text-fg-3">
            <p className="text-[13.5px] font-medium text-fg">How replay works today</p>
            <p>
              When the debug agent proposes a regression case, confirming it creates a suite that captures the failure. “Replay
              against the working copy” then runs it hermetically with the tool results the failing run recorded.
            </p>
            <p>
              Fixes (rollback, prompt, model, budget, retry) are proposals; each stops at a confirm card showing the exact request.
              Re-running a past failure against a candidate <em>version</em> isn’t a server action yet: <code className="font-mono">POST /v1/runs/rehearse</code> only returns the cases, and <code className="font-mono">pal test --rehearse</code> executes them.
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}
