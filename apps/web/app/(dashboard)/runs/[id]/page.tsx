"use client";

// /runs/[id] — one run, read top-down: what happened (status, timing, cost),
// how it happened (the step trace, streamed live over SSE while the run is in
// flight), and what came out (output, or the error with a grounded "Why?").
// Real API data only: GET /v1/runs/{id} + GET /v1/runs/{id}/events (SSE).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RunTrace } from "@/components/run-trace";
import { useParams, useRouter } from "next/navigation";
import clsx from "clsx";
import { format } from "date-fns";
import { Check, Copy, GitCompare, Loader2, Radio, X, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { useRun, useRunEvents } from "@/lib/hooks";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";
import { useToast } from "@/components/toast";
import { Button } from "@/components/button";
import { ConfirmModal } from "@/components/modal";
import { StatusBadge, statusLabel } from "@/components/status-badge";
import { JsonViewer } from "@/components/json-viewer";
import { RunDetailSkeleton } from "@/components/skeleton";
import { FeedbackWidget } from "@/components/feedback-widget";
import { ReceiptCard } from "@/components/receipt-card";
import { FlightRecorder } from "@/components/flight-recorder";
import { ViewCode, snippetsForCreateRun, snippetsForGetRun } from "@/components/view-code";
import type { StreamState } from "@/lib/sse";
import { TakeoverPanel } from "@/components/takeover-panel";
import { ExplainInline } from "@/components/explain-inline";
import { RoleGate } from "@/components/role-gate";
import { useAgentSurface } from "@/components/agent-surface";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function outputText(o: unknown): string {
  if (typeof o === "string") return o;
  if (o && typeof o === "object" && "result" in (o as Record<string, unknown>)) return String((o as Record<string, unknown>).result);
  return JSON.stringify(o, null, 2);
}

// The live-stream pill. "ended" means the server closed the stream because the
// run finished; the status poll catches up within seconds, so no pill.
const STREAM_PILL: Record<StreamState, { label: string; cls: string } | null> = {
  connecting: { label: "Connecting…", cls: "bg-raised text-fg-3" },
  live: { label: "Live", cls: "bg-accent-soft text-accent" },
  reconnecting: { label: "Reconnecting…", cls: "bg-warn-soft text-warn" },
  disconnected: { label: "Disconnected", cls: "bg-bad-soft text-bad" },
  ended: null,
};

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const id = params.id as string;

  const { run, loading, error, refresh } = useRun(id);
  const { events, state: streamState } = useRunEvents(id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [recorderMode, setRecorderMode] = useState(false);
  const [compareInput, setCompareInput] = useState("");
  const [compareId, setCompareId] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [copied, setCopied] = useState(false);

  // The SSE stream carries steps; the run row carries status and cost. Re-read
  // the row every 4s while in flight (a run waiting on a human emits nothing
  // until it resumes).
  const terminal = run ? TERMINAL.has(run.status) : false;
  const runId = run?.id;
  useEffect(() => {
    if (terminal || !runId) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [terminal, runId, refresh]);

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    try {
      await api.cancelRun(id, "Cancelled from dashboard");
      toast.success("Run cancelled");
      setConfirmCancel(false);
      void refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t cancel the run");
    } finally {
      setCancelling(false);
    }
  }, [id, toast, refresh]);

  useAgentSurface({
    page: "Run detail",
    facts: run
      ? [
          `run ${run.id} of agent ${run.agentName}`,
          `status ${statusLabel(run.status)}`,
          `cost ${formatCost(run.costUsd)}, ${run.tokensIn + run.tokensOut} tokens`,
          ...(run.error ? [`error ${run.error.code}: ${run.error.message}`] : []),
        ]
      : [`run ${id} (loading)`],
    suggestions: run?.status === "failed" ? ["Why did my last run fail?"] : ["Open runs"],
    explain: run?.status === "failed" ? [{ id: run.id, label: `Why run ${run.id.slice(0, 8)} failed`, sub: run.error?.message, request: { kind: "run" as const, runId: run.id } }] : [],
  });

  // Background polls refetch the run; once it has loaded, keep showing it
  // through a failed poll or a refetch (the stream pill says when the API is
  // unreachable) instead of flashing a skeleton or "not found".
  if (!run && loading) return <RunDetailSkeleton />;

  if (!run) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center" role="alert">
        <XCircle className="h-5 w-5 text-bad" aria-hidden />
        {error && !/\b404\b/.test(error.message) ? (
          <>
            <p className="text-[15px] font-semibold text-fg">Couldn’t load this run</p>
            <p className="max-w-sm text-[13px] text-fg-3">The API didn’t answer. Check that it’s running, then reload.</p>
          </>
        ) : (
          <>
            <p className="text-[15px] font-semibold text-fg">Run not found</p>
            <p className="max-w-sm text-[13px] text-fg-3">
              <span className="font-mono">{id}</span> doesn’t exist in this workspace, or it was deleted.
            </p>
          </>
        )}
        <Button variant="secondary" size="sm" className="mt-2" onClick={() => router.push("/runs")}>Back to runs</Button>
      </div>
    );
  }

  const isLive = !terminal;
  const startedAt = run.startedAt ? new Date(run.startedAt) : null;
  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;
  const total = startedAt ? (finishedAt ?? new Date()).getTime() - startedAt.getTime() : null;

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(run.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the id is selectable text anyway */
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="shrink-0 px-4 pt-6 md:px-8">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em] text-fg">
                Run of{" "}
                <Link href={`/agents/${encodeURIComponent(run.agentName)}`} className="focus-ring rounded font-mono hover:underline">
                  {run.agentName}
                </Link>
              </h1>
              <StatusBadge status={run.status} />
              <span aria-live="polite" className="contents">
                {isLive && STREAM_PILL[streamState] && (
                  <span
                    title={streamState === "disconnected" ? "Live updates stopped. Status still refreshes every few seconds; reload to reconnect." : undefined}
                    className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium", STREAM_PILL[streamState]!.cls)}
                  >
                    <Radio className="h-3 w-3" aria-hidden /> {STREAM_PILL[streamState]!.label}
                  </span>
                )}
              </span>
            </div>
            <p className="mt-1 flex items-center gap-1.5 text-[13px] text-fg-3">
              <span className="font-mono">{run.id}</span>
              <button type="button" onClick={() => void copyId()} aria-label="Copy run id" className="focus-ring rounded p-0.5 hover:text-fg">
                {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ViewCode title="Get this run from code" snippets={snippetsForGetRun(run.id)} />
            <ViewCode title={`Create a run for ${run.agentName}`} snippets={snippetsForCreateRun(run.agentName)} />
            {comparing ? (
              <form
                onSubmit={(e) => { e.preventDefault(); const v = compareInput.trim(); if (v) setCompareId(v); }}
                className="flex items-center gap-1"
              >
                <label htmlFor="compare-run" className="sr-only">Run id to compare</label>
                <input
                  id="compare-run"
                  autoFocus
                  value={compareInput}
                  onChange={(e) => setCompareInput(e.target.value)}
                  placeholder="Run id to compare"
                  className="h-8 w-48 rounded-md border border-line bg-panel px-2.5 font-mono text-[12px] text-fg placeholder:text-fg-3"
                />
                <Button type="submit" size="sm" variant="secondary">Load</Button>
                <button type="button" aria-label="Cancel compare" onClick={() => { setComparing(false); setCompareId(null); setCompareInput(""); }} className="focus-ring rounded-md p-1.5 text-fg-3 hover:bg-hover hover:text-fg">
                  <X className="h-3.5 w-3.5" />
                </button>
              </form>
            ) : (
              <Button variant="secondary" size="md" icon={<GitCompare className="h-3.5 w-3.5" />} onClick={() => setComparing(true)}>Compare</Button>
            )}
            {isLive && (
              <RoleGate cap="runs:execute">
                <Button variant="danger" size="md" icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => setConfirmCancel(true)}>Cancel run</Button>
              </RoleGate>
            )}
          </div>
        </div>

        {/* Instrument strip */}
        <dl className="mt-4 grid grid-cols-2 overflow-hidden rounded-[12px] border border-line bg-panel sm:grid-cols-4">
          <Stat label="Duration" value={total === null ? "—" : formatDuration(total)} note={isLive ? "still running" : finishedAt ? `finished ${format(finishedAt, "HH:mm:ss")}` : "not started"} className="border-b border-r border-line sm:border-b-0" />
          <Stat label="Cost" value={formatCost(run.costUsd)} note="model spend" className="border-b border-line sm:border-b-0 sm:border-r" />
          <Stat label="Tokens" value={formatTokens(run.tokensIn + run.tokensOut)} note={`${formatTokens(run.tokensIn)} in, ${formatTokens(run.tokensOut)} out`} className="border-r border-line" />
          <Stat label="Started" value={startedAt ? format(startedAt, "HH:mm:ss") : "—"} note={format(new Date(run.createdAt), "MMM d")} />
        </dl>
      </div>

      <div className="grid flex-1 gap-5 px-4 py-6 md:px-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {/* Trace */}
          <section aria-labelledby="trace-h" className="rounded-[12px] border border-line bg-panel">
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
              <h2 id="trace-h" className="text-[14px] font-semibold text-fg">
                Trace <span className="num font-normal text-fg-3">{events.length ? `${events.length} events` : ""}</span>
              </h2>
              {events.length > 0 && (
                <button
                  type="button"
                  onClick={() => setRecorderMode((m) => !m)}
                  aria-pressed={recorderMode}
                  className={clsx("focus-ring rounded-md px-2 py-1 text-[12.5px] font-medium", recorderMode ? "bg-accent-soft text-accent" : "text-fg-3 hover:bg-hover hover:text-fg")}
                >
                  Step through
                </button>
              )}
            </div>
            <div className="p-4">
              {events.length === 0 ? (
                isLive ? (
                  <p className="flex items-center gap-2 py-6 text-[13px] text-fg-3"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Waiting for the first step…</p>
                ) : (
                  <p className="py-6 text-center text-[13px] text-fg-3">No steps were recorded for this run.</p>
                )
              ) : (
                <FlightRecorder
                  events={events}
                  running={isLive}
                  recorderMode={recorderMode}
                  status={run.status}
                  totals={{ costUsd: run.costUsd, tokensIn: run.tokensIn, tokensOut: run.tokensOut }}
                />
              )}
              {/* Structured span tree (#408): model/tool detail, policy denials, child runs. */}
              <div className="max-h-[55vh] overflow-auto border-t border-line p-4">
                <RunTrace runId={run.id} refreshKey={run.status} />
              </div>
              {compareId && <CompareTrace runId={compareId} onClose={() => { setCompareId(null); setComparing(false); setCompareInput(""); }} />}
            </div>
          </section>

          {/* Output / error */}
          <section aria-labelledby="out-h" className="rounded-[12px] border border-line bg-panel">
            <h2 id="out-h" className="border-b border-line px-4 py-2.5 text-[14px] font-semibold text-fg">{run.status === "failed" ? "Error" : "Output"}</h2>
            <div className="p-4">
              {run.status === "failed" && run.error ? (
                <div>
                  <p className="text-[13.5px] font-medium text-bad">{run.error.code}</p>
                  <p className="mt-1 break-words text-[13px] text-fg-2">{run.error.message}</p>
                  {run.error.stepId && <p className="mt-2 font-mono text-[12px] text-fg-3">Failed at step {run.error.stepId}</p>}
                  <ExplainInline request={{ kind: "run", runId: run.id }} label="Why did this fail?" className="mt-3" />
                </div>
              ) : run.output !== undefined && run.output !== null ? (
                <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-raised p-3 font-mono text-[13px] leading-relaxed text-fg">{outputText(run.output)}</pre>
              ) : isLive ? (
                <p className="flex items-center gap-2 text-[13px] text-fg-3"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> The output appears when the run finishes.</p>
              ) : (
                <p className="text-[13px] text-fg-3">This run produced no output.</p>
              )}
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-5">
          <section aria-labelledby="details-h" className="rounded-[12px] border border-line bg-panel p-4">
            <h2 id="details-h" className="text-[14px] font-semibold text-fg">Details</h2>
            <dl className="mt-3 space-y-2 text-[13px]">
              <Row label="Agent"><Link href={`/agents/${encodeURIComponent(run.agentName)}`} className="focus-ring rounded font-mono text-accent hover:underline">{run.agentName}</Link></Row>
              {run.labels?.trigger && <Row label="Trigger">{run.labels.trigger}</Row>}
              {run.sessionId && <Row label="Session"><Link href={`/runs?session=${encodeURIComponent(run.sessionId)}`} className="focus-ring rounded font-mono text-accent hover:underline">{run.sessionId.slice(0, 8)}</Link></Row>}
              {run.parentRunId && <Row label="Parent run"><Link href={`/runs/${encodeURIComponent(run.parentRunId)}`} className="focus-ring rounded font-mono text-accent hover:underline">{run.parentRunId.slice(0, 8)}</Link></Row>}
              <Row label="Created">{format(new Date(run.createdAt), "MMM d, HH:mm:ss")}</Row>
              {startedAt && <Row label="Started">{format(startedAt, "MMM d, HH:mm:ss")}</Row>}
              {finishedAt && <Row label="Finished">{format(finishedAt, "MMM d, HH:mm:ss")}</Row>}
            </dl>
          </section>

          <TakeoverPanel runId={run.id} />

          {(run.status === "succeeded" || run.status === "failed") && (
            <>
              <section aria-label="Feedback" className="rounded-[12px] border border-line bg-panel p-4">
                <h2 className="mb-3 text-[14px] font-semibold text-fg">Feedback</h2>
                <FeedbackWidget runId={run.id} />
              </section>
              <section aria-label="Verification" className="rounded-[12px] border border-line bg-panel p-4">
                <h2 className="mb-3 text-[14px] font-semibold text-fg">Verification</h2>
                <ReceiptCard runId={run.id} />
              </section>
            </>
          )}

          <section aria-label="Data" className="space-y-2 rounded-[12px] border border-line bg-panel p-4">
            <h2 className="text-[14px] font-semibold text-fg">Data</h2>
            <JsonViewer data={run.input} label="Input" defaultOpen />
            {run.output !== undefined && run.output !== null && <JsonViewer data={run.output} label="Output (raw)" />}
          </section>
        </aside>
      </div>

      <ConfirmModal
        open={confirmCancel}
        title="Cancel this run?"
        description="It stops at the next step boundary. Steps already completed keep their effects."
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        tone="danger"
        confirming={cancelling}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => void handleCancel()}
      />
    </div>
  );
}

