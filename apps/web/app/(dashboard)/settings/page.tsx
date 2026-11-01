"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useModels } from "@/lib/model-context";
import { format } from "date-fns";
import {
  Settings2,
  Key,
  Users,
  CreditCard,
  Cpu,
  Copy,
  Trash2,
  Check,
  Loader2,
  Save,
  Laptop,
} from "lucide-react";
import clsx from "clsx";
// Mock data imports removed — settings start with empty state when API is available
import { ProviderCard, type ProviderStatus } from "@/components/settings/provider-card";
import { ApiKeyModal } from "@/components/settings/api-key-modal";
import { createApiKey, keyErrorMessage, type NewKeyInput } from "@/lib/api-key-create";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { api } from "@/lib/api";
import type { FleetUsage } from "@/lib/api";
import { useToast } from "@/components/settings/toast";
import { DangerZone } from "./danger-zone";
import { BillingPlans } from "@/components/settings/billing-plans";
import { DevicesTab } from "./devices";
import { Button } from "@/components/button";
import { useAuth } from "@/lib/auth";
import { useCan, useRoleReady, RoleGate } from "@/components/role-gate";
import { settingsTabAllowed } from "@/lib/settings-nav";
import { ACTIONS, ROLES, ROLE_BLURB, actionsFor } from "@/lib/rbac-matrix";
import { ROLE_LABEL, toRole } from "@/lib/rbac";
import { workspaceName } from "@/components/org-switcher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsed: string;
  status: "active" | "revoked";
}


interface GeneralSettings {
  defaultModel: string;
  defaultIsolation: string;
}

interface ProviderSettings {
  openai: { key: string; status: ProviderStatus };
  anthropic: { key: string; status: ProviderStatus };
  google: { key: string; status: ProviderStatus };
}


// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "providers", label: "LLM Providers", icon: Cpu },
  { id: "team", label: "Team", icon: Users },
  { id: "devices", label: "Devices", icon: Laptop },
  { id: "billing", label: "Billing", icon: CreditCard },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ---------------------------------------------------------------------------
// Local storage
// ---------------------------------------------------------------------------

const LS_PREFIX = "pal_settings_";

