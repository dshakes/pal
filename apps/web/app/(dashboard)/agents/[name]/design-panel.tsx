"use client";
// Agent · Design (v3). Everything here is read from and saved to the server:
// the spec (instructions and model; the description is fixed at create), the saved workflow graph, the
// MCP servers attached to the agent, the connectors the workflow calls, and
// what of that the agent's policy will refuse. The visual editor (@xyflow)
// lives on its own route; this tab summarises it and links there.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, Plug, Server, ShieldCheck, Workflow, X } from "lucide-react";
import { api, type ConnectorInstall, type McpAttachment, type McpServer } from "@/lib/api";
import type { AgentPolicyDocument } from "@/lib/agent-policy";
import type { Agent } from "@/lib/types";
import { apiErrorText } from "@/lib/observability";
import { policyGaps, summarizeWorkflow } from "@/lib/design-view";
import { Button } from "@/components/button";
import { RoleGate } from "@/components/role-gate";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { Section } from "./lifecycle";

const MODELS = [
  { value: "", label: "Leave unchanged" },
  { value: "auto", label: "auto — default chain" },
  { value: "fast", label: "fast" },
  { value: "balanced", label: "balanced" },
  { value: "reasoning-small", label: "reasoning-small" },
  { value: "reasoning-large", label: "reasoning-large" },
];

const field = "focus-ring w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13.5px] text-fg placeholder:text-fg-3";

