"use client";

// Agent environments — lifecycle promotion (ADR 0054): sandbox -> staging -> prod.
// Real endpoints only:
//   GET  /v1/agents/{n}/environments        env state + recent promotions
//   POST /v1/agents/{n}/promote             propose (prod ALWAYS waits for a human owner/admin)
//   POST /v1/agents/{n}/environments/{env}/rollback
//   POST /v1/agents/{n}/environments/prod/canary/evaluate
//   GET  /v1/promotions?status=&agentName=  ·  GET /v1/promotions/audit
//   POST /v1/promotions/{id}/{approve,reject}   (human owner/admin session only)
// Buttons are gated by role (lib/rbac) so nobody is offered what they can't do,
// but that is courtesy: the server enforces, and its refusal is shown verbatim.

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, GitBranch, Rocket, RotateCcw, Activity, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { runtimeApi } from "@/lib/runtime-api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/button";
import { Modal, ModalField } from "@/components/modal";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { useCan } from "@/components/role-gate";
import {
  EMPTY_PROMOTE_FORM,
  PROMO_ENVS,
  approvalEffect,
  approvalNote,
  canRollback,
  cappedNote,
  envBadgeLabel,
  errorRate,
  fmtCost,
  fmtPct,
  gateTone,
  parseApiError,
  promoteBody,
  promoteOutcome,
  proposedBy,
  summarizeDetail,
  validatePromote,
  type AgentEnvironments,
  type AuditEntry,
  type CanaryEvaluation,
  type EnvState,
  type Gate,
  type PromoteForm,
  type PromoteResponse,
  type Promotion,
  type PromoEnv,
} from "@/lib/promotion";

const INPUT = "focus-ring w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13.5px] text-fg placeholder:text-fg-3";
const AUDIT_LIMIT = 20;

const TONE = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-bad-soft text-bad",
  neutral: "bg-raised text-fg-2",
} as const;

export function Pill({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[tone])}>{children}</span>;
}

