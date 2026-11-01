"use client";

// Agent detail -> A2A card, live from the control plane (ADR 0057). Read-only:
// the card is derived server-side from the agent, so there is nothing to
// "publish" here. Visibility is the server's call: this workspace always sees its
// own agents' cards; anyone else gets a card only for an is_public agent, and a
// 404 never says which case it was. The dashboard can neither read nor set
// is_public today, so it does not claim either.

import { useCallback, useEffect, useState } from "react";
import { Copy, Network, RefreshCw } from "lucide-react";
import { runtimeApi, HttpError, UnauthorizedError } from "@/lib/runtime-api";
import { a2aCardPath, classifyCardFailure, parseA2aCard, parseIdentityCard, type A2aCard, type CardFailure } from "@/lib/a2a";
import { parseApiError } from "@/lib/mcp";
import { Button } from "@/components/button";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";

type State =
  | { kind: "loading" }
  | { kind: "ok"; card: A2aCard; spiffeId?: string; jwksUri?: string }
  | CardFailure;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-start gap-3 text-xs">
      <span className="pt-0.5 text-fg-3">{label}</span>
      <div className="min-w-0 break-words text-fg-2">{children}</div>
    </div>
  );
}

function Pill({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span className={on ? "rounded-full bg-ok-soft px-2 py-0.5 text-[10px] font-medium text-ok" : "rounded-full bg-raised px-2 py-0.5 text-[10px] text-fg-3"}>
      {children}
    </span>
  );
}

export function AgentA2aCard({ name }: { name: string }) {
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      // The older /card carries the identity ids; the spec card is the one that must load.
      const [specRaw, legacyRaw] = await Promise.all([
        runtimeApi.get<unknown>(a2aCardPath(name)),
        runtimeApi.get<unknown>(`/v1/agents/${encodeURIComponent(name)}/card`).catch((): unknown => null),
      ]);
      const card = parseA2aCard(specRaw);
      if (!card) {
        setState({ kind: "malformed" });
        return;
      }
      setState({ kind: "ok", card, ...parseIdentityCard(legacyRaw) });
    } catch (err) {
      if (err instanceof UnauthorizedError) return; // the api layer is already redirecting to /login
      const pe = parseApiError(err);
      setState(classifyCardFailure(err instanceof HttpError ? err.status : pe.status, pe.code, pe.message));
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text);
    toast.success(`${what} copied`);
  };

  return (
    <div className="space-y-4 rounded-xl border border-line bg-panel p-5" data-testid="a2a-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold text-fg">A2A agent card</h3>
          {state.kind === "ok" && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">A2A v{state.card.protocolVersion}</span>
          )}
        </div>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3 w-3" />} onClick={() => void load()} aria-label="Reload card">
          Reload
        </Button>
      </div>
      <p className="text-[11px] text-fg-3">
        How other agents discover and call this one. Generated from the agent, so it is always current. Your workspace always sees
        its own agents&apos; cards; other workspaces and anonymous callers get one only if the agent is marked public, which the
        dashboard cannot read or change yet.
      </p>

      {state.kind === "loading" && <Skeleton className="h-24 w-full" />}

      {state.kind === "not_visible" && (
        <p role="status" className="rounded-lg bg-raised px-3 py-2 text-xs text-fg-2">
          No card is available for this agent right now.
        </p>
      )}
      {state.kind === "needs_base_url" && (
        <p role="alert" className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          Cards are disabled until the operator sets <code className="font-mono">PAL_PUBLIC_BASE_URL</code>; the card URL must not come from request headers in production.
        </p>
      )}
      {state.kind === "malformed" && (
        <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">The control plane returned a card the dashboard could not read.</p>
      )}
      {state.kind === "error" && (
        <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">Could not load the card: {state.message}</p>
      )}

      {state.kind === "ok" && (
        <div className="space-y-3">
          <Row label="Endpoint">
            <span className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-fg" title={state.card.url}>{state.card.url}</code>
              <button type="button" aria-label="Copy endpoint" onClick={() => copy(state.card.url, "Endpoint")} className="rounded p-1 text-fg-3 hover:text-fg">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </span>
          </Row>
          <Row label="Version">{state.card.version || "unreleased"} · {state.card.preferredTransport}</Row>
          {state.card.description && <Row label="Description">{state.card.description}</Row>}
          <Row label="Capabilities">
            <span className="flex flex-wrap gap-1.5">
              <Pill on={state.card.capabilities.streaming}>streaming</Pill>
              <Pill on={state.card.capabilities.pushNotifications}>push notifications</Pill>
              <Pill on={state.card.capabilities.stateTransitionHistory}>state history</Pill>
            </span>
          </Row>
          <Row label="Skills">
            {state.card.skills.length === 0 ? (
              <span className="text-fg-3">none declared</span>
            ) : (
              <ul className="space-y-1">
                {state.card.skills.map((s) => (
                  <li key={s.id}>
                    <span className="font-medium text-fg">{s.name}</span>
                    {s.description && <span className="text-fg-3"> · {s.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Row>
          <Row label="Auth">
            {state.card.securitySchemes.length === 0 ? (
              <span className="text-fg-3">none advertised</span>
            ) : (
              <ul className="space-y-1">
                {state.card.securitySchemes.map((s) => (
                  <li key={s.name}>
                    <span className="font-mono text-fg">{s.name}</span> <span className="text-fg-3">({s.type}){s.description ? ` · ${s.description}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </Row>
          <Row label="Modes">in {state.card.defaultInputModes.join(", ") || "-"} · out {state.card.defaultOutputModes.join(", ") || "-"}</Row>
          {state.spiffeId && (
            <Row label="Identity">
              <code className="break-all font-mono text-fg">{state.spiffeId}</code>
              {state.jwksUri && <span className="block text-fg-3">verifying keys: <code className="font-mono">{state.jwksUri}</code></span>}
            </Row>
          )}
        </div>
      )}
    </div>
  );
}