export function DesignPanel({ agent, onSaved, onOpenTab }: { agent: Agent; onSaved: () => void; onOpenTab: (tab: "security") => void }) {
  const toast = useToast();
  const name = agent.name;
  const [prompt, setPrompt] = useState(agent.systemPrompt ?? "");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  // Follow the server's value after a save, but never overwrite unsaved edits.
  const synced = useRef(agent.systemPrompt ?? "");
  useEffect(() => {
    const next = agent.systemPrompt ?? "";
    setPrompt((cur) => (cur === synced.current ? next : cur));
    synced.current = next;
  }, [agent.systemPrompt]);
  const dirty = prompt !== (agent.systemPrompt ?? "") || model !== "";

  const [workflow, setWorkflow] = useState<unknown>(undefined);
  const [policy, setPolicy] = useState<AgentPolicyDocument | null | undefined>(undefined);
  const [attached, setAttached] = useState<McpAttachment[] | null>(null);
  const [catalog, setCatalog] = useState<McpServer[]>([]);
  const [installs, setInstalls] = useState<ConnectorInstall[] | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attachSlug, setAttachSlug] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [wf, pol, att, cat, inst] = await Promise.all([
        api.getWorkflow(name, { strict: true }),
        api.getAgentPolicy(name).catch(() => null),
        api.listAgentMcpServers(name),
        api.listMcpServers().catch(() => [] as McpServer[]),
        api.listConnectors().catch(() => null),
      ]);
      setWorkflow(wf);
      setPolicy(pol);
      setAttached(att);
      setCatalog(cat);
      setInstalls(inst);
      setLoadError(null);
    } catch (e) {
      setLoadError(apiErrorText(e, "Couldn’t load this agent’s design"));
    }
  }, [name]);
  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => (workflow === undefined ? undefined : summarizeWorkflow(workflow)), [workflow]);
  const gaps = useMemo(() => policyGaps(summary ?? null, policy?.policy ?? null), [summary, policy]);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateAgent(name, {
        ...(prompt !== (agent.systemPrompt ?? "") ? { systemPrompt: prompt } : {}),
        ...(model ? { model } : {}),
      });
      setModel("");
      toast.success("Design saved");
      onSaved();
    } catch (e) {
      toast.error(apiErrorText(e, "Couldn’t save"));
    } finally {
      setSaving(false);
    }
  };

  const attach = async () => {
    if (!attachSlug) return;
    setBusySlug(attachSlug);
    try {
      await api.attachMcpServer(name, { serverSlug: attachSlug });
      setAttachSlug("");
      setAttached(await api.listAgentMcpServers(name));
    } catch (e) {
      toast.error(apiErrorText(e, "Couldn’t attach the server"));
    } finally {
      setBusySlug(null);
    }
  };
  const detach = async (slug: string) => {
    setBusySlug(slug);
    try {
      await api.detachMcpServer(name, slug);
      setAttached(await api.listAgentMcpServers(name));
    } catch (e) {
      toast.error(apiErrorText(e, "Couldn’t detach the server"));
    } finally {
      setBusySlug(null);
    }
  };

  const attachable = catalog.filter((s) => !attached?.some((a) => a.serverSlug === s.slug));
  const usedConnectors = summary ? Object.entries(summary.connectors) : [];

  return (
    <div className="space-y-8">
      {gaps.length > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-bad/40 bg-bad-soft p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-bad" aria-hidden />
          <div className="min-w-0 text-[13px]">
            <p className="font-medium text-fg">The policy will refuse {gaps.length === 1 ? "a step" : `${gaps.length} steps`} in this workflow</p>
            <p className="mt-0.5 text-fg-2">
              Not allowed: {gaps.map((g) => <code key={g.kind + g.target} className="mr-1.5 rounded bg-raised px-1 font-mono text-[12px]">{g.target}</code>)}
              — runs fail at that step with “agent policy denied”.{" "}
              <button type="button" onClick={() => onOpenTab("security")} className="focus-ring rounded font-medium text-accent hover:underline">
                Review the policy
              </button>
            </p>
          </div>
        </div>
      )}

      <Section title="Spec">
        <div className="space-y-4 rounded-lg border border-line bg-panel p-4">
          <div>
            <p className="mb-1 text-[12.5px] font-medium text-fg-2">Description</p>
            <p className="text-[13.5px] text-fg">{agent.description || <span className="text-fg-3">None</span>}</p>
            <p className="mt-1 text-[12px] text-fg-3">Set when the agent is created; the API can’t change it afterwards.</p>
          </div>
          <div>
            <label htmlFor="d-prompt" className="mb-1 block text-[12.5px] font-medium text-fg-2">Instructions <span className="font-normal text-fg-3">(system prompt)</span></label>
            <textarea id="d-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} className={`${field} font-mono text-[13px] leading-relaxed`} placeholder="How the agent should behave" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="d-model" className="mb-1 block text-[12.5px] font-medium text-fg-2">Model</label>
              <select id="d-model" value={model} onChange={(e) => setModel(e.target.value)} className={field}>
                {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <p className="mt-1 text-[12px] text-fg-3">Addressed by capability; the router picks the vendor model. Current: {agent.model || "auto (default chain)"}.</p>
            </div>
          </div>
          <RoleGate cap="agents:write">
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void save()} loading={saving} disabled={!dirty || saving}>Save</Button>
              {dirty && (
                <Button size="sm" variant="ghost" onClick={() => { setPrompt(agent.systemPrompt ?? ""); setModel(""); }}>
                  Discard
                </Button>
              )}
            </div>
          </RoleGate>
        </div>
      </Section>

      {loadError ? (
        <p role="alert" className="rounded-lg border border-line bg-panel p-4 text-[13px] text-bad">{loadError}</p>
      ) : (
        <>
          <Section
            title="Workflow"
            action={<Link href={`/agents/${encodeURIComponent(name)}/editor`} className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">Open visual editor <ExternalLink className="h-3 w-3" aria-hidden /></Link>}
          >
            {summary === undefined ? (
              <Skeleton className="h-16 w-full" />
            ) : summary === null ? (
              <div className="flex items-center gap-3 rounded-lg border border-dashed border-line p-4 text-[13px] text-fg-2">
                <Workflow className="h-4 w-4 shrink-0 text-fg-3" aria-hidden />
                No workflow saved — each run is one model call with the instructions above.
              </div>
            ) : (
              <div className="rounded-lg border border-line bg-panel p-4">
                <p className="text-[13.5px] text-fg">
                  <span className="num font-medium">{summary.nodes}</span> steps:{" "}
                  <span className="text-fg-2">{Object.entries(summary.byType).map(([t, n]) => `${n} ${t}`).join(" · ")}</span>
                </p>
                {summary.tools.length > 0 && (
                  <p className="mt-1.5 text-[13px] text-fg-2">Tools: {summary.tools.map((t) => <code key={t} className="mr-1.5 rounded bg-raised px-1 font-mono text-[12px]">{t}</code>)}</p>
                )}
              </div>
            )}
          </Section>

          <Section title="Connectors the workflow calls">
            {summary === undefined || installs === undefined ? (
              <Skeleton className="h-12 w-full" />
            ) : usedConnectors.length === 0 ? (
              <p className="text-[13px] text-fg-3">None. Connector steps you add in the editor show up here with their install status.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
                {usedConnectors.map(([id, actions]) => {
                  const inst = installs?.find((i) => i.connectorId === id);
                  const state = !installs ? "unknown" : !inst ? "missing" : inst.needsReauth ? "reauth" : "ok";
                  return (
                    <li key={id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
                      <span className="flex min-w-0 items-center gap-2">
                        <Plug className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden />
                        <span className="font-medium text-fg">{id}</span>
                        <span className="truncate text-fg-3">{actions.join(", ")}</span>
                      </span>
                      <span className={state === "ok" ? "text-ok" : state === "unknown" ? "text-fg-3" : "text-warn"}>
                        {state === "ok" ? "Installed" : state === "reauth" ? "Needs re-authorization" : state === "missing" ? <Link href="/connectors" className="hover:underline">Not installed — install</Link> : "Status unavailable"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="MCP servers">
            {attached === null ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <div className="space-y-2.5">
                {attached.length === 0 ? (
                  <p className="text-[13px] text-fg-3">No MCP servers attached.</p>
                ) : (
                  <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
                    {attached.map((a) => (
                      <li key={a.serverSlug} className="flex items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
                        <span className="flex min-w-0 items-center gap-2">
                          <Server className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden />
                          <span className="font-medium text-fg">{a.serverName || a.serverSlug}</span>
                          <span className="truncate text-fg-3">{a.transport} · {a.category}</span>
                        </span>
                        <RoleGate cap="agents:write">
                          <button type="button" onClick={() => void detach(a.serverSlug)} disabled={busySlug === a.serverSlug} aria-label={`Detach ${a.serverName || a.serverSlug}`} className="focus-ring rounded p-1 text-fg-3 hover:bg-hover hover:text-fg disabled:opacity-50">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </RoleGate>
                      </li>
                    ))}
                  </ul>
                )}
                <RoleGate cap="agents:write">
                  {attachable.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label htmlFor="d-mcp" className="sr-only">MCP server to attach</label>
                      <select id="d-mcp" value={attachSlug} onChange={(e) => setAttachSlug(e.target.value)} className={`${field} w-auto min-w-[14rem]`}>
                        <option value="">Choose a server…</option>
                        {attachable.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
                      </select>
                      <Button size="sm" variant="secondary" onClick={() => void attach()} disabled={!attachSlug} loading={busySlug === attachSlug && !!attachSlug}>Attach</Button>
                    </div>
                  )}
                </RoleGate>
              </div>
            )}
          </Section>

          <Section title="Policy">
            {policy === undefined ? (
              <Skeleton className="h-12 w-full" />
            ) : policy === null ? (
              <p className="text-[13px] text-fg-3">The policy couldn’t be read.</p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-[13px]">
                <span className="flex items-center gap-2 text-fg-2">
                  <ShieldCheck className="h-4 w-4 text-fg-3" aria-hidden />
                  {policy.policy.mode === "enforce" ? "Enforced" : "Legacy permissive (allows everything)"} · {policy.policy.tools.length} tool{policy.policy.tools.length === 1 ? "" : "s"},{" "}
                  {Object.keys(policy.policy.connectors ?? {}).length} connector{Object.keys(policy.policy.connectors ?? {}).length === 1 ? "" : "s"},{" "}
                  {policy.policy.mcpServers.length} MCP pattern{policy.policy.mcpServers.length === 1 ? "" : "s"} allowed
                </span>
                <button type="button" onClick={() => onOpenTab("security")} className="focus-ring rounded text-[12.5px] font-medium text-accent hover:underline">Identity & policy</button>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
