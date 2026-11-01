"use client";

import { useCan } from "@/components/role-gate";
import { useCallback, useEffect, useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { api, type McpCredential, type McpTenantServer } from "@/lib/api";
import { SLUG_RE, mcpEndpoint, parseApiError } from "@/lib/mcp";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Modal } from "@/components/modal";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/settings/toast";

const inputCls = "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 outline-none focus:border-accent";
const card = "rounded-xl border border-line bg-panel p-5";

export default function McpSettingsPage() {
  const canWrite = useCan("connectors:write"); // UX gating (lib/rbac-matrix.ts)
  const { toast } = useToast();
  const [servers, setServers] = useState<McpTenantServer[] | null>(null);
  const [creds, setCreds] = useState<McpCredential[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ slug: "", name: "", url: "", authType: "none" as McpTenantServer["authType"] });
  const [saving, setSaving] = useState(false);
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.listMcpTenantServers(), api.listMcpCredentials()]);
      setServers(s); setCreds(c);
    } catch (e) {
      setServers([]);
      toast("error", `Could not load MCP settings — ${parseApiError(e).message}`);
    }
  }, [toast]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  const add = async () => {
    if (!SLUG_RE.test(form.slug)) { toast("error", "Slug: lowercase letters, digits and dashes"); return; }
    if (!form.url.trim()) { toast("error", "URL is required"); return; }
    setSaving(true);
    try {
      await api.createMcpTenantServer({ slug: form.slug, name: form.name || undefined, url: form.url.trim(), authType: form.authType });
      toast("success", `${form.slug} registered`);
      setShowAdd(false);
      setForm({ slug: "", name: "", url: "", authType: "none" });
      await load();
    } catch (e) {
      toast("error", parseApiError(e).message);
    } finally { setSaving(false); }
  };

  const remove = async (slug: string) => {
    try { await api.deleteMcpTenantServer(slug); toast("success", `${slug} removed`); await load(); }
    catch (e) { toast("error", parseApiError(e).message); }
  };

  const oauth = async (slug: string) => {
    try { window.location.href = (await api.startMcpOAuth(slug)).authorizationUrl; }
    catch (e) { toast("error", parseApiError(e).message); }
  };

  const saveToken = async () => {
    if (!tokenFor || !token) return;
    try {
      await api.setMcpBearerToken(tokenFor, token);
      toast("success", "Token stored");
      setTokenFor(null); setToken("");
      await load();
    } catch (e) { toast("error", parseApiError(e).message); }
  };

  const dropCred = async (slug: string) => {
    try { await api.deleteMcpCredential(slug); toast("success", "Credential deleted"); await load(); }
    catch (e) { toast("error", parseApiError(e).message); }
  };

  const endpoint = mcpEndpoint(api.apiBaseUrl);

  return (
    <div className="space-y-6">
      <section className={card}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">Your MCP servers</h2>
            <p className="mt-1 text-[11px] text-fg-3">Remote (HTTPS) servers you register. Attach them to agents from the agent page.</p>
          </div>
          {canWrite && <Button size="sm" className="shrink-0 whitespace-nowrap" icon={<Plus className="h-3 w-3" />} onClick={() => setShowAdd(true)}>Add server</Button>}
        </div>
        <div className="mt-4 space-y-2">
          {servers === null ? <Skeleton className="h-14 w-full" /> : servers.length === 0 ? (
            <EmptyState size="compact" title="No servers yet" description="Register a remote MCP server to use it with your agents." actionLabel={canWrite ? "Add server" : undefined} onAction={canWrite ? () => setShowAdd(true) : undefined} />
          ) : servers.map((s) => (
            <div key={s.slug} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5">
              <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                <p className="text-xs font-medium text-fg">{s.name || s.slug} <span className="font-mono text-[10px] text-fg-3">{s.slug}</span></p>
                <p className="truncate font-mono text-[11px] text-fg-3">{s.url}</p>
              </div>
              <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-fg-2">auth: {s.authType}</span>
              {canWrite && s.authType === "oauth" && <Button size="sm" variant="secondary" onClick={() => oauth(s.slug)}>Connect with OAuth</Button>}
              {canWrite && s.authType === "bearer" && <Button size="sm" variant="secondary" onClick={() => setTokenFor(s.slug)}>Set token</Button>}
              {canWrite && <button aria-label={`Remove ${s.slug}`} onClick={() => remove(s.slug)} className="rounded p-1 text-fg-3 hover:bg-bad-soft hover:text-bad"><Trash2 className="h-3.5 w-3.5" /></button>}
            </div>
          ))}
        </div>
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold text-fg">Credentials</h2>
        <p className="mt-1 text-[11px] text-fg-3">Metadata only — secrets are never shown. Catalog servers that need a token can be set here too.</p>
        <div className="mt-4 space-y-2">
          {creds.length === 0 ? <p className="text-xs text-fg-3">No stored credentials.</p> : creds.map((c) => (
            <div key={c.serverSlug} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs">
              <span className="font-mono text-fg">{c.serverSlug}</span>
              <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-fg-2">{c.kind}</span>
              {c.scope && <span className="text-[11px] text-fg-3">scope: {c.scope}</span>}
              {c.expiresAt && <span className="text-[11px] text-fg-3">expires {new Date(c.expiresAt).toLocaleString()}</span>}
              <span className="ml-auto text-[11px] text-fg-3">updated {new Date(c.updatedAt).toLocaleString()}</span>
              {canWrite && <button aria-label={`Delete credential for ${c.serverSlug}`} onClick={() => dropCred(c.serverSlug)} className="rounded p-1 text-fg-3 hover:bg-bad-soft hover:text-bad"><Trash2 className="h-3.5 w-3.5" /></button>}
            </div>
          ))}
        </div>
        {canWrite && <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={() => setTokenFor("")}>Set a token for another server</Button>
        </div>}
      </section>

      <section className={card}>
        <h2 className="text-sm font-semibold text-fg">Use PAL as an MCP server</h2>
        <p className="mt-1 text-[11px] text-fg-3">Connect Claude Desktop or any Streamable-HTTP MCP client to your agents.</p>
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{endpoint}</code>
          <button aria-label="Copy endpoint" onClick={() => { void navigator.clipboard?.writeText(endpoint); toast("success", "Endpoint copied"); }} className="rounded p-1 text-fg-3 hover:text-fg"><Copy className="h-3.5 w-3.5" /></button>
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[11px] text-fg-2">
          <li>Authenticate with <code className="font-mono">Authorization: Bearer &lt;API key&gt;</code>. Create the key in <a className="text-pal-400 hover:underline" href="/settings?tab=api-keys">API keys</a> with the <code className="font-mono">mcp</code> scope; dashboard sessions and unrestricted keys are refused.</li>
          <li>Tools follow the key&apos;s other scopes: <code className="font-mono">agents:read</code> (list_agents), <code className="font-mono">runs:read</code> (get_run), <code className="font-mono">runs:execute</code> (run_agent and agent tools).</li>
          <li>To expose an agent as its own tool, give it the label <code className="font-mono">mcp=expose</code>.</li>
        </ul>
      </section>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add MCP server" description="HTTPS only in production; private and metadata addresses are refused."
        footer={<><Button variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button><Button loading={saving} onClick={add}>Add</Button></>}>
        <div className="space-y-2">
          <input className={inputCls} aria-label="Slug" placeholder="slug (e.g. my-tools)" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
          <input className={inputCls} aria-label="Name" placeholder="Display name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={`${inputCls} font-mono`} aria-label="URL" placeholder="https://mcp.example.com/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <select className={inputCls} aria-label="Auth" value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as McpTenantServer["authType"] })}>
            <option value="none">No auth</option>
            <option value="bearer">Bearer token</option>
            <option value="oauth">OAuth 2.1</option>
          </select>
        </div>
      </Modal>

      <Modal open={tokenFor !== null} onClose={() => { setTokenFor(null); setToken(""); }} title="Set bearer token" description="Stored encrypted; it is never shown again."
        footer={<><Button variant="ghost" onClick={() => { setTokenFor(null); setToken(""); }}>Cancel</Button><Button disabled={!token || !tokenFor} onClick={saveToken}>Save token</Button></>}>
        <div className="space-y-2">
          {tokenFor === "" && <input className={inputCls} aria-label="Server slug" placeholder="Server slug" onChange={(e) => setTokenFor(e.target.value || "")} />}
          {tokenFor !== "" && <p className="font-mono text-xs text-fg-2">{tokenFor}</p>}
          <input type="password" autoComplete="off" className={inputCls} aria-label="Token" placeholder="Token" value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
      </Modal>
    </div>
  );
}