function loadLS<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try { const raw = localStorage.getItem(LS_PREFIX + key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}

function saveLS<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const defaultGeneral: GeneralSettings = { defaultModel: "auto", defaultIsolation: "standard" };
const defaultProviders: ProviderSettings = { openai: { key: "", status: "not_configured" }, anthropic: { key: "", status: "not_configured" }, google: { key: "", status: "not_configured" } };

const roleBadgeColors: Record<string, string> = { owner: "bg-pal-500/10 text-pal-500", admin: "bg-purple-500/10 text-purple-400", member: "bg-blue-500/10 text-blue-400", viewer: "bg-zinc-500/10 text-zinc-400" };

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { toast } = useToast();
  const { refresh: refreshModels } = useModels();
  const { user } = useAuth();
  const canWrite = useCan("settings:write"); // UX gating (lib/rbac-matrix.ts); the server decides

  // The tab is the URL (?tab=) so the Settings nav (lib/settings-nav) can link
  // straight to it and new settings pages slot in beside it.
  const tabParam = useSearchParams().get("tab");
  const activeTab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : "general";
  const [general, setGeneral] = useState<GeneralSettings>(defaultGeneral);
  const [generalSaving, setGeneralSaving] = useState(false);
  const [keys, setKeys] = useState<StoredApiKey[] | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<StoredApiKey | null>(null);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderSettings>(defaultProviders);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [providersSaving, setProvidersSaving] = useState(false);
  const [fleetUsage, setFleetUsage] = useState<FleetUsage | null>(null);

  // Stripe Checkout/Portal return to /settings?tab=billing; the tab is the URL
  // (lib/settings-nav), so no extra deep-link handling is needed.

  const ready = useRoleReady();
  const tabAllowed = settingsTabAllowed(user?.role, activeTab);

  // Server state is the only source for providers + keys; there is no local
  // copy to clobber it or to show when the API is down (an error is shown).
  useEffect(() => {
    // Older builds kept provider keys, API-key lists, members and a budget in this browser.
    // The server is the only source now; drop the stale copies (they held plaintext provider keys).
    for (const k of ["providers", "api_keys", "members", "billing"]) {
      try { localStorage.removeItem(LS_PREFIX + k); } catch { /* storage unavailable */ }
    }
    // Defaults are the one browser-only setting.
    setGeneral({ ...defaultGeneral, ...loadLS<Partial<GeneralSettings>>("general", {}) });

    (async () => {
      try {
        const realProviders = await api.listLlmProviders();
        const newState = { ...defaultProviders };
        for (const p of realProviders) {
          const key = p.provider as keyof ProviderSettings;
          if (key in newState) {
            newState[key] = { key: p.keyMasked ?? "", status: p.status === "active" ? "connected" as ProviderStatus : "not_configured" as ProviderStatus };
          }
        }
        setProviders(newState);
        setProvidersError(null);
      } catch (e) {
        setProvidersError(e instanceof Error ? e.message : "Could not load providers");
      }
    })();

    (async () => {
      const u = await api.getFleetUsage();
      if (u) setFleetUsage(u);
    })();
  }, []);

  // API keys are owner|admin only on the server, so don't ask as anyone else
  // (it would 403 and read as an outage).
  useEffect(() => {
    if (!user || !canWrite) return;
    (async () => {
      try {
        const realKeys = await api.listApiKeysReal();
        setKeys(
          realKeys.map((k) => ({
            id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes ?? [], createdAt: k.createdAt,
            lastUsed: k.lastUsedAt ?? "Never", status: (k.status === "revoked" ? "revoked" : "active") as "active" | "revoked",
          })),
        );
        setKeysError(null);
      } catch (e) {
        setKeys([]);
        setKeysError(keyErrorMessage(e));
      }
    })();
  }, [user, canWrite]);

  // General
  const handleSaveGeneral = async () => {
    // No backend endpoint for workspace-level defaults yet: this only persists
    // to this browser, and the toast says so.
    setGeneralSaving(true);
    saveLS("general", general);
    setGeneralSaving(false);
    toast("success", "Defaults saved on this device");
  };

  // API keys: the key shown is the one the control plane returned (lib/api-key-create).
  const handleCreateKey = async (input: NewKeyInput) => {
    const out = await createApiKey((i) => api.createApiKeyReal(i), input);
    if (out.kind === "created") {
      setKeys((prev) => [{ id: out.id, name: out.name, prefix: out.prefix, scopes: out.scopes, createdAt: out.createdAt, lastUsed: "Never", status: "active" }, ...(prev ?? [])]);
    }
    return out;
  };

  const handleRevokeKey = async () => {
    if (!revokeTarget) return;
    try {
      await api.revokeApiKeyReal(revokeTarget.id);
      setKeys((prev) => (prev ?? []).map((k) => (k.id === revokeTarget.id ? { ...k, status: "revoked" as const } : k)));
      toast("success", `API key "${revokeTarget.name}" revoked`);
    } catch (e) {
      toast("error", `Could not revoke "${revokeTarget.name}": ${keyErrorMessage(e)}`);
    }
    setRevokeTarget(null);
  };

  const handleCopyPrefix = async (key: StoredApiKey) => {
    await navigator.clipboard.writeText(key.prefix + "...");
    setCopiedKeyId(key.id);
    setTimeout(() => setCopiedKeyId(null), 2000);
  };

  // Providers
  const updateProvider = useCallback((provider: keyof ProviderSettings, key: string) => {
    setProviders((prev) => ({ ...prev, [provider]: { ...prev[provider], key, status: key ? prev[provider].status : "not_configured" as ProviderStatus } }));
  }, []);

  const testProvider = useCallback(async (provider: keyof ProviderSettings): Promise<boolean> => {
    const label = provider.charAt(0).toUpperCase() + provider.slice(1);
    const key = providers[provider].key;
    const fail = (msg: string) => {
      setProviders((prev) => ({ ...prev, [provider]: { ...prev[provider], status: "error" as ProviderStatus } }));
      toast("error", msg);
      return false;
    };
    if (!key || key.length < 10) return fail(`${label} key is too short`);
    // A masked key (already stored) is tested as-is; only a newly typed key is saved first.
    if (!key.includes("****")) {
      try { await api.saveLlmProvider(provider, key); } catch (e) { return fail(`${label} key was not saved: ${e instanceof Error ? e.message : "request failed"}`); }
    }
    try {
      const result = await api.testLlmProvider(provider);
      setProviders((prev) => ({ ...prev, [provider]: { ...prev[provider], status: result.success ? "connected" as ProviderStatus : "error" as ProviderStatus } }));
      if (result.success) toast("success", result.message || `${label} connected`);
      else toast("error", result.error || `${label} key is invalid`);
      return result.success;
    } catch (e) {
      return fail(`Could not test the ${label} key: ${e instanceof Error ? e.message : "request failed"}`);
    }
  }, [providers, toast]);

  const handleSaveProviders = async () => {
    setProvidersSaving(true);
    const failed: string[] = [];
    await Promise.all(
      (Object.keys(providers) as Array<keyof ProviderSettings>).map(async (provider) => {
        const config = providers[provider];
        if (!config.key || config.key.length < 10 || config.key.includes("****")) return; // nothing new to save
        try {
          await api.saveLlmProvider(provider, config.key);
          setProviders((prev) => ({ ...prev, [provider]: { ...prev[provider], status: "connected" as ProviderStatus } }));
        } catch {
          failed.push(provider);
        }
      }),
    );
    setProvidersSaving(false);
    if (failed.length) toast("error", `Could not save: ${failed.join(", ")}`);
    else toast("success", "Provider settings saved");
    refreshModels();
  };

  return (
    <div>
      <div className="w-full max-w-3xl">
          {!ready && <p className="text-sm text-zinc-500">Loading…</p>}
          {ready && !tabAllowed && (
            <div role="status" className="rounded-xl border border-zinc-800 bg-surface-1 p-5 text-sm text-zinc-400">
              This section is for workspace owners and admins. Your role is {ROLE_LABEL[toRole(user?.role)]}.
            </div>
          )}
          {ready && tabAllowed && activeTab === "general" && <GeneralTab general={general} setGeneral={setGeneral} saving={generalSaving} onSave={handleSaveGeneral} />}
          {ready && tabAllowed && activeTab === "api-keys" && <ApiKeysTab keys={keys} error={keysError} copiedKeyId={copiedKeyId} onCreateClick={() => setShowCreateKey(true)} onCopyPrefix={handleCopyPrefix} onRevokeClick={setRevokeTarget} />}
          {ready && tabAllowed && activeTab === "providers" && <ProvidersTab providers={providers} error={providersError} canWrite={canWrite} saving={providersSaving} onKeyChange={updateProvider} onTest={testProvider} onSave={handleSaveProviders} />}
          {ready && tabAllowed && activeTab === "team" && <TeamTab />}
          {ready && tabAllowed && activeTab === "devices" && <DevicesTab />}
          {ready && tabAllowed && activeTab === "billing" && <BillingTab fleetUsage={fleetUsage} />}
      </div>

      {/* Modals */}
      <ApiKeyModal open={showCreateKey} onClose={() => setShowCreateKey(false)} onCreate={handleCreateKey} />
      <ConfirmDialog open={!!revokeTarget} title="Revoke API key" message={`Revoke "${revokeTarget?.name}"? Anything using this key stops working immediately.`} confirmLabel="Revoke key" destructive onConfirm={handleRevokeKey} onCancel={() => setRevokeTarget(null)} />
    </div>
  );
}

