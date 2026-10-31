"use client";
// The Ask PAL engine, shared by ⌘K and the per-page agent surface so there is
// ONE path from words to action:
//   request + compact real context → /v1/completions (model "auto", via the
//   control-plane) → lib/assistant.parseAssistAction (allowlisted routes, ids
//   only from the given context) → navigate / answer / explain run directly,
//   or stop at a ConfirmCard for anything that changes state.
// Pure validation stays in lib/assistant.ts (unit-tested); this file is the
// React glue + the plan renderer.

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";
import { api, AssistError, type OnboardingSpec } from "@/lib/api";
import type { Run } from "@/lib/types";
import { runtimeApi } from "@/lib/runtime-api";
import type { VmRow } from "@/lib/runtime-types";
import {
  ASSIST_SYSTEM_PROMPT, formatAssistContext, parseAssistAction, vmActionLabel,
  type AssistAction, type AssistContext,
} from "@/lib/assistant";
import { useWorkspaceMode } from "@/lib/use-workspace-mode";
import { useCan } from "@/components/role-gate";
import { ConfirmCard } from "@/components/confirm-card";

export type Plan =
  | { state: "thinking" }
  | { state: "answer"; title: string; text: string; link?: { href: string; label: string } }
  | { state: "confirm_agent"; spec: OnboardingSpec }
  | { state: "confirm_vms"; action: Extract<AssistAction, { kind: "vm_action" }>; selected: string[] }
  | { state: "working"; label: string }
  | { state: "error"; text: string; fix?: { href: string; label: string } };

