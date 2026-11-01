"use client";

// Agent detail → MCP servers: real attachments (GET/POST/DELETE
// /v1/agents/{name}/mcp-servers) + live tools/list as the connection test.

import { useCallback, useEffect, useState } from "react";
import { Plug, Plus, Server, X } from "lucide-react";
import clsx from "clsx";
import { api, type McpAttachment, type McpServer, type McpTenantServer, type McpToolsResult } from "@/lib/api";
import { isAuthRequired, needsVmId, parseApiError, policyEntry } from "@/lib/mcp";
import { Button } from "@/components/button";
import { Modal } from "@/components/modal";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";

type TestState =
  | { kind: "ok"; result: McpToolsResult }
  | { kind: "auth"; message: string }
  | { kind: "error"; message: string };

interface Option { slug: string; name: string; transport: string; tenant: boolean }

export function AgentMcpSection({ agentName }: { agentName: string }) {
  const toast = useToast();
  const [attached, setAttached] = useState<McpAttachment[] | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [showAttach, setShowAttach] = useState(false);
  const [pick, setPick] = useState("");
  const [vmId, setVmId] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const refresh = useCallback(async () => {
    try {
      setAttached(await api.listAgentMcpServers(agentName));
    } catch (e) {
      setAttached([]);
      toast.error(`Could not load MCP servers — ${parseApiError(e).message}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName]);

  useEffect(() => { void refresh(); }, [refresh]);

  const openAttach = async () => {
    setShowAttach(true);
    setPick(""); setVmId("");
    const [cat, ten] = await Promise.all([
      api.listMcpServers().catch((): McpServer[] => []),
      api.listMcpTenantServers().catch((): McpTenantServer[] => []),
    ]);
    setOptions([
      ...cat.map((s) => ({ slug: s.slug, name: s.name, transport: s.transport ?? "streamable-http", tenant: false })),
      ...ten.map((s) => ({ slug: s.slug, name: s.name || s.slug, transport: "streamable-http", tenant: true })),
    ]);
  };

  const picked = options.find((o) => o.slug === pick);
  const stdio = !!picked && needsVmId(picked.transport);

  const attach = async () => {
    if (!picked) return;
    if (stdio && !vmId.trim()) { toast.error("Choose a sandbox VM id for this stdio server"); return; }
    setSaving(true);
    try {
      await api.attachMcpServer(agentName, { serverSlug: picked.slug, ...(stdio ? { config: { vmId: vmId.trim() } } : {}) });
      toast.success(`${picked.name} attached`);
      setShowAttach(false);
      await refresh();
    } catch (e) {
      toast.error(`Attach failed — ${parseApiError(e).message}`);
    } finally {
      setSaving(false);
    }
  };

  const detach = async (slug: string) => {
    try {
      await api.detachMcpServer(agentName, slug);
      setTests((t) => { const n = { ...t }; delete n[slug]; return n; });
      toast.success("MCP server detached");
      await refresh();
    } catch (e) {
      toast.error(`Detach failed — ${parseApiError(e).message}`);
    }
  };

  const test = async (slug: string) => {
    setTesting(slug);
    try {
      const result = await api.listAgentMcpTools(agentName, slug);
      setTests((t) => ({ ...t, [slug]: { kind: "ok", result } }));
    } catch (e) {
      const pe = parseApiError(e);
      setTests((t) => ({ ...t, [slug]: isAuthRequired(pe) ? { kind: "auth", message: pe.message } : { kind: "error", message: pe.message } }));
    } finally {
      setTesting(null);
    }
  };

  const connect = async (a: McpAttachment) => {
    if (a.authType !== "oauth") { window.location.href = "/settings/mcp"; return; }
    try {
      const { authorizationUrl } = await api.startMcpOAuth(a.serverSlug);
      window.location.href = authorizationUrl;
    } catch (e) {
      toast.error(`Could not start authorization — ${parseApiError(e).message}`);
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-line bg-panel p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg"><Plug className="h-4 w-4 text-accent" /> MCP Servers</h3>
        <Button size="sm" variant="secondary" icon={<Plus className="h-3 w-3" />} onClick={openAttach}>Attach server</Button>
      </div>
      <p className="text-[11px] text-fg-3">
        Give the agent tools from Model Context Protocol servers. Register your own servers and credentials in{" "}
        <a href="/settings/mcp" className="text-pal-400 hover:underline">Settings → MCP</a>.
      </p>

      {attached === null ? (
        <Skeleton className="h-14 w-full" />
      ) : attached.length === 0 ? (
        <p className="text-xs text-fg-3">No MCP servers attached.</p>
      ) : (
        <div className="space-y-2">
          {attached.map((a) => {
            const t = tests[a.serverSlug];
            return (
              <div key={a.serverSlug} className="rounded-lg border border-line bg-canvas px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <Server className="h-4 w-4 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-fg">{a.serverName}</span>
                      <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] text-fg-2">{a.serverSlug}</span>
                      <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-fg-2">{a.transport}</span>
                      <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-fg-2">auth: {a.authType}</span>
                      {a.category === "custom" && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">yours</span>}
                    </div>
                    {typeof a.config?.vmId === "string" && <p className="mt-0.5 font-mono text-[11px] text-fg-3">sandbox VM {a.config.vmId}</p>}
                  </div>
                  <Button size="sm" variant="secondary" loading={testing === a.serverSlug} onClick={() => test(a.serverSlug)}>Test</Button>
                  <button aria-label={`Detach ${a.serverName}`} onClick={() => detach(a.serverSlug)} className="rounded p-1 text-fg-3 hover:bg-bad-soft hover:text-bad"><X className="h-3 w-3" /></button>
                </div>

                {t?.kind === "auth" && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[11px] text-warn">
                    Not connected yet — this server needs authorization.
                    <Button size="sm" variant="primary" onClick={() => connect(a)}>Connect</Button>
                  </div>
                )}
                {t?.kind === "error" && <p className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-[11px] text-bad">{t.message}</p>}
                {t?.kind === "ok" && (
                  <div className="mt-2 space-y-1">
                    {t.result.tools.length === 0 && <p className="text-[11px] text-fg-3">Connected, but the server lists no tools.</p>}
                    {t.result.tools.map((tool) => (
                      <div key={tool.name} className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="font-mono text-fg-2">{tool.name}</span>
                        <span className={clsx("rounded-full px-1.5 py-0.5 text-[9px] font-medium", tool.allowedByPolicy === false ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok")}>
                          {tool.allowedByPolicy === false ? "blocked by policy" : "allowed"}
                        </span>
                        {tool.allowedByPolicy === false && (
                          <span className="text-fg-3">
                            add <code className="font-mono">{policyEntry(a.serverSlug)}</code> or{" "}
                            <code className="font-mono">{policyEntry(a.serverSlug, tool.name)}</code> to MCP servers in the{" "}
                            <a href={`/agents/${encodeURIComponent(agentName)}?tab=security`} className="text-pal-400 hover:underline">Security tab</a>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={showAttach}
        onClose={() => setShowAttach(false)}
        title="Attach MCP server"
        description="Pick a catalog server or one you registered in Settings → MCP."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowAttach(false)}>Cancel</Button>
            <Button loading={saving} disabled={!picked} onClick={attach}>Attach</Button>
          </>
        }
      >
        <div className="space-y-3">
          <select aria-label="MCP server" value={pick} onChange={(e) => setPick(e.target.value)} className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent">
            <option value="">Select a server…</option>
            {options.some((o) => !o.tenant) && (
              <optgroup label="Catalog">
                {options.filter((o) => !o.tenant).map((o) => <option key={o.slug} value={o.slug}>{o.name} ({o.transport})</option>)}
              </optgroup>
            )}
            {options.some((o) => o.tenant) && (
              <optgroup label="Your servers">
                {options.filter((o) => o.tenant).map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
              </optgroup>
            )}
          </select>
          {stdio && (
            <div>
              <input type="text" aria-label="Sandbox VM id" value={vmId} onChange={(e) => setVmId(e.target.value)} placeholder="Sandbox VM id" className="w-full rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-3 outline-none focus:border-accent" />
              <p className="mt-1 text-[11px] text-fg-3">stdio servers run only inside a sandbox VM, never on the host. Use the id of a running VM from Sandboxes.</p>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