// ===========================================================================
// General Tab
// ===========================================================================

function GeneralTab({ general, setGeneral, saving, onSave }: { general: GeneralSettings; setGeneral: (g: GeneralSettings) => void; saving: boolean; onSave: () => void }) {
  const { user } = useAuth();
  return (
    <div className="space-y-5 pb-24">
      <SettingsSection
        title="Workspace"
        description="This workspace, as the control plane sees you. Read-only: renaming and switching workspaces need an organization endpoint that does not exist yet."
      >
        <Field label="Workspace">
          <p className="text-sm text-zinc-100">{workspaceName(user?.name, user?.email)}</p>
        </Field>
        <Field label="Signed in as" hint={`Role: ${ROLE_LABEL[toRole(user?.role)]}`}>
          <p className="text-sm text-zinc-100">{user?.email ?? "-"}</p>
        </Field>
        <Field label="Workspace ID">
          <div className="flex gap-2">
            <input
              type="text"
              value={user?.tenantId ?? ""}
              readOnly
              aria-label="Workspace ID"
              className="flex-1 rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 font-mono text-xs text-zinc-400 outline-none cursor-default"
            />
            <Button
              variant="secondary"
              size="md"
              icon={<Copy className="h-3.5 w-3.5" />}
              disabled={!user?.tenantId}
              onClick={() => { void navigator.clipboard.writeText(user?.tenantId ?? ""); }}
            >
              Copy
            </Button>
          </div>
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Defaults"
        description="Saved in this browser only. New agents don't read these defaults yet."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Default model preference"
            hint="The model router will use this unless overridden per-agent."
          >
            <select
              value={general.defaultModel}
              onChange={(e) => setGeneral({ ...general, defaultModel: e.target.value })}
              className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-pal-500/60"
            >
              <option value="auto">Auto (recommended)</option>
              <option value="reasoning-large">Reasoning Large</option>
              <option value="reasoning-small">Reasoning Small</option>
              <option value="chat-large">Chat Large</option>
              <option value="chat-small">Chat Small</option>
              <option value="code-large">Code Large</option>
            </select>
          </Field>
          <Field
            label="Default isolation class"
            hint="Untrusted code always runs in a microVM regardless of this setting."
          >
            <select
              value={general.defaultIsolation}
              onChange={(e) => setGeneral({ ...general, defaultIsolation: e.target.value })}
              className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-pal-500/60"
            >
              <option value="trusted">Trusted — shared namespace</option>
              <option value="standard">Standard — isolated pod</option>
              <option value="untrusted">Untrusted — microVM (Firecracker)</option>
            </select>
          </Field>
        </div>
      </SettingsSection>

      <RoleGate cap="owner">
        <DangerZone />
      </RoleGate>

      {/* Sticky save bar — pinned to the bottom of the viewport so it's
          always reachable, never orphaned to the bottom-right of a card. */}
      <StickySaveBar saving={saving} onSave={onSave} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared settings primitives — reused across every tab so the visual
// rhythm is consistent.
// ---------------------------------------------------------------------------

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-surface-1 p-5 md:p-6">
      <header className="mb-4">
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        {description && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">
            {description}
          </p>
        )}
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-zinc-300">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[12px] text-zinc-500">{hint}</p>}
    </div>
  );
}