export function useAssist(onNavigate?: () => void) {
  const router = useRouter();
  const { mode } = useWorkspaceMode();
  const canWrite = useCan("agents:write");
  const canRuntime = useCan("runtime:admin");
  const canRun = useCan("runs:execute");
  const [plan, setPlan] = useState<Plan | null>(null);
  const seqRef = useRef(0);

  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [vms, setVms] = useState<VmRow[]>([]);

  const loadContext = useCallback(async () => {
    const [agents, recent, vmRes] = await Promise.all([
      api.listAgents().catch(() => []),
      api.listRuns().catch(() => [] as Run[]),
      runtimeApi.get<VmRow[] | { items: VmRow[] }>("/v1/runtime/vms?state=running&limit=50").catch(() => [] as VmRow[]),
    ]);
    setAgentNames(agents.map((a) => a.name));
    setRuns(recent.slice(0, 30));
    setVms((Array.isArray(vmRes) ? vmRes : vmRes.items ?? []).filter((v) => v.state === "running"));
  }, []);

  const context = useMemo<AssistContext>(() => {
    const runCountsByStatus: Record<string, number> = {};
    for (const r of runs) runCountsByStatus[r.status || "unknown"] = (runCountsByStatus[r.status || "unknown"] ?? 0) + 1;
    const now = Date.now();
    return {
      mode,
      agentNames,
      runCountsByStatus,
      failedRuns: runs.filter((r) => r.status === "failed").slice(0, 8).map((r) => ({ id: r.id, agentName: r.agentName })),
      runningVms: vms.map((v) => ({
        id: v.vmId,
        idleMinutes: null, // the API exposes no activity signal; the confirm step lets the user choose
        upMinutes: v.createdAt ? Math.max(0, Math.round((now - Date.parse(v.createdAt)) / 60000)) : null,
      })),
    };
  }, [mode, agentNames, runs, vms]);

  const reset = useCallback(() => {
    seqRef.current += 1;
    setPlan(null);
  }, []);

  const go = useCallback((path: string) => {
    router.push(path);
    onNavigate?.();
  }, [router, onNavigate]);

  const execute = useCallback(async (action: AssistAction, seq: number) => {
    const stale = () => seq !== seqRef.current;
    switch (action.kind) {
      case "navigate":
        go(action.path);
        return;
      case "answer":
        setPlan({ state: "answer", title: action.summary, text: action.answer });
        return;
      case "explain_run":
        setPlan({ state: "working", label: "Reading the run…" });
        try {
          const text = await api.assistExplain({ kind: "run", runId: action.runId });
          if (!stale()) setPlan({ state: "answer", title: "Why this run failed", text, link: { href: `/runs/${encodeURIComponent(action.runId)}`, label: "Open run" } });
        } catch (err) {
          if (!stale()) setPlan(assistErrorPlan(err));
        }
        return;
      case "create_agent":
        if (!canWrite) { setPlan({ state: "error", text: "Your role can't create agents. Ask an owner or admin." }); return; }
        setPlan({ state: "working", label: "Designing your agent…" });
        try {
          const spec = await api.generateSpecFromGoal(action.description);
          if (!stale()) setPlan({ state: "confirm_agent", spec });
        } catch (err) {
          if (!stale()) setPlan(assistErrorPlan(err));
        }
        return;
      case "vm_action":
        if (!canRuntime) { setPlan({ state: "error", text: "Your role can't change sandboxes. Ask an owner or admin." }); return; }
        setPlan({ state: "confirm_vms", action, selected: action.vmIds });
        return;
    }
  }, [go, canWrite, canRuntime]);

  /** Ask in words. `extraContext` lets a page add what the person is looking at. */
  const ask = useCallback(async (raw: string, extraContext?: string) => {
    const q = raw.trim();
    if (q.length < 2) return;
    if (!canRun) { setPlan({ state: "error", text: "Your role is read-only, so Ask PAL is off. Search still works." }); return; }
    const seq = ++seqRef.current;
    setPlan({ state: "thinking" });
    const ctx = formatAssistContext(context) + (extraContext ? `\nOn screen: ${extraContext}` : "");
    const text = await api.assistJSON(ASSIST_SYSTEM_PROMPT, `Workspace context (compact, real):\n${ctx}\n\nRequest: ${q}`);
    if (seq !== seqRef.current) return;
    const action = text ? parseAssistAction(text, context) : null;
    if (!action) {
      setPlan({
        state: "error",
        text: text
          ? "PAL couldn't turn that into an action. Try rephrasing, or search runs for it."
          : "PAL couldn't reach a model. Check that a provider key is set.",
        fix: text ? { href: `/runs?q=${encodeURIComponent(q)}`, label: "Search runs" } : { href: "/settings?tab=providers", label: "Model providers" },
      });
      return;
    }
    await execute(action, seq);
  }, [context, execute, canRun]);

  // ── Confirm handlers: the only place assistant mutations run ──
  const confirmAgent = useCallback(async (spec: OnboardingSpec) => {
    const seq = ++seqRef.current;
    setPlan({ state: "working", label: "Creating agent…" });
    try {
      await api.createAgent({ name: spec.name, description: spec.description, systemPrompt: spec.systemPrompt, model: spec.model || "auto" });
      if (seq === seqRef.current) go(`/agents/${encodeURIComponent(spec.name)}`);
    } catch (err) {
      if (seq === seqRef.current) setPlan({ state: "error", text: `Couldn't create the agent: ${shortError(err)}` });
    }
  }, [go]);

  const confirmVms = useCallback(async (action: Extract<AssistAction, { kind: "vm_action" }>, ids: string[]) => {
    const seq = ++seqRef.current;
    setPlan({ state: "working", label: `${vmActionLabel(action.op, ids.length)}…` });
    const results = await Promise.allSettled(ids.map((id) => {
      const path = `/v1/runtime/vms/${encodeURIComponent(id)}`;
      return action.op === "terminate" ? runtimeApi.del(path) : runtimeApi.post(`${path}/${action.op}`);
    }));
    if (seq !== seqRef.current) return;
    const failed = results.filter((r) => r.status === "rejected").length;
    setPlan({
      state: "answer",
      title: vmActionLabel(action.op, ids.length),
      text: failed === 0
        ? `Done: ${ids.length} VM${ids.length === 1 ? "" : "s"} ${action.op === "terminate" ? "terminating" : action.op + "d"}.`
        : `${ids.length - failed} succeeded, ${failed} failed. Open Sandboxes for details.`,
      link: { href: "/runtime", label: "Open Sandboxes" },
    });
    void loadContext();
  }, [loadContext]);

  return { plan, setPlan, ask, reset, loadContext, confirmAgent, confirmVms, agentNames, runs };
}

export function shortError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  const body = m.match(/API \d+: (.*)/)?.[1];
  if (body) {
    try { return (JSON.parse(body) as { error?: string }).error ?? body; } catch { return body.slice(0, 160); }
  }
  return m.slice(0, 160);
}

