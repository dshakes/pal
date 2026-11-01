"use client";

// RunTrace — the per-run trace tree (ADR 0056): an interactive waterfall plus a
// nested tree of steps, LLM calls (model / tokens / cost / latency), tool calls
// (args + result, already redacted by the server), retries and child runs.
// Data: GET /v1/runs/{id}/trace. Secrets never reach the browser: redaction is
// server-side (invariant #10).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ChevronRight, GitBranch, RotateCw, Wrench, Sparkles } from "lucide-react";
import { api, type RunTrace as Trace } from "@/lib/api";
import {
  apiErrorText,
  fmtMs,
  fmtUsd,
  stepTone,
  waterfallRows,
  type Tone,
  type TraceNode,
} from "@/lib/observability";

const BAR: Record<Tone, string> = {
  ok: "bg-ok/70",
  bad: "bg-bad/80",
  warn: "bg-warn/70",
  muted: "bg-fg-3/60",
};
const DOT: Record<Tone, string> = {
  ok: "bg-ok",
  bad: "bg-bad",
  warn: "bg-warn",
  muted: "bg-fg-3",
};

function KindIcon({ node }: { node: TraceNode }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-fg-3";
  if (node.llm) return <Sparkles className={cls} aria-label="LLM call" />;
  if (node.tool || node.type === "tool" || node.type === "connector") return <Wrench className={cls} aria-label="Tool call" />;
  if (node.childRun) return <GitBranch className={cls} aria-label="Child run" />;
  return <span className="h-3.5 w-3.5 shrink-0" />;
}

function StepDetail({ node }: { node: TraceNode }) {
  const row = "grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-xs";
  return (
    <div className="space-y-3 rounded-lg bg-raised p-3 text-xs" data-testid="step-detail">
      <div className={row}>
        <span className="text-fg-3">Step</span>
        <span className="font-mono text-fg-2">{node.id}</span>
        <span className="text-fg-3">Type</span>
        <span className="text-fg-2">{node.type}</span>
        <span className="text-fg-3">Duration</span>
        <span className="text-fg-2">{fmtMs(node.durationMs)}</span>
      </div>
      {node.llm && (
        <div className={row}>
          <span className="text-fg-3">Model</span>
          <span className="font-mono text-fg-2">
            {[node.llm.provider, node.llm.model].filter(Boolean).join(" / ") || "unknown"}
          </span>
          <span className="text-fg-3">Tokens</span>
          <span className="text-fg-2">
            {node.llm.tokensIn.toLocaleString()} in / {node.llm.tokensOut.toLocaleString()} out
          </span>
          <span className="text-fg-3">Cost</span>
          <span className="text-fg-2">{fmtUsd(node.llm.costUsd)}</span>
          <span className="text-fg-3">Latency</span>
          <span className="text-fg-2">{fmtMs(node.llm.latencyMs)}</span>
        </div>
      )}
      {node.tool && (
        <div>
          <p className="mb-1 text-fg-3">
            Tool <span className="font-mono text-fg-2">{node.tool.name}</span> arguments (secrets redacted)
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-canvas p-2 font-mono text-[11px] text-fg-2">
            {JSON.stringify(node.tool.args ?? {}, null, 2)}
          </pre>
        </div>
      )}
      {node.retries && node.retries.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1 text-warn">
            <RotateCw className="h-3 w-3" /> {node.retries.length} retr{node.retries.length === 1 ? "y" : "ies"}
          </p>
          <ul className="space-y-0.5 font-mono text-[11px] text-fg-3">
            {node.retries.map((r) => (
              <li key={r.attempt}>
                attempt {r.attempt}: {r.error || "retried"}
              </li>
            ))}
          </ul>
        </div>
      )}
      {node.policyDenied && (
        <p role="note" className="rounded bg-warn-soft p-2 text-[11px] text-warn break-words">
          Denied by agent policy: {node.policyDenied.kind} <span className="font-mono">{node.policyDenied.target}</span>
          {node.policyDenied.reason ? ` (${node.policyDenied.reason})` : ""}
        </p>
      )}
      {node.error && (
        <p className="rounded bg-bad-soft p-2 font-mono text-[11px] text-bad break-words">{node.error}</p>
      )}
      {node.output && (
        <div>
          <p className="mb-1 text-fg-3">Result</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-canvas p-2 font-mono text-[11px] text-fg-2">
            {node.output}
          </pre>
        </div>
      )}
      {node.childRun && (
        <Link href={`/runs/${encodeURIComponent(node.childRun.runId)}`} className="inline-block text-accent hover:underline">
          Open child run {node.childRun.runId.slice(0, 8)}…
        </Link>
      )}
    </div>
  );
}