function StickySaveBar({ saving, onSave }: { saving: boolean; onSave: () => void }) {
  return (
    <div className="pointer-events-none sticky bottom-0 -mx-6 mt-6 flex justify-end px-6 pb-4 md:-mx-8 md:px-8">
      <div className="pointer-events-auto inline-flex items-center gap-3 rounded-xl border border-zinc-800 bg-surface-1/95 px-4 py-2 shadow-xl backdrop-blur-md">
        <span className="text-[12px] text-zinc-500">Unsaved changes</span>
        <Button
          variant="primary"
          size="md"
          loading={saving}
          icon={<Save className="h-3.5 w-3.5" />}
          onClick={onSave}
        >
          Save changes
        </Button>
      </div>
    </div>
  );
}

// ===========================================================================
// API Keys Tab
// ===========================================================================

function ApiKeysTab({ keys: keysOrNull, error, copiedKeyId, onCreateClick, onCopyPrefix, onRevokeClick }: { keys: StoredApiKey[] | null; error: string | null; copiedKeyId: string | null; onCreateClick: () => void; onCopyPrefix: (key: StoredApiKey) => void; onRevokeClick: (key: StoredApiKey) => void }) {
  const keys = keysOrNull ?? [];
  const activeKeys = keys.filter((k) => k.status === "active");
  const revokedKeys = keys.filter((k) => k.status === "revoked");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">API Keys</h3>
          <p className="mt-0.5 text-xs text-zinc-500">Manage keys used to authenticate with the PAL API.</p>
        </div>
        <button onClick={onCreateClick} className="inline-flex items-center gap-2 rounded-lg bg-pal-500 px-3 py-1.5 text-sm font-medium text-on-flame transition-colors hover:bg-pal-400">Create API Key</button>
      </div>

      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">Could not load API keys: {error}</p>}
      {keysOrNull === null && !error && <p className="text-xs text-zinc-500">Loading keys…</p>}

      {/* Desktop: table, unchanged */}
      <div className="hidden overflow-hidden rounded-xl border border-zinc-800 bg-surface-1 md:block">
        <table className="data-table">
          <thead><tr><th>Name</th><th>Key Prefix</th><th>Scopes</th><th>Created</th><th>Last Used</th><th>Status</th><th className="w-24"></th></tr></thead>
          <tbody>
            {activeKeys.length === 0 && <tr><td colSpan={7} className="text-center text-zinc-500 py-8">No active API keys. Create one to get started.</td></tr>}
            {activeKeys.map((key) => (
              <tr key={key.id}>
                <td className="font-medium text-zinc-300">{key.name}</td>
                <td>
                  <div className="flex items-center gap-1.5">
                    <code className="rounded bg-surface-3 px-2 py-0.5 font-mono text-xs text-zinc-400">{key.prefix}...</code>
                    <button onClick={() => onCopyPrefix(key)} className="text-zinc-600 transition-colors hover:text-zinc-400">
                      {copiedKeyId === key.id ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </td>
                <td><div className="flex flex-wrap gap-1">{key.scopes.map((s) => <span key={s} className="rounded bg-surface-3 px-1.5 py-0.5 text-[12px] text-zinc-500">{s}</span>)}</div></td>
                <td className="text-zinc-500">{format(new Date(key.createdAt), "MMM d, yyyy")}</td>
                <td className="text-zinc-500">{key.lastUsed}</td>
                <td><span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Active</span></td>
                <td><button onClick={() => onRevokeClick(key)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/10"><Trash2 className="h-3 w-3" />Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards, same data */}
      <div className="space-y-2 md:hidden">
        {activeKeys.length === 0 && (
          <div className="rounded-xl border border-zinc-800 bg-surface-1 py-8 text-center text-sm text-zinc-500">
            No active API keys. Create one to get started.
          </div>
        )}
        {activeKeys.map((key) => (
          <div key={key.id} className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-zinc-300">{key.name}</span>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Active
              </span>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <code className="rounded bg-surface-3 px-2 py-0.5 font-mono text-xs text-zinc-400">{key.prefix}...</code>
              <button onClick={() => onCopyPrefix(key)} className="text-zinc-600 transition-colors hover:text-zinc-400">
                {copiedKeyId === key.id ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
            {key.scopes.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {key.scopes.map((s) => <span key={s} className="rounded bg-surface-3 px-1.5 py-0.5 text-[12px] text-zinc-500">{s}</span>)}
              </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
              <div>
                <p className="text-[12px] uppercase tracking-wide text-zinc-500">Created</p>
                <p className="text-xs text-zinc-200">{format(new Date(key.createdAt), "MMM d, yyyy")}</p>
              </div>
              <div>
                <p className="text-[12px] uppercase tracking-wide text-zinc-500">Last used</p>
                <p className="text-xs text-zinc-200">{key.lastUsed}</p>
              </div>
            </div>
            <button
              onClick={() => onRevokeClick(key)}
              className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg py-2 text-xs text-red-400 transition-colors hover:bg-red-500/10"
            >
              <Trash2 className="h-3 w-3" />Revoke
            </button>
          </div>
        ))}
      </div>

      {revokedKeys.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Revoked Keys</h4>
          {/* Desktop: table, unchanged */}
          <div className="hidden overflow-hidden rounded-xl border border-zinc-800 bg-surface-1 opacity-60 md:block">
            <table className="data-table"><tbody>
              {revokedKeys.map((key) => (
                <tr key={key.id}><td className="font-medium text-zinc-500">{key.name}</td><td><code className="rounded bg-surface-3 px-2 py-0.5 font-mono text-xs text-zinc-600 line-through">{key.prefix}...</code></td><td className="text-zinc-600">Revoked</td></tr>
              ))}
            </tbody></table>
          </div>
          {/* Mobile: stacked cards, same data */}
          <div className="space-y-2 opacity-60 md:hidden">
            {revokedKeys.map((key) => (
              <div key={key.id} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-surface-1 p-4">
                <span className="truncate text-sm font-medium text-zinc-500">{key.name}</span>
                <code className="rounded bg-surface-3 px-2 py-0.5 font-mono text-xs text-zinc-600 line-through">{key.prefix}...</code>
                <span className="text-xs text-zinc-600">Revoked</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Providers Tab
// ===========================================================================

function ProvidersTab({ providers, error, canWrite, saving, onKeyChange, onTest, onSave }: { providers: ProviderSettings; error: string | null; canWrite: boolean; saving: boolean; onKeyChange: (p: keyof ProviderSettings, k: string) => void; onTest: (p: keyof ProviderSettings) => Promise<boolean>; onSave: () => void }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">LLM Providers</h3>
        <p className="mt-0.5 text-xs text-zinc-500">Configure API keys for LLM providers. The model router maps capability requests to these.</p>
      </div>

      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">Could not load providers: {error}</p>}

      {!canWrite ? (
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-surface-1">
          {([["OpenAI", providers.openai], ["Anthropic", providers.anthropic], ["Google AI", providers.google]] as const).map(([label, p]) => (
            <li key={label} className="flex items-center justify-between px-4 py-3 text-sm">
              <span className="text-zinc-200">{label}</span>
              <span className={p.status === "connected" ? "text-emerald-400" : "text-zinc-500"}>{p.status === "connected" ? "Connected" : "Not configured"}</span>
            </li>
          ))}
          <li className="px-4 py-3 text-xs text-zinc-500">Only an owner or admin can change provider keys.</li>
        </ul>
      ) : (<>
      <ProviderCard name="OpenAI" description="GPT and o-series models" icon={<span className="text-sm font-bold text-emerald-400">AI</span>} apiKey={providers.openai.key} status={providers.openai.status} onApiKeyChange={(k) => onKeyChange("openai", k)} onTest={() => onTest("openai")} />
      <ProviderCard name="Anthropic" description="Claude models" icon={<span className="text-sm font-bold text-orange-400">A</span>} apiKey={providers.anthropic.key} status={providers.anthropic.status} onApiKeyChange={(k) => onKeyChange("anthropic", k)} onTest={() => onTest("anthropic")} />
      <ProviderCard name="Google AI" description="Key is stored, but runs don't route to Gemini yet" icon={<span className="text-sm font-bold text-blue-400">G</span>} apiKey={providers.google.key} status={providers.google.status} onApiKeyChange={(k) => onKeyChange("google", k)} onTest={() => onTest("google")} />

      <div className="rounded-lg border border-zinc-800 bg-surface-2 px-4 py-3">
        <p className="text-xs text-zinc-500">Keys are encrypted at rest and only decrypted inside the microVM runtime at execution time.</p>
      </div>

      <div className="flex justify-end">
        <button onClick={onSave} disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-pal-500 px-4 py-2 text-sm font-medium text-on-flame transition-colors hover:bg-pal-400 disabled:opacity-50 disabled:cursor-not-allowed">
          {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving...</> : <><Save className="h-3.5 w-3.5" />Save Changes</>}
        </button>
      </div>
      </>)}
    </div>
  );
}

// ===========================================================================
// Team Tab
// ===========================================================================
//
// Honest by construction: the control plane has no members/invitations
// endpoint (routes: none under /v1/team|members|users), so there is nothing to
// list, invite or remove. This tab shows what IS real - who you are, how people
// can join (GET /auth/providers `signup`), and what each role is offered.

const SIGNUP_COPY: Record<string, string> = {
  open: "Anyone can create an account on this deployment.",
  invite: "Sign-up needs an invite code that the operator hands out.",
  closed: "Sign-up is closed; accounts are created by the operator.",
};

function TeamTab() {
  const { user } = useAuth();
  const [signup, setSignup] = useState<string | null>(null);
  useEffect(() => {
    void api.getAuthProviders().then((p) => setSignup(p?.signup ?? null));
  }, []);
  const role = toRole(user?.role);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Team</h3>
        <p className="mt-0.5 text-xs text-zinc-500">Who can do what in this workspace.</p>
      </div>

      <section className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
        <p className="text-xs text-zinc-500">You</p>
        <p className="mt-1 text-sm font-medium text-zinc-100">{user?.name || user?.email || "-"}</p>
        <p className="text-xs text-zinc-400">{user?.email}</p>
        <span className={clsx("mt-2 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium", roleBadgeColors[role] ?? "bg-zinc-500/10 text-zinc-400")}>{ROLE_LABEL[role]}</span>
        <p className="mt-2 text-xs text-zinc-500">{ROLE_BLURB[role]} You are offered {actionsFor(role).length} of {ACTIONS.length} tracked actions.</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-surface-1 p-5" data-testid="members-slot">
        <h4 className="text-sm font-semibold text-zinc-100">Members and invitations</h4>
        <p className="mt-1 text-xs text-zinc-400">
          Not available yet: the control plane has no members or invitations API, so this page cannot list, invite or remove people, or change a role.
          {signup && <> {SIGNUP_COPY[signup] ?? ""}</>}
        </p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
        <h4 className="text-sm font-semibold text-zinc-100">What each role is offered</h4>
        <p className="mt-1 text-xs text-zinc-500">The dashboard hides actions a role cannot use. This is a convenience, not a security boundary: the server enforces what it enforces (API keys, billing, approvals: owner or admin; erasing the workspace: owner).</p>
        <ul className="mt-3 divide-y divide-zinc-800">
          {ROLES.map((r) => (
            <li key={r} className="flex items-start justify-between gap-4 py-2.5">
              <div>
                <p className="text-sm text-zinc-200">{ROLE_LABEL[r]}</p>
                <p className="text-xs text-zinc-500">{ROLE_BLURB[r]}</p>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">{actionsFor(r).length}/{ACTIONS.length}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ===========================================================================
// Billing Tab
// ===========================================================================
//
// Plans are live (ADR 0049, BillingPlans). Spend caps live under Budgets; the
// old sample-usage card and the browser-only "monthly budget" were removed
// because they were not backed by anything.

function BillingTab({ fleetUsage }: { fleetUsage: FleetUsage | null }) {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">Plan</h3>
        <BillingPlans />
      </div>

      <div>
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">Cost by agent</h3>
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
          {fleetUsage ? (
            <>
              <table className="data-table hidden md:table">
                <thead><tr><th>Agent</th><th>Runs</th><th>Cost</th></tr></thead>
                <tbody>
                  {[...fleetUsage.byAgent].sort((a, b) => b.costUsd - a.costUsd).map((row) => (
                    <tr key={row.agentName}>
                      <td className="font-medium text-zinc-300">{row.agentName}</td>
                      <td className="text-zinc-400">{row.runs}</td>
                      <td className="font-medium text-zinc-200">${row.costUsd.toFixed(2)}</td>
                    </tr>
                  ))}
                  {fleetUsage.byAgent.length === 0 && (
                    <tr><td colSpan={3} className="text-center text-zinc-500">No agent cost data yet</td></tr>
                  )}
                  {fleetUsage.byAgent.length > 0 && (
                    <tr className="border-t border-zinc-700">
                      <td className="font-semibold text-zinc-100">Total</td>
                      <td className="text-zinc-400">{fleetUsage.periods.total.runs}</td>
                      <td className="font-semibold text-pal-400">${fleetUsage.periods.total.costUsd.toFixed(2)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="divide-y divide-zinc-800 md:hidden">
                {fleetUsage.byAgent.length === 0 && <p className="py-6 text-center text-sm text-zinc-500">No agent cost data yet</p>}
                {[...fleetUsage.byAgent].sort((a, b) => b.costUsd - a.costUsd).map((row) => (
                  <div key={row.agentName} className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-300">{row.agentName}</p>
                      <p className="text-[12px] text-zinc-500">{row.runs} runs</p>
                    </div>
                    <span className="text-sm font-medium text-zinc-200">${row.costUsd.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">Cost data is unavailable right now.</p>
          )}
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        Spend caps and hard limits are per agent and workspace-wide under <Link href="/budgets" className="text-pal-400 hover:underline">Budgets</Link>.
      </p>
    </div>
  );
}