function assistErrorPlan(err: unknown): Plan {
  if (err instanceof AssistError && err.code === "no_provider") return { state: "error", text: err.message, fix: { href: "/settings?tab=providers", label: "Add a key" } };
  if (err instanceof AssistError) return { state: "error", text: err.message };
  const msg = shortError(err);
  if (msg.includes("no_provider") || msg.toLowerCase().includes("provider")) return { state: "error", text: "Add a model provider key first.", fix: { href: "/settings?tab=providers", label: "Add a key" } };
  return { state: "error", text: msg || "Something went wrong." };
}

/** Renders the plan state: progress, answer, error, or a ConfirmCard. */
export function PlanView({
  plan, setPlan, onConfirmAgent, onConfirmVms, onNavigate,
}: {
  plan: Plan;
  setPlan: (p: Plan | null) => void;
  onConfirmAgent: (spec: OnboardingSpec) => void;
  onConfirmVms: (action: Extract<AssistAction, { kind: "vm_action" }>, ids: string[]) => void;
  onNavigate?: () => void;
}) {
  switch (plan.state) {
    case "thinking":
    case "working":
      return (
        <div className="rounded-[10px] border border-line bg-raised px-3.5 py-3" role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-[13px] text-fg-2">
            <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
            {plan.state === "thinking" ? "Thinking…" : plan.label}
          </p>
        </div>
      );
    case "answer":
      return (
        <div className="rounded-[10px] border border-accent/30 bg-accent-soft px-3.5 py-3" role="status" aria-live="polite">
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-accent"><Sparkles className="h-3 w-3" aria-hidden /> {plan.title}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg">{plan.text}</p>
          {plan.link && (
            <Link href={plan.link.href} onClick={onNavigate} className="focus-ring mt-2 inline-flex items-center gap-1 rounded text-[12px] font-medium text-accent hover:underline">
              {plan.link.label} <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>
      );
    case "error":
      return (
        <div className="rounded-[10px] border border-warn/40 bg-warn-soft px-3.5 py-3" role="alert">
          <p className="text-[13px] text-warn">{plan.text}</p>
          {plan.fix && (
            <Link href={plan.fix.href} onClick={onNavigate} className="focus-ring mt-2 inline-flex items-center gap-1 rounded text-[12px] font-medium text-warn underline-offset-2 hover:underline">
              {plan.fix.label}
            </Link>
          )}
        </div>
      );
    case "confirm_agent":
      return (
        <ConfirmCard
          title="Confirm: create agent"
          confirmLabel="Create agent"
          onConfirm={() => onConfirmAgent(plan.spec)}
          onCancel={() => setPlan(null)}
          secondary={
            <Link href="/agents/create" onClick={onNavigate} className="focus-ring inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-[13px] text-fg-2 hover:bg-hover">
              Edit first
            </Link>
          }
        >
          <p className="font-mono text-[13px] text-fg">{plan.spec.name}</p>
          {plan.spec.description && <p className="mt-0.5 text-[12px] text-fg-2">{plan.spec.description}</p>}
          {plan.spec.rationale && <p className="mt-1.5 text-[12px] text-fg-3">{plan.spec.rationale}</p>}
        </ConfirmCard>
      );
    case "confirm_vms": {
      const { action, selected } = plan;
      const toggle = (id: string) =>
        setPlan({ ...plan, selected: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] });
      return (
        <ConfirmCard
          title={`Confirm: ${vmActionLabel(action.op, selected.length).toLowerCase()}`}
          confirmLabel={vmActionLabel(action.op, selected.length)}
          tone={action.op === "terminate" ? "danger" : "default"}
          disabled={selected.length === 0}
          onConfirm={() => onConfirmVms(action, selected)}
          onCancel={() => setPlan(null)}
        >
          <p className="text-[12px] text-fg-2">{action.summary}</p>
          <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto">
            {action.vmIds.map((id) => (
              <li key={id}>
                <label className="flex items-center gap-2 text-[12px] text-fg-2">
                  <input type="checkbox" checked={selected.includes(id)} onChange={() => toggle(id)} className="accent-[var(--color-accent)]" />
                  <span className="font-mono">{id}</span>
                </label>
              </li>
            ))}
          </ul>
        </ConfirmCard>
      );
    }
  }
}

