"use client";

// "Debug this" — the debug agent (ADR 0059) inline on a failed run, an
// incident or a failing eval case. One click: the server reads the evidence,
// returns a root cause that cites it, and fix PROPOSALS. Each proposal stops
// at a ConfirmCard showing the diff and the exact request; only the person's
// confirm sends it (api.applyDebugProposal re-checks the allowlist and that
// nothing changed since the analysis).

import { useState } from "react";
import Link from "next/link";
import { Bug, Check, ChevronDown, ExternalLink, Loader2, ShieldAlert, X } from "lucide-react";
import clsx from "clsx";
import { api, AssistError } from "@/lib/api";
import {
  KIND_LABEL,
  actionAllowed,
  confirmLabel,
  shortRef,
  splitRefs,
  type DebugEvidence,
  type DebugProposal,
  type DebugReport,
  type DebugTarget,
} from "@/lib/debug";
import { ConfirmCard } from "@/components/confirm-card";
import { useCan } from "@/components/role-gate";

export function DebugThis({
  target,
  label = "Debug this",
  size = "sm",
  className,
}: {
  target: DebugTarget;
  label?: string;
  size?: "sm" | "xs";
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [report, setReport] = useState<DebugReport | null>(null);
  const [err, setErr] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  // Analyzing calls the model (spends money), so read-only roles don't get it.
  const canRun = useCan("runs:execute");
  if (!canRun) return null;

  const run = async () => {
    setState("loading");
    setNeedsKey(false);
    try {
      setReport(await api.debugAnalyze(target));
      setState("done");
    } catch (e) {
      setNeedsKey(e instanceof AssistError && e.code === "no_provider");
      setErr(e instanceof Error ? e.message : "Couldn't debug this right now.");
      setState("error");
    }
  };

  if (state === "idle" || state === "loading") {
    return (
      <button
        type="button"
        onClick={run}
        disabled={state === "loading"}
        className={clsx(
          "focus-ring inline-flex items-center gap-1 rounded-md border border-line-strong bg-raised font-medium text-fg-2 transition-colors hover:border-accent/60 hover:text-fg disabled:opacity-60",
          size === "xs" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-[12px]",
          className,
        )}
      >
        {state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Bug className="h-3 w-3" aria-hidden />}
        {state === "loading" ? "Reading the evidence…" : label}
      </button>
    );
  }
  if (state === "error") {
    return (
      <div role="status" className={clsx("relative w-full basis-full rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5 pr-8 text-xs text-warn", className)}>
        <p>{err}</p>
        {needsKey && (
          <Link href="/settings?tab=providers" className="mt-1 inline-block font-medium underline underline-offset-2">
            Add a model key
          </Link>
        )}
        <DismissButton onClick={() => setState("idle")} />
      </div>
    );
  }
  return report ? <DebugReportView report={report} onClose={() => setState("idle")} className={className} /> : null;
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Dismiss" onClick={onClick} className="focus-ring absolute right-2 top-2 rounded p-0.5 text-fg-3 hover:text-fg">
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

const CONFIDENCE_TONE: Record<DebugReport["confidence"], string> = {
  high: "bg-ok-soft text-ok",
  medium: "bg-accent-soft text-accent",
  low: "bg-warn-soft text-warn",
};

function RefText({ text, evidence }: { text: string; evidence: Map<string, DebugEvidence> }) {
  return (
    <>
      {splitRefs(text).map((part, i) =>
        part.ref ? (
          <span
            key={i}
            title={evidence.get(part.ref)?.label ?? part.ref}
            className="mx-0.5 inline-flex items-center rounded bg-raised px-1 font-mono text-[11px] text-fg-2 ring-1 ring-line"
          >
            {shortRef(part.ref)}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function DebugReportView({ report, onClose, className }: { report: DebugReport; onClose?: () => void; className?: string }) {
  const evidence = new Map(report.citations.map((c) => [c.ref, c]));
  const [showEvidence, setShowEvidence] = useState(false);
  return (
    <section aria-label="Debug report" className={clsx("relative w-full basis-full rounded-[10px] border border-line-strong bg-panel p-3.5 text-[13px] text-fg", className)}>
      <header className="flex flex-wrap items-center gap-2 pr-6">
        <span className="flex items-center gap-1 text-[12px] font-medium text-accent">
          <Bug className="h-3.5 w-3.5" aria-hidden /> Debug agent
        </span>
        <span className={clsx("rounded px-1.5 py-0.5 text-[11px] font-medium", CONFIDENCE_TONE[report.confidence])}>
          {report.confidence} confidence
        </span>
        {!report.grounded && (
          <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn">not grounded in evidence</span>
        )}
      </header>
      {onClose && <DismissButton onClick={onClose} />}
      <p className="mt-2 font-medium leading-snug">
        <RefText text={report.summary} evidence={evidence} />
      </p>
      <p className="mt-1.5 leading-relaxed text-fg-2">
        <RefText text={report.rootCause} evidence={evidence} />
      </p>

      {report.citations.length > 0 && (
        <div className="mt-2.5">
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            aria-expanded={showEvidence}
            className="focus-ring inline-flex items-center gap-1 rounded text-[12px] text-fg-3 hover:text-fg"
          >
            <ChevronDown className={clsx("h-3.5 w-3.5 transition-transform", showEvidence && "rotate-180")} aria-hidden />
            {report.citations.length} cited {report.citations.length === 1 ? "piece" : "pieces"} of evidence
          </button>
          {showEvidence && (
            <ul className="mt-1.5 space-y-1.5">
              {report.citations.map((c) => (
                <li key={c.ref} className="rounded-md border border-line bg-canvas px-2 py-1.5">
                  <p className="text-[12px]">
                    <span className="font-mono text-fg-2" title={c.ref}>{shortRef(c.ref)}</span> <span className="text-fg-2">{c.label}</span>
                  </p>
                  {c.detail && <p className="mt-0.5 break-words font-mono text-[11px] text-fg-3 [overflow-wrap:anywhere]">{c.detail}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-3 space-y-2.5">
        {report.proposals.length === 0 ? (
          <p className="text-[12px] text-fg-3">No fix to propose from this evidence.</p>
        ) : (
          <>
            <p className="text-[12px] font-medium text-fg-2">Proposed fixes. Nothing changes until you confirm one.</p>
            {report.proposals.map((p) => (
              <ProposalCard key={p.id} p={p} evidence={evidence} />
            ))}
          </>
        )}
      </div>
      <p className="mt-3 text-[11px] text-fg-3">
        Cost ${report.costUsd.toFixed(4)} · {Object.entries(report.evidence).map(([k, n]) => `${n} ${k}`).join(", ")}
      </p>
    </section>
  );
}

function DiffView({ diff }: { diff: NonNullable<DebugProposal["diff"]> }) {
  const long = diff.before.length > 80 || diff.after.length > 80;
  if (!long) {
    return (
      <p className="mt-1.5 text-[12px]">
        <span className="font-mono text-fg-3">{diff.field}:</span>{" "}
        <span className="rounded bg-bad-soft px-1 font-mono text-bad line-through">{diff.before || "(empty)"}</span>{" "}
        <span aria-hidden>→</span> <span className="rounded bg-ok-soft px-1 font-mono text-ok">{diff.after}</span>
      </p>
    );
  }
  return (
    <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
      {(
        [
          ["Before", diff.before, "border-bad/30"],
          ["After", diff.after, "border-ok/30"],
        ] as const
      ).map(([label, text, border]) => (
        <div key={label} className={clsx("min-w-0 rounded-md border bg-canvas", border)}>
          <p className="border-b border-line px-2 py-1 text-[11px] text-fg-3">
            {label} · {diff.field}
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[11px] text-fg-2 [overflow-wrap:anywhere]">
            {text || "(empty)"}
          </pre>
        </div>
      ))}
    </div>
  );
}

function ProposalCard({ p, evidence }: { p: DebugProposal; evidence: Map<string, DebugEvidence> }) {
  const [stage, setStage] = useState<"view" | "confirm" | "working" | "applied" | "error">("view");
  const [msg, setMsg] = useState("");
  const [suiteId, setSuiteId] = useState<string | null>(null);
  const [replay, setReplay] = useState<"idle" | "running" | string>("idle");
  const canApply = actionAllowed(p);

  const apply = async () => {
    setStage("working");
    try {
      const out = (await api.applyDebugProposal(p)) as Record<string, unknown> | undefined;
      if (p.kind === "eval_case" && typeof out?.id === "string") setSuiteId(out.id);
      setMsg(appliedText(p, out));
      setStage("applied");
    } catch (e) {
      setMsg(e instanceof Error ? e.message.replace(/^API \d+: /, "") : "That didn't apply.");
      setStage("error");
    }
  };

  const runReplay = async () => {
    if (!suiteId) return;
    setReplay("running");
    try {
      const r = await api.runEvalSuite(suiteId, {});
      setReplay(r.passed ? "Replay passed on the working copy." : "Replay still fails on the working copy. The fix isn't there yet.");
    } catch (e) {
      setReplay(e instanceof Error ? e.message.replace(/^API \d+: /, "") : "Replay failed to run.");
    }
  };

  const tone = p.risk === "high" ? "danger" : "default";
  return (
    <div className="rounded-[10px] border border-line p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] font-medium text-fg-2 ring-1 ring-line">{KIND_LABEL[p.kind]}</span>
        <span
          className={clsx(
            "rounded px-1.5 py-0.5 text-[11px]",
            p.risk === "high" ? "bg-bad-soft text-bad" : p.risk === "medium" ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok",
          )}
        >
          {p.risk} risk
        </span>
        <p className="min-w-0 flex-1 basis-40 text-[13px] font-medium">{p.title}</p>
      </div>
      {p.rationale && (
        <p className="mt-1 text-[12px] leading-relaxed text-fg-2">
          <RefText text={p.rationale} evidence={evidence} />
        </p>
      )}
      {p.diff && <DiffView diff={p.diff} />}
      {p.followUp && <p className="mt-1.5 text-[11.5px] text-fg-3">{p.followUp}</p>}

      {p.kind === "policy" && p.href ? (
        <Link
          href={p.href}
          className="focus-ring mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-line-strong px-2.5 text-[12px] text-fg-2 hover:border-accent hover:text-fg"
        >
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Open the policy editor <ExternalLink className="h-3 w-3" aria-hidden />
        </Link>
      ) : null}

      {canApply && stage === "view" && (
        <button
          type="button"
          onClick={() => setStage("confirm")}
          className="focus-ring mt-2 inline-flex h-7 items-center rounded-md border border-line-strong px-2.5 text-[12px] font-medium text-fg hover:border-accent"
        >
          Review and apply
        </button>
      )}
      {canApply && (stage === "confirm" || stage === "working") && p.action && (
        <div className="mt-2">
          <ConfirmCard
            title={`${p.action.method} ${p.action.path}`}
            confirmLabel={confirmLabel(p.kind)}
            tone={tone}
            working={stage === "working"}
            onConfirm={apply}
            onCancel={() => setStage("view")}
          >
            <p className="text-[12px] text-fg-2">
              Sent with your own session. The endpoint&apos;s own permission checks and audit apply.
              {p.precondition ? " Refused if this changed since the analysis." : ""}
            </p>
          </ConfirmCard>
        </div>
      )}
      {stage === "applied" && (
        <div role="status" className="mt-2 rounded-md bg-ok-soft px-2.5 py-2 text-[12px] text-ok">
          <p className="flex items-center gap-1">
            <Check className="h-3.5 w-3.5" aria-hidden /> {msg}
          </p>
          {suiteId && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-fg-2">
              {replay === "idle" ? (
                <button type="button" onClick={runReplay} className="focus-ring rounded border border-line-strong bg-panel px-2 py-0.5 text-[12px] text-fg hover:border-accent">
                  Replay against the working copy
                </button>
              ) : replay === "running" ? (
                <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Replaying with the recorded tool results…</span>
              ) : (
                <span>{replay}</span>
              )}
            </div>
          )}
        </div>
      )}
      {stage === "error" && (
        <div role="alert" className="mt-2 flex items-start justify-between gap-2 rounded-md bg-bad-soft px-2.5 py-2 text-[12px] text-bad">
          <p>{msg}</p>
          <button type="button" onClick={() => setStage("view")} className="focus-ring shrink-0 underline underline-offset-2">
            Back
          </button>
        </div>
      )}
    </div>
  );
}

function appliedText(p: DebugProposal, out: Record<string, unknown> | undefined): string {
  switch (p.kind) {
    case "rollback": {
      const rb = (out?.rollback as Record<string, unknown> | undefined) ?? out;
      return rb?.version ? `Rolled back. Now serving ${String(rb.version)}.` : "Rolled back.";
    }
    case "prompt_patch":
    case "model_change":
      return "Saved to the working copy. Freeze and promote it to reach production.";
    case "eval_case":
      return "Regression suite created.";
    case "budget":
      return "Budget limit raised.";
    case "retry":
      return out?.id ? `Retry started: run ${String(out.id).slice(0, 8)}.` : "Retry started.";
    default:
      return "Applied.";
  }
}