function Waterfall({ trace }: { trace: Trace }) {
  const rows = useMemo(() => waterfallRows(trace), [trace]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div role="list" aria-label="Trace waterfall" className="space-y-1">
      {rows.map((r) => {
        const tone = stepTone(r.node.status);
        const isOpen = open === r.key;
        return (
          <div key={r.key} role="listitem">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : r.key)}
              className="focus-ring grid w-full grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 rounded px-1 py-1 text-left hover:bg-hover sm:grid-cols-[minmax(0,13rem)_1fr_auto]"
            >
              <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${r.depth * 12}px` }}>
                <KindIcon node={r.node} />
                <span className="truncate text-xs text-fg-2" title={r.node.name}>
                  {r.node.name}
                </span>
              </span>
              <span className="relative h-3 rounded bg-raised">
                <span
                  className={clsx("absolute top-0 h-3 rounded", BAR[tone])}
                  style={{ left: `${r.leftPct}%`, width: `${r.widthPct}%` }}
                />
              </span>
              <span className="w-14 text-right font-mono text-[11px] text-fg-3">{fmtMs(r.node.durationMs)}</span>
            </button>
            {isOpen && (
              <div className="mb-1 ml-1 mt-1">
                <StepDetail node={r.node} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TreeNode({ node, depth }: { node: TraceNode; depth: number }) {
  const [open, setOpen] = useState(false);
  const tone = stepTone(node.status);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-hover"
      >
        <ChevronRight className={clsx("h-3 w-3 shrink-0 text-fg-3 transition-transform", open && "rotate-90")} />
        <span className={clsx("h-2 w-2 shrink-0 rounded-full", DOT[tone])} aria-label={node.status} />
        <KindIcon node={node} />
        <span className="truncate text-xs text-fg">{node.name}</span>
        {node.llm && <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-3">{fmtUsd(node.llm.costUsd)}</span>}
        <span className={clsx("shrink-0 font-mono text-[11px] text-fg-3", !node.llm && "ml-auto")}>{fmtMs(node.durationMs)}</span>
      </button>
      {open && (
        <div className="ml-5 mt-1 mb-1">
          <StepDetail node={node} />
        </div>
      )}
      {node.childRun && (
        <ul className="ml-5 border-l border-line pl-2">
          <li className="py-0.5 text-[11px] text-fg-3">child run {node.childRun.runId.slice(0, 8)} · {node.childRun.status}</li>
          {node.childRun.steps.map((s) => (
            <TreeNode key={s.id} node={s} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function RunTrace({ runId, refreshKey }: { runId: string; refreshKey?: string }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"waterfall" | "tree">("waterfall");

  useEffect(() => {
    let live = true;
    api
      .getRunTrace(runId)
      .then((t) => live && (setTrace(t), setErr(null)))
      .catch((e) => live && setErr(apiErrorText(e, "Failed to load trace")));
    return () => {
      live = false;
    };
  }, [runId, refreshKey]);

  if (err) {
    return (
      <p className="rounded-[10px] border border-line p-3 text-[12.5px] text-fg-3" role="status">
        Trace unavailable: {err}
      </p>
    );
  }
  if (!trace) {
    return <div className="h-24 animate-pulse rounded-[10px] bg-raised" aria-label="Loading trace" />;
  }
  if (trace.steps.length === 0) {
    return (
      <p className="rounded-[10px] border border-line p-3 text-[12.5px] text-fg-3" role="status">
        No steps were recorded for this run, so there is nothing to trace yet.
      </p>
    );
  }
  const stat = (label: string, value: string) => (
    <div className="min-w-[4.5rem]">
      <div className="text-[10px] uppercase tracking-wide text-fg-3">{label}</div>
      <div className="font-mono text-xs text-fg">{value}</div>
    </div>
  );
  return (
    <section aria-label="Run trace" className="rounded-[12px] border border-line bg-panel p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4">
          {stat("Steps", String(trace.totals.steps))}
          {stat("LLM calls", String(trace.totals.llmCalls))}
          {stat("Tool calls", String(trace.totals.toolCalls))}
          {stat("Retries", String(trace.totals.retries))}
          {stat("Duration", fmtMs(trace.durationMs))}
          {stat("Cost", fmtUsd(trace.costUsd))}
        </div>
        <div className="flex rounded-md bg-raised p-0.5 text-xs" role="group" aria-label="Trace view">
          {(["waterfall", "tree"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={clsx(
                "focus-ring rounded px-2.5 py-1 font-medium capitalize transition-colors",
                view === v ? "bg-canvas text-fg" : "text-fg-3 hover:text-fg-2",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      {view === "waterfall" ? (
        <Waterfall trace={trace} />
      ) : (
        <ul className="space-y-0.5" aria-label="Trace tree">
          {trace.steps.map((s) => (
            <TreeNode key={s.id} node={s} depth={0} />
          ))}
          {(trace.childRuns ?? []).map((c) => (
            <li key={c.runId} className="ml-5 border-l border-line pl-2">
              <p className="py-0.5 text-[11px] text-fg-3">
                child run <Link href={`/runs/${encodeURIComponent(c.runId)}`} className="font-mono text-accent hover:underline">{c.runId.slice(0, 8)}</Link> · {c.status}
              </p>
              <ul>
                {c.steps.map((s) => (
                  <TreeNode key={s.id} node={s} depth={1} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