const KindPill = ({ kind }: { kind: string }) => <Pill tone={kind === "agent" ? "warn" : "neutral"}>{kind}</Pill>;

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export function GateList({ gates }: { gates?: Gate[] | null }) {
  if (!gates || gates.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {gates.map((g) => (
        <li key={g.name} className="flex flex-wrap items-start gap-2 text-[12px]">
          <Pill tone={gateTone(g.status)}>{g.status}</Pill>
          <span className="font-medium text-fg">{g.name}</span>
          {g.detail && <span className="min-w-0 break-words text-fg-3">{g.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-fg">
      {icon} {children}
    </h3>
  );
}

/** Pending approvals + decision modal. Shared by the agent's Promote tab and /promotions. */
export function PendingApprovals({
  pending,
  agentLabel,
  prod,
  onChanged,
}: {
  pending: Promotion[];
  /** This agent's prod environment, when the caller has it (agent tab); lets the dialog be exact. */
  prod?: EnvState | null;
  /** Show the agent name on each row (tenant-wide view). */
  agentLabel?: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const toast = useToast();
  const canApprove = useCan("promotions:approve");
  const [decision, setDecision] = useState<{ p: Promotion; kind: "approve" | "reject" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [gateFail, setGateFail] = useState<Gate[] | null>(null);

  const close = () => { setDecision(null); setNote(""); setGateFail(null); };

  const submit = async () => {
    if (!decision) return;
    setBusy(true);
    try {
      await runtimeApi.post(`/v1/promotions/${encodeURIComponent(decision.p.id)}/${decision.kind}`, { note });
      toast.success(decision.kind === "approve" ? "Promotion approved" : "Promotion rejected");
      close();
      await onChanged();
    } catch (err) {
      const f = parseApiError(err);
      if (f.code === "gate_failed" && f.gates) setGateFail(f.gates);
      toast.error(f.message || "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SectionTitle icon={<ShieldCheck className="h-3.5 w-3.5 text-fg-3" />}>Pending approvals ({pending.length})</SectionTitle>
      {pending.length === 0 ? (
        <EmptyState size="compact" title="Nothing awaiting approval" description="Promotions that need a human sign-off appear here." />
      ) : (
        <ul className="space-y-2.5">
          {pending.map((p) => (
            <li key={p.id} className="min-w-0 rounded-[12px] border border-line bg-panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                {agentLabel && <span className="break-all text-[14px] font-semibold text-fg">{p.agentName}</span>}
                <span className="text-[13px] text-fg-2">
                  {p.fromVersion ? `${p.fromVersion} → ` : ""}{p.version} → {p.env}
                  {p.canaryPct ? ` (${p.canaryPct}% canary)` : ""}
                </span>
                <KindPill kind={p.requestedByKind} />
              </div>
              <p className="mt-1 text-[12px] text-fg-3">{proposedBy(p)} · {when(p.createdAt)}</p>
              {p.note && <p className="mt-1 break-words text-[12px] text-fg-2">{p.note}</p>}
              <GateList gates={p.gates} />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {canApprove ? (
                  <>
                    <Button size="sm" variant="primary" onClick={() => { setGateFail(null); setNote(""); setDecision({ p, kind: "approve" }); }}>Approve</Button>
                    <Button size="sm" variant="secondary" onClick={() => { setGateFail(null); setNote(""); setDecision({ p, kind: "reject" }); }}>Reject</Button>
                  </>
                ) : (
                  <span className="text-[12px] text-fg-3">Only a human owner or admin can approve or reject.</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={!!decision}
        onClose={close}
        title={decision?.kind === "approve" ? "Approve promotion" : "Reject promotion"}
        description={decision ? `${decision.p.agentName} ${decision.p.version} → ${decision.p.env}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant={decision?.kind === "approve" ? "primary" : "danger"} loading={busy} onClick={submit}>
              {decision?.kind === "approve" ? "Approve" : "Reject"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {decision?.kind === "approve" && (
            <p className="text-[13px] text-fg-2">
              {approvalEffect(decision.p, prod)}
              {(decision.p.canaryPct ?? 0) > 0 && ` Guards: ${summarizeDetail(decision.p.guards)}`}
            </p>
          )}
          <ModalField label="Note (optional)">
            <input aria-label="Note" className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />
          </ModalField>
          {gateFail && <GateList gates={gateFail} />}
        </div>
      </Modal>
    </div>
  );
}

/** Newest-first audit rows. */
export function AuditTrail({ rows, agentLabel, limit }: { rows: AuditEntry[]; agentLabel?: boolean; limit: number }) {
  const cap = cappedNote(rows.length, limit, "entries");
  return (
    <div>
      <SectionTitle icon={<Activity className="h-3.5 w-3.5 text-fg-3" />}>Audit trail</SectionTitle>
      {rows.length === 0 ? (
        <EmptyState size="compact" title="No promotion activity" description="Promotions, approvals and rollbacks are logged here." />
      ) : (
        <>
          <ul className="divide-y divide-line rounded-[12px] border border-line bg-panel">
            {rows.map((a) => (
              <li key={a.id} className="min-w-0 px-4 py-3 text-[12px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{a.action}</span>
                  {agentLabel && <span className="break-all text-fg-2">{a.agentName}</span>}
                  {a.env && <Pill tone="neutral">{a.env}</Pill>}
                  <span className="break-all text-fg-2">{a.actor}</span>
                  <KindPill kind={a.actorKind} />
                  <span className="text-fg-3 sm:ml-auto">{when(a.createdAt)}</span>
                </div>
                {summarizeDetail(a.detail) && <p className="mt-1 break-words text-fg-3">{summarizeDetail(a.detail)}</p>}
              </li>
            ))}
          </ul>
          {cap && <p className="mt-2 text-[12px] text-fg-3">{cap}</p>}
        </>
      )}
    </div>
  );
}

/** With `fixedAgent` it shows that one agent (the agent page's Promote tab) and hides the picker. */
export function AgentEnvironments({ fixedAgent }: { fixedAgent?: string } = {}) {
  const toast = useToast();
  const canPropose = useCan("promotions:propose");
  const [agents, setAgents] = useState<string[] | null>(null);
  const [agent, setAgent] = useState("");
  const [envs, setEnvs] = useState<AgentEnvironments | null>(null);
  const [pending, setPending] = useState<Promotion[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [evalRes, setEvalRes] = useState<CanaryEvaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);

  const [rollback, setRollback] = useState<EnvState | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<PromoteForm>(EMPTY_PROMOTE_FORM);
  const [gateFail, setGateFail] = useState<Gate[] | null>(null);
  const seq = useRef(0); // drop responses for an agent we've since switched away from

  const load = useCallback(async (name: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const enc = encodeURIComponent(name);
      const [e, p, a] = await Promise.all([
        runtimeApi.get<AgentEnvironments>(`/v1/agents/${enc}/environments`),
        runtimeApi.get<Promotion[]>(`/v1/promotions?status=pending_approval&agentName=${enc}`),
        runtimeApi.get<AuditEntry[]>(`/v1/promotions/audit?agentName=${enc}&limit=${AUDIT_LIMIT}`),
      ]);
      if (mine !== seq.current) return;
      setEnvs(e);
      setPending(p ?? []);
      setAudit(a ?? []);
    } catch (err) {
      if (mine === seq.current) setError(parseApiError(err).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fixedAgent) {
      setAgents([fixedAgent]);
      setAgent(fixedAgent);
      return;
    }
    api
      .listAgents()
      .then((list) => {
        const names = list.map((x) => x.name);
        setAgents(names);
        if (names.length > 0) setAgent(names[0]);
        else setLoading(false);
      })
      .catch((err) => {
        setAgents([]);
        setError(parseApiError(err).message);
        setLoading(false);
      });
  }, [fixedAgent]);

  useEffect(() => {
    if (agent) {
      setEvalRes(null);
      void load(agent);
    }
  }, [agent, load]);

  const doPromote = async () => {
    setBusy(true);
    try {
      const res = await runtimeApi.post<PromoteResponse>(`/v1/agents/${encodeURIComponent(agent)}/promote`, promoteBody(form));
      const out = promoteOutcome(res);
      if (out.tone === "warn") toast.warning(out.message);
      else toast.success(out.message);
      setPromoteOpen(false);
      setForm((f) => ({ ...EMPTY_PROMOTE_FORM, env: f.env }));
      await load(agent);
    } catch (err) {
      const f = parseApiError(err);
      if (f.code === "gate_failed" && f.gates) {
        setGateFail(f.gates);
        toast.error("Promotion gates failed");
      } else toast.error(f.message || "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const doRollback = async () => {
    if (!rollback) return;
    setBusy(true);
    try {
      await runtimeApi.post(`/v1/agents/${encodeURIComponent(agent)}/environments/${rollback.env}/rollback`, { note });
      toast.success("Rolled back");
      setRollback(null);
      await load(agent);
    } catch (err) {
      toast.error(parseApiError(err).message || "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const doEvaluate = async () => {
    setEvaluating(true);
    try {
      const r = await runtimeApi.post<CanaryEvaluation>(`/v1/agents/${encodeURIComponent(agent)}/environments/prod/canary/evaluate`);
      setEvalRes(r);
      if (r.action !== "none") await load(agent);
    } catch (err) {
      toast.error(parseApiError(err).message);
    } finally {
      setEvaluating(false);
    }
  };

  const prodCanary = envs?.environments.find((e) => e.env === "prod" && e.status === "canary");
  const pctErr = validatePromote(form);
  const setF = (patch: Partial<PromoteForm>) => setForm((f) => ({ ...f, ...patch }));

  if (agents === null) return <Skeleton className="h-40 w-full" />;

  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-fg">
          <GitBranch className="h-3.5 w-3.5 text-fg-3" aria-hidden /> Agent environments
        </h2>
        {agents.length > 0 && (
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {!fixedAgent && (
              <select aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)} className={clsx(INPUT, "min-w-0 sm:w-56")}>
                {agents.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}
            <Button
              variant="primary"
              size="md"
              icon={<Rocket className="h-3.5 w-3.5" />}
              disabled={!canPropose}
              title={canPropose ? undefined : "Your role can't promote agents"}
              onClick={() => { setGateFail(null); setPromoteOpen(true); }}
            >
              Promote
            </Button>
          </div>
        )}
      </div>

      {agents.length === 0 && !error ? (
        <EmptyState icon={GitBranch} size="compact" title="No agents yet" description="Create an agent to promote it through sandbox, staging and prod." actionLabel="Create agent" actionHref="/agents" />
      ) : error ? (
        <EmptyState icon={AlertTriangle} size="compact" title="Couldn't load environments" description={error} actionLabel="Retry" onAction={() => (agent ? void load(agent) : window.location.reload())} />
      ) : loading || !envs ? (
        <div className="grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {PROMO_ENVS.map((name) => {
              const e = envs.environments.find((x) => x.env === name);
              const awaiting = pending.find((p) => p.env === name);
              return (
                <div key={name} data-testid={`env-${name}`} className="min-w-0 rounded-[12px] border border-line bg-panel p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[14px] font-semibold capitalize text-fg">{name}</span>
                    {e && <Pill tone={e.status === "canary" ? "warn" : "ok"}>{envBadgeLabel(e)}</Pill>}
                  </div>
                  {e ? (
                    <>
                      <p className="mt-2 break-all font-mono text-[13px] text-fg">{e.version}</p>
                      <p className="mt-1 break-words text-[12px] text-fg-3">{e.updatedBy ?? "—"} · {when(e.updatedAt)}</p>
                      {e.previousVersion && <p className="mt-1 break-all text-[12px] text-fg-3">previous: {e.previousVersion}</p>}
                    </>
                  ) : (
                    <p className="mt-2 text-[12px] text-fg-3">Nothing deployed.</p>
                  )}
                  {awaiting && (
                    <p className="mt-2 text-[12px] text-warn">{awaiting.version} awaiting approval</p>
                  )}
                  {e && (
                    <Button
                      className="mt-3"
                      variant="danger"
                      size="sm"
                      icon={<RotateCcw className="h-3 w-3" />}
                      disabled={!canPropose || !canRollback(e)}
                      title={!canPropose ? "Your role can't roll back" : !canRollback(e) ? "Nothing earlier to roll back to" : undefined}
                      onClick={() => { setNote(""); setRollback(e); }}
                    >
                      Rollback
                    </Button>
                  )}
                </div>
              );
            })}
          </div>

          {prodCanary && (
            <div className="rounded-[12px] border border-line bg-panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SectionTitle icon={<Activity className="h-3.5 w-3.5 text-fg-3" />}>
                  Prod canary: {envs.promotions.find((p) => p.id === prodCanary.promotionId)?.version ?? "candidate"} at {prodCanary.canaryPct ?? 0}% (stable {prodCanary.version})
                </SectionTitle>
                <Button variant="secondary" size="sm" loading={evaluating} disabled={!canPropose} onClick={doEvaluate}>
                  Evaluate now
                </Button>
              </div>
              {evalRes ? (
                <div className="space-y-3 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={evalRes.verdict.verdict === "pass" ? "ok" : evalRes.verdict.verdict === "trip" ? "danger" : "warn"}>{evalRes.verdict.verdict}</Pill>
                    {evalRes.action !== "none" && <span className="text-fg-2">action: {evalRes.action}</span>}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {([["Candidate", evalRes.candidate], ["Stable", evalRes.stable]] as const).map(([label, s]) => (
                      <div key={label} className="rounded-lg bg-raised p-3">
                        <p className="mb-1 font-medium text-fg">{label}</p>
                        <p className="text-fg-2">runs: {s.Terminal}</p>
                        <p className="text-fg-2">error rate: {fmtPct(errorRate(s))}</p>
                        <p className="text-fg-2">avg cost: {fmtCost(s.AvgCost)}</p>
                      </div>
                    ))}
                  </div>
                  {(evalRes.verdict.reasons ?? []).length > 0 && (
                    <ul className="list-disc space-y-0.5 pl-4 text-fg-2">
                      {(evalRes.verdict.reasons ?? []).map((r) => <li key={r} className="break-words">{r}</li>)}
                    </ul>
                  )}
                  <p className="text-fg-3">
                    Guards: max error {fmtPct(evalRes.guards.maxErrorRate)} · max cost ratio {evalRes.guards.maxCostRatio}x · min runs {evalRes.guards.minRuns}
                  </p>
                </div>
              ) : (
                <p className="text-[12px] text-fg-3">Run an evaluation to compare the candidate against stable. The server also evaluates on its own schedule.</p>
              )}
            </div>
          )}

          <PendingApprovals pending={pending} prod={envs.environments.find((e) => e.env === "prod") ?? null} onChanged={() => load(agent)} />
          <AuditTrail rows={audit} limit={AUDIT_LIMIT} />
        </div>
      )}

      {/* Rollback confirm */}
      <Modal
        open={!!rollback}
        onClose={() => setRollback(null)}
        title={`Roll back ${rollback?.env ?? ""}`}
        description={rollback ? `${agent}: ${rollback.version} → ${rollback.status === "canary" ? "stable (aborts the canary)" : (rollback.previousVersion ?? "previous")}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRollback(null)}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={doRollback}>Roll back</Button>
          </>
        }
      >
        <ModalField label="Note (optional)">
          <input aria-label="Note" className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why?" />
        </ModalField>
      </Modal>

      {/* Promote */}
      <Modal
        open={promoteOpen}
        onClose={() => setPromoteOpen(false)}
        title="Promote"
        description={agent}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPromoteOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!!pctErr} onClick={doPromote}>
              {form.env === "prod" ? "Request promotion" : "Promote"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <ModalField label="Environment">
            <select aria-label="Environment" className={INPUT} value={form.env} onChange={(e) => setF({ env: e.target.value as PromoEnv })}>
              {PROMO_ENVS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </ModalField>
          {approvalNote(form.env) && (
            <p role="note" className="rounded-lg border border-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">{approvalNote(form.env)}</p>
          )}
          <ModalField label="Version" hint="Blank promotes the newest frozen version. Freeze one with `pal freeze`.">
            <input aria-label="Version" className={INPUT} value={form.version} onChange={(e) => setF({ version: e.target.value })} />
          </ModalField>
          {form.env === "prod" && (
            <>
              <ModalField label="Canary %" hint={pctErr?.startsWith("Canary") ? pctErr : "Optional, 1–99. A canary runs only against a different version already live in prod; the first prod promotion goes out in full."}>
                <input aria-label="Canary %" className={INPUT} inputMode="numeric" value={form.canaryPct} onChange={(e) => setF({ canaryPct: e.target.value })} />
              </ModalField>
              {form.canaryPct.trim() !== "" && (
                <div className="grid grid-cols-2 gap-3">
                  <ModalField label="Max error rate %" hint={pctErr?.startsWith("Max") ? pctErr : "Default 10. Above 0, at most 50."}>
                    <input aria-label="Max error rate %" className={INPUT} inputMode="decimal" value={form.maxErrorPct} onChange={(e) => setF({ maxErrorPct: e.target.value })} />
                  </ModalField>
                  <ModalField label="Min runs" hint={pctErr?.startsWith("Min") ? pctErr : "Default 20. 5–100000."}>
                    <input aria-label="Min runs" className={INPUT} inputMode="numeric" value={form.minRuns} onChange={(e) => setF({ minRuns: e.target.value })} />
                  </ModalField>
                </div>
              )}
            </>
          )}
          <ModalField label="Reason (optional)">
            <input aria-label="Reason" className={INPUT} value={form.reason} onChange={(e) => setF({ reason: e.target.value })} />
          </ModalField>
          {gateFail && (
            <div role="alert">
              <p className="text-[12px] font-medium text-bad">Gates failed</p>
              <GateList gates={gateFail} />
            </div>
          )}
        </div>
      </Modal>
    </section>
  );
}
