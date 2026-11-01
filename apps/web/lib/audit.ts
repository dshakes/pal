// Audit log (Settings -> Audit log). The control plane has no single
// tenant-wide audit endpoint, so this page MERGES the two tenant-wide streams
// that exist and says so:
//   - promotions: GET /v1/promotions/audit?limit=<1..500>  (array, newest first, no cursor)
//   - sandboxes:  GET /v1/runtime/audit?limit=<1..1000>&before=<id> ({events, nextBefore})
// Per-agent identity/policy audit stays on the agent's Security tab.
// Everything here is pure; payloads are untrusted JSON (parse, don't cast).

export type AuditSource = "promotion" | "sandbox";

export interface AuditRow {
  /** Unique across sources (ids are per-table), so lists never collide at a cap. */
  key: string;
  source: AuditSource;
  at: string;
  actor: string;
  action: string;
  /** agent/env for promotions, vm for sandboxes. */
  subject: string;
  /** Short, redacted summary of the record's detail/attrs. */
  detail: string;
}

/** Server caps (handlers/promotion.go Audit, handlers/runtime.go ListAudit). Over the cap the server silently resets to 100. */
export const PROMOTION_LIMIT_MAX = 500;
export const SANDBOX_LIMIT_MAX = 1000;
export const PAGE = 100;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const SENSITIVE = /secret|token|password|passwd|credential|api[-_]?key|authorization|bearer/i;
const MAX_DETAIL = 160;

/** key=value for primitive fields only; sensitive-looking keys are hidden, never shown. */
export function summarizeDetail(detail: unknown): string {
  if (!isRecord(detail)) return typeof detail === "string" ? detail.slice(0, MAX_DETAIL) : "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (SENSITIVE.test(k)) { parts.push(`${k}=[hidden]`); continue; }
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${String(v)}`);
  }
  const out = parts.join(" ");
  return out.length > MAX_DETAIL ? `${out.slice(0, MAX_DETAIL - 1)}…` : out;
}

export function parsePromotionAudit(raw: unknown): AuditRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): AuditRow[] => {
    if (!isRecord(r) || typeof r.id !== "number" || !str(r.action) || !str(r.createdAt)) return [];
    const kind = str(r.actorKind);
    return [{
      key: `promotion:${r.id}`,
      source: "promotion",
      at: str(r.createdAt),
      actor: kind ? `${str(r.actor)} (${kind})` : str(r.actor),
      action: str(r.action),
      subject: [str(r.agentName), str(r.env)].filter(Boolean).join(" / "),
      detail: summarizeDetail(r.detail),
    }];
  });
}

export interface SandboxPage {
  rows: AuditRow[];
  /** Cursor for the next (older) page; 0 when there is none. */
  nextBefore: number;
  /** Rows the server returned (a full page means there may be older ones). */
  count: number;
}

export function parseSandboxAudit(raw: unknown): SandboxPage {
  if (!isRecord(raw) || !Array.isArray(raw.events)) return { rows: [], nextBefore: 0, count: 0 };
  const rows = raw.events.flatMap((e): AuditRow[] => {
    if (!isRecord(e) || typeof e.id !== "number" || !str(e.action) || !str(e.at)) return [];
    return [{
      key: `sandbox:${e.id}`,
      source: "sandbox",
      at: str(e.at),
      actor: str(e.principalId) || "system",
      action: str(e.action),
      subject: str(e.vmId),
      detail: summarizeDetail(e.attrs),
    }];
  });
  return { rows, nextBefore: typeof raw.nextBefore === "number" ? raw.nextBefore : 0, count: raw.events.length };
}

const ts = (s: string) => {
  const n = Date.parse(s);
  return Number.isNaN(n) ? 0 : n;
};

/** Newest first; ties keep a stable order via the unique key. */
export function mergeAudit(...lists: AuditRow[][]): AuditRow[] {
  const seen = new Map<string, AuditRow>();
  for (const l of lists) for (const r of l) seen.set(r.key, r);
  return [...seen.values()].sort((a, b) => ts(b.at) - ts(a.at) || (a.key < b.key ? 1 : -1));
}

export function filterAudit(rows: AuditRow[], source: AuditSource | "all", query: string): AuditRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => (source === "all" || r.source === source) && (!q || `${r.action} ${r.actor} ${r.subject} ${r.detail}`.toLowerCase().includes(q)));
}

/** Promotions have no cursor: grow the limit up to the cap. null = already at the cap. */
export function nextPromotionLimit(current: number): number | null {
  return current >= PROMOTION_LIMIT_MAX ? null : Math.min(PROMOTION_LIMIT_MAX, current * 2 + (current < PAGE ? 0 : 50));
}

/**
 * Rows are only trustworthy back to the point BOTH streams have been loaded to.
 * A stream that may have older rows (a full page) has a horizon at its oldest loaded
 * row; anything older than the NEWEST such horizon could be missing the other stream's
 * rows, so it is clipped. Returns the cutoff (ms, null = nothing clipped) too.
 */
export function clipToComplete(rows: AuditRow[], incomplete: Partial<Record<AuditSource, boolean>>): { rows: AuditRow[]; cutoff: number | null } {
  const horizons: number[] = [];
  for (const src of ["promotion", "sandbox"] as const) {
    if (!incomplete[src]) continue;
    const mine = rows.filter((r) => r.source === src).map((r) => ts(r.at));
    if (mine.length) horizons.push(Math.min(...mine));
  }
  if (!horizons.length) return { rows, cutoff: null };
  const cutoff = Math.max(...horizons);
  return { rows: rows.filter((r) => ts(r.at) >= cutoff), cutoff };
}
