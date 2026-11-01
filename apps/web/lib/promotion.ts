// Types + pure view-model helpers for agent lifecycle promotion (ADR 0054).
// JSON shapes mirror services/control-plane/internal/handlers/promotion.go.

export type PromoEnv = "sandbox" | "staging" | "prod";
export const PROMO_ENVS: readonly PromoEnv[] = ["sandbox", "staging", "prod"];

export type PromotionStatus =
  | "pending_approval"
  | "rejected"
  | "canary"
  | "promoted"
  | "rolled_back";

export interface Gate {
  name: string;
  status: string;
  detail?: string;
}

export interface EnvState {
  env: PromoEnv;
  version: string;
  previousVersion?: string | null;
  status: "active" | "canary";
  promotionId?: string | null;
  canaryPct?: number | null;
  lastSandboxRun?: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

export interface Promotion {
  guards?: Record<string, unknown> | null;
  id: string;
  agentName: string;
  env: PromoEnv;
  version: string;
  fromVersion?: string | null;
  status: PromotionStatus;
  canaryPct?: number | null;
  gates?: Gate[] | null;
  requestedBy: string;
  requestedByKind: "human" | "agent" | "system";
  approver?: string | null;
  note?: string | null;
  createdAt: string;
}

export interface AgentEnvironments {
  agentName: string;
  environments: EnvState[];
  promotions: Promotion[];
}

export interface AuditEntry {
  id: string;
  agentName: string;
  env?: string | null;
  promotionId?: string | null;
  action: string;
  actor: string;
  actorKind: "human" | "agent" | "system";
  detail?: Record<string, unknown> | string | null;
  createdAt: string;
}

export interface CanaryStats {
  Terminal: number;
  Failed: number;
  AvgCost: number;
}

export interface CanaryEvaluation {
  verdict: { verdict: "hold" | "pass" | "trip"; reasons?: string[] | null };
  action: "none" | "rolled_back" | "completed";
  candidate: CanaryStats;
  stable: CanaryStats;
  guards: { maxErrorRate: number; maxCostRatio: number; minEvalScore: number; minRuns: number };
}

/** Rollback needs a version to go back to (or an active canary to abort). */
export function canRollback(e: EnvState): boolean {
  return e.status === "canary" || (!!e.previousVersion && e.previousVersion !== e.version);
}

export function envBadgeLabel(e: EnvState): string {
  if (e.status === "canary") return `canary ${e.canaryPct ?? 0}%`;
  return "active";
}

export function errorRate(s: CanaryStats): number | null {
  return s.Terminal > 0 ? s.Failed / s.Terminal : null;
}

export function fmtPct(r: number | null): string {
  return r === null ? "—" : `${(r * 100).toFixed(1)}%`;
}

export function fmtCost(c: number): string {
  return `$${c.toFixed(4)}`;
}

export function proposedBy(p: Pick<Promotion, "requestedBy" | "requestedByKind">): string {
  return p.requestedByKind === "agent"
    ? `proposed by an agent (${p.requestedBy})`
    : `proposed by ${p.requestedBy}`;
}

export function gatesFailed(gates?: Gate[] | null): Gate[] {
  return (gates ?? []).filter((g) => g.status !== "pass" && g.status !== "passed");
}

export function gateTone(status: string): "ok" | "warn" | "danger" {
  if (status === "pass" || status === "passed") return "ok";
  if (status === "skipped" || status === "pending") return "warn";
  return "danger";
}

export interface ApiFail {
  status: number;
  code?: string;
  message: string;
  gates?: Gate[];
}

/** runtimeApi throws `API <status>: <body>`; recover status/code/gates/message. */
export function parseApiError(err: unknown): ApiFail {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^API (\d+): ([\s\S]*)$/.exec(raw);
  if (!m) return { status: 0, message: raw };
  const status = Number(m[1]);
  try {
    const j = JSON.parse(m[2]) as Record<string, unknown>;
    const msg = [j.error, j.message].find((v) => typeof v === "string") as string | undefined;
    return {
      status,
      code: typeof j.code === "string" ? j.code : undefined,
      message: msg ?? m[2],
      gates: Array.isArray(j.gates) ? (j.gates as Gate[]) : undefined,
    };
  } catch {
    return { status, message: m[2] || raw };
  }
}

export interface PromoteForm {
  env: PromoEnv;
  version: string;
  /** Whole percent 1–99; prod only. Blank = full rollout. */
  canaryPct: string;
  /** Canary guard: max candidate error rate, in percent. Blank = server default (10%). */
  maxErrorPct: string;
  /** Canary guard: terminal candidate runs needed to pass. Blank = server default (20). */
  minRuns: string;
  reason: string;
}

export const EMPTY_PROMOTE_FORM: PromoteForm = { env: "staging", version: "", canaryPct: "", maxErrorPct: "", minRuns: "", reason: "" };

/** Server bounds (promotion_logic.go): canaryPct 0–99 prod-only; maxErrorRate (0, 0.5]; minRuns 5–100000. */
export function validatePromote(f: Pick<PromoteForm, "env" | "canaryPct"> & Partial<PromoteForm>): string | null {
  const canary = f.env === "prod" && f.canaryPct.trim() !== "";
  if (canary) {
    const n = Number(f.canaryPct);
    if (!Number.isInteger(n) || n < 1 || n > 99) return "Canary % must be a whole number 1–99";
  }
  if (canary && (f.maxErrorPct ?? "").trim() !== "") {
    const n = Number(f.maxErrorPct);
    if (!Number.isFinite(n) || n <= 0 || n > 50) return "Max error rate must be above 0% and at most 50%";
  }
  if (canary && (f.minRuns ?? "").trim() !== "") {
    const n = Number(f.minRuns);
    if (!Number.isInteger(n) || n < 5 || n > 100000) return "Min runs must be a whole number 5–100000";
  }
  return null;
}

/** The POST /v1/agents/{name}/promote body. Guards ride along only with a canary, prod only. */
export function promoteBody(f: PromoteForm): Record<string, unknown> {
  const body: Record<string, unknown> = { env: f.env };
  if (f.version.trim()) body.version = f.version.trim();
  if (f.env === "prod" && f.canaryPct.trim()) {
    body.canaryPct = Number(f.canaryPct);
    const guards: Record<string, number> = {};
    if (f.maxErrorPct.trim()) guards.maxErrorRate = Number(f.maxErrorPct) / 100;
    if (f.minRuns.trim()) guards.minRuns = Number(f.minRuns);
    if (Object.keys(guards).length) body.guards = guards;
  }
  if (f.reason.trim()) body.reason = f.reason.trim();
  return body;
}

/** POST /promote answers {promotion, gates}: 202 pending_approval, 200 otherwise. */
export interface PromoteResponse {
  promotion: Promotion;
  gates?: Gate[] | null;
}

/** What actually happened, in words — "requested" is not "live" (prod waits for a human). */
export function promoteOutcome(r: PromoteResponse): { tone: "ok" | "warn"; message: string } {
  const p = r.promotion;
  switch (p.status) {
    case "pending_approval":
      return { tone: "warn", message: `Awaiting approval: ${p.version} is not live in ${p.env} until an owner or admin approves it.` };
    case "canary":
      return { tone: "ok", message: `Canary started: ${p.version} serves ${p.canaryPct ?? 0}% of ${p.env} traffic.` };
    case "promoted":
      return { tone: "ok", message: `Promoted: ${p.version} is live in ${p.env}.` };
    case "rejected":
    case "rolled_back":
      return { tone: "warn", message: `Promotion ${p.status.replace("_", " ")}.` };
    default: {
      const _never: never = p.status;
      return { tone: "warn", message: String(_never) };
    }
  }
}

/**
 * What approving will do. Mirrors applyPromotion: a prod canary only starts when a
 * DIFFERENT stable version is already serving prod (the first prod promotion adopts the
 * agent's live version as baseline, which the client can't see), and a running canary
 * blocks a new one. Where the client can't know, say so rather than guess.
 */
export function approvalEffect(p: Pick<Promotion, "env" | "version" | "canaryPct">, prod?: EnvState | null): string {
  const pct = p.canaryPct ?? 0;
  const full = `Makes ${p.version} live in ${p.env} for all traffic.`;
  if (p.env !== "prod" || pct <= 0) return full;
  if (prod?.status === "canary") return `A canary is already running in prod, so approving will be refused until it finishes or is rolled back.`;
  if (prod && prod.version === p.version) return full;
  if (prod) return `Starts a ${pct}% canary of ${p.version} against stable ${prod.version}.`;
  return `Requested as a ${pct}% canary. It runs as a canary only if prod already serves a different version; otherwise it goes live for all traffic.`;
}

/** Prod promotions always need a human owner/admin (server needsApproval). */
export function approvalNote(env: PromoEnv): string | null {
  return env === "prod"
    ? "Prod needs a human owner or admin to approve. You can propose it; it goes live only after approval. API keys and agents can only propose."
    : null;
}

export function pendingFor(promos: Promotion[], agent?: string): Promotion[] {
  return promos.filter((p) => p.status === "pending_approval" && (!agent || p.agentName === agent));
}

/** The API caps lists (promotions per agent 20, tenant list 100, audit `limit`); say so instead of implying completeness. */
export function cappedNote(shown: number, cap: number, noun: string): string | null {
  return shown >= cap ? `Showing the latest ${cap} ${noun}; older ones aren't listed.` : null;
}

/** One-line summary of an audit detail object (the API sends JSON, not a string). */
export function summarizeDetail(d: unknown): string {
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (typeof d !== "object") return String(d);
  return Object.entries(d as Record<string, unknown>)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: ${v.length} item${v.length === 1 ? "" : "s"}`;
      if (typeof v === "object") return `${k}: …`;
      return `${k}: ${String(v)}`;
    })
    .join(" · ")
    .slice(0, 240);
}
