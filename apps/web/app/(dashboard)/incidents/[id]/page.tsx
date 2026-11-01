"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Undo2 } from "lucide-react";
import { api, type Incident } from "@/lib/api";
import { apiErrorText, incidentActions, incidentTone, kindLabel, wasRolledBack } from "@/lib/observability";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/button";
import { ConfirmCard } from "@/components/confirm-card";
import { useCan } from "@/components/role-gate";
import { DebugThis } from "@/components/debug-panel";
import { Skeleton } from "@/components/skeleton";
import { TonePill } from "@/components/tone-pill";
import { useToast } from "@/components/toast";

const AFFECTED_SHOWN = 40;

export default function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const toast = useToast();
  const [inc, setInc] = useState<Incident | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  // Ack / resolve / rollback are agents:write on the server; a read-only role is shown the facts, not the buttons.
  const canWrite = useCan("agents:write");

  const load = useCallback(async () => {
    try {
      setInc(await api.getIncident(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load incident");
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const rollback = async () => {
    if (!inc) return;
    setBusy("rollback");
    try {
      const r = await api.rollbackIncident(id);
      setInc(r.incident);
      setConfirmRollback(false);
      toast.success(`Prod now serves ${r.rollback.version}`);
    } catch (e) {
      toast.error(apiErrorText(e, "Rollback failed"));
      void load();
    } finally {
      setBusy(null);
    }
  };

  const act = async (action: "acknowledge" | "resolve") => {
    setBusy(action);
    try {
      setInc(await api.transitionIncident(id, action, note.trim() || undefined));
      setNote("");
      toast.success(action === "acknowledge" ? "Incident acknowledged" : "Incident resolved");
    } catch (e) {
      toast.error(apiErrorText(e, "Update failed"));
      void load();
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm font-medium text-fg-2">Incident not found</p>
        <p className="max-w-sm text-xs text-fg-3">{error}</p>
        <Link href="/incidents" className="text-sm text-accent hover:underline">
          Back to incidents
        </Link>
      </div>
    );
  }
  if (!inc) {
    return (
      <div className="space-y-3 p-8">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const actions = incidentActions(inc.status);
  const findings = Array.isArray((inc.evidence as { findings?: unknown[] }).findings)
    ? ((inc.evidence as { findings: { metric: string; version: string; baseline: number; observed: number; z: number; n: number }[] }).findings)
    : [];

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title={inc.title}
        description={`${kindLabel(inc.kind)} on ${inc.agentName}`}
        badge={<TonePill tone={incidentTone(inc)}>{inc.status === "resolved" ? "resolved" : `${inc.severity} · ${inc.status}`}</TonePill>}
      />
      <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-6 md:px-8">
        <Link href="/incidents" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2">
          <ArrowLeft className="h-3 w-3" /> All incidents
        </Link>

        {canWrite && inc.rollback.suggested && inc.status !== "resolved" && !wasRolledBack(inc) && (
          <div role="note" className="flex items-start gap-3 rounded-[12px] border border-warn/40 bg-warn-soft p-4">
            <Undo2 className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <div className="text-sm">
              <p className="font-medium text-warn">
                Rollback suggested: <span className="font-mono">{inc.rollback.fromVersion}</span> to{" "}
                <span className="font-mono">{inc.rollback.toVersion}</span>
              </p>
              <p className="mt-1 text-xs text-fg-3">
                The previous version was healthy before this shift. The rollback runs through promotions and is audited in both places.
              </p>
              {canWrite && !confirmRollback && (
                <Button variant="danger" size="sm" className="mt-3" onClick={() => setConfirmRollback(true)}>
                  Roll back prod to {inc.rollback.toVersion}
                </Button>
              )}
              {canWrite && confirmRollback && (
                <div className="mt-3">
                  <ConfirmCard
                    title={`POST /v1/incidents/${inc.id.slice(0, 8)}…/rollback`}
                    confirmLabel="Roll back prod"
                    tone="danger"
                    working={busy === "rollback"}
                    onConfirm={() => void rollback()}
                    onCancel={() => setConfirmRollback(false)}
                  >
                    <p className="text-[12.5px] text-fg-2">
                      Prod switches from <span className="font-mono">{inc.rollback.fromVersion}</span> to{" "}
                      <span className="font-mono">{inc.rollback.toVersion}</span> through the promotion machinery, and is audited there and on this incident.
                    </p>
                  </ConfirmCard>
                </div>
              )}
            </div>
          </div>
        )}

        {wasRolledBack(inc) && (
          <p role="status" className="rounded-[12px] border border-ok/40 bg-ok-soft p-3 text-sm text-ok">
            Prod was rolled back for this incident. Resolve it once you have confirmed the agent is healthy.
          </p>
        )}

        <section aria-label="Summary" className="rounded-[12px] border border-line bg-panel p-4">
          <div className="mb-1 flex items-center gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-fg-3">Summary</h2>
            <TonePill tone="muted">{inc.summarySource === "model" ? "model-written, grounded in linked runs" : "deterministic"}</TonePill>
          </div>
          <p className="text-sm text-fg">{inc.summary}</p>
          <div className="mt-3">
            <DebugThis target={{ kind: "incident", incidentId: inc.id }} label="Debug this incident" />
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-fg-3">First bad version</dt>
              <dd className="font-mono text-fg">{inc.firstBadVersion || "n/a"}</dd>
            </div>
            <div>
              <dt className="text-fg-3">Last good version</dt>
              <dd className="font-mono text-fg">{inc.lastGoodVersion || "n/a"}</dd>
            </div>
            <div>
              <dt className="text-fg-3">Opened</dt>
              <dd className="text-fg">{new Date(inc.openedAt).toLocaleString()}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-fg-3">Suspected cause</p>
          <p className="text-sm text-fg-2">{inc.suspectedCause}</p>
        </section>

        {findings.length > 0 && (
          <section aria-label="Evidence" className="rounded-[12px] border border-line bg-panel p-4">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-3">Evidence</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-fg-3">
                  <tr>
                    <th className="py-1 pr-4 font-medium">Metric</th>
                    <th className="py-1 pr-4 font-medium">Version</th>
                    <th className="py-1 pr-4 font-medium">Baseline</th>
                    <th className="py-1 pr-4 font-medium">Observed</th>
                    <th className="py-1 pr-4 font-medium">z</th>
                    <th className="py-1 font-medium">Runs</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-fg-2">
                  {findings.map((f) => (
                    <tr key={f.metric + f.version}>
                      <td className="py-1 pr-4">{f.metric}</td>
                      <td className="py-1 pr-4">{f.version}</td>
                      <td className="py-1 pr-4">{+f.baseline.toPrecision(3)}</td>
                      <td className="py-1 pr-4">{+f.observed.toPrecision(3)}</td>
                      <td className="py-1 pr-4">{f.z.toFixed(1)}</td>
                      <td className="py-1">{f.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section aria-label="Affected runs" className="rounded-[12px] border border-line bg-panel p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-3">
            Affected runs ({inc.affectedRunIds.length})
          </h2>
          <ul className="flex flex-wrap gap-2">
            {inc.affectedRunIds.slice(0, AFFECTED_SHOWN).map((r) => (
              <li key={r}>
                <Link href={`/runs/${encodeURIComponent(r)}`} className="rounded bg-raised px-2 py-1 font-mono text-[11px] text-accent hover:bg-hover">
                  {r.slice(0, 8)}
                </Link>
              </li>
            ))}
          </ul>
          {inc.affectedRunIds.length > AFFECTED_SHOWN && (
            <p className="mt-2 text-[12px] text-fg-3">Showing {AFFECTED_SHOWN} of {inc.affectedRunIds.length}.</p>
          )}
        </section>

        <section aria-label="Timeline" className="rounded-[12px] border border-line bg-panel p-4">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-3">Timeline (audit trail)</h2>
          <ol className="space-y-3 border-l border-line pl-4">
            {(inc.timeline ?? []).map((t, i) => (
              <li key={i} className="text-xs">
                <span className="font-medium capitalize text-fg">{t.action}</span>{" "}
                <span className="text-fg-3">
                  by {t.actor} · {new Date(t.at).toLocaleString()}
                </span>
                {t.detail && <p className="mt-0.5 text-fg-3">{t.detail}</p>}
              </li>
            ))}
          </ol>
        </section>

        {canWrite && actions.length > 0 && (
          <section aria-label="Actions" className="rounded-[12px] border border-line bg-panel p-4">
            <label htmlFor="note" className="mb-1 block text-xs text-fg-3">
              Note (optional, saved to the timeline)
            </label>
            <input
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              className="mb-3 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus-ring"
            />
            <div className="flex flex-wrap gap-2">
              {actions.includes("acknowledge") && (
                <Button variant="secondary" loading={busy === "acknowledge"} onClick={() => act("acknowledge")}>
                  Acknowledge
                </Button>
              )}
              <Button variant="primary" loading={busy === "resolve"} onClick={() => act("resolve")}>
                Resolve
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