function Stat({ label, value, note, className }: { label: string; value: string; note: string; className?: string }) {
  return (
    <div className={clsx("px-4 py-3", className)}>
      <dt className="text-[12.5px] text-fg-3">{label}</dt>
      <dd className="num mt-0.5 font-display text-[22px] font-semibold leading-tight tracking-[-0.02em] text-fg">{value}</dd>
      <dd className="mt-0.5 truncate text-[12px] text-fg-3">{note}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-fg-3">{label}</dt>
      <dd className="min-w-0 truncate text-right text-fg-2">{children}</dd>
    </div>
  );
}

// A second run's trace stacked under this one for regression diffing. Mounted
// only while comparing, so its SSE stream opens lazily and closes with it.
function CompareTrace({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { run, loading, error } = useRun(runId);
  const { events } = useRunEvents(runId);
  return (
    <div className="mt-4 rounded-[10px] border border-line">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <p className="flex items-center gap-2 text-[13px] text-fg-2">
          <GitCompare className="h-3.5 w-3.5 text-fg-3" aria-hidden /> Compare <span className="font-mono text-[12px] text-fg-3">{runId.slice(0, 8)}</span>
          {run && <StatusBadge status={run.status} />}
        </p>
        <button type="button" onClick={onClose} aria-label="Close compare" className="focus-ring rounded-md p-1 text-fg-3 hover:bg-hover hover:text-fg">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="p-3">
        {loading ? (
          <p className="flex items-center gap-2 py-6 text-[13px] text-fg-3"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading {runId.slice(0, 8)}…</p>
        ) : error || !run ? (
          <p className="py-6 text-center text-[13px] text-fg-3">Run <span className="font-mono">{runId}</span> not found.</p>
        ) : events.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-fg-3">No steps were recorded for that run.</p>
        ) : (
          <FlightRecorder events={events} running={!TERMINAL.has(run.status)} totals={{ costUsd: run.costUsd, tokensIn: run.tokensIn, tokensOut: run.tokensOut }} />
        )}
      </div>
    </div>
  );
}

