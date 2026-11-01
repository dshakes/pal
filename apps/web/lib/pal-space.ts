// pal space (consumer) — pure rules shared by Today, Holds and People & memory.
//
// Everything here mirrors a SERVER rule or an honesty rule, and is unit-tested
// in pal-space.test.mts. Sources of truth:
//   - holds: POST /v1/whatsapp/drafts/{id}/act  (services/control-plane
//     internal/handlers/whatsapp_personal.go ActOnDraft)
//   - bridges: read-only attention snapshot (GET /session/:tenantId/attention)
//   - people: GET /v1/people (LIMIT 500), GET /v1/memory/context
// The dashboard never mutates bridge state itself: approve/edit make the
// CONTROL-PLANE deliver the reply, and the confirm card says so.

import type { BriefItem } from "./brief";

// ---------------------------------------------------------------------------
// Sources that may fail independently (a down source is named, never faked)
// ---------------------------------------------------------------------------

export type Settled<T> = { ok: true; data: T } | { ok: false };

export function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (data) => ({ ok: true as const, data }),
    () => ({ ok: false as const }),
  );
}

export function dataOr<T>(r: Settled<T>, fallback: T): T {
  return r.ok ? r.data : fallback;
}

/** Labels of the sources that failed, in the order given. */
export function failedLabels(sources: Array<[string, Settled<unknown>]>): string[] {
  return sources.filter(([, r]) => !r.ok).map(([label]) => label);
}

/**
 * Server list endpoints silently truncate (drafts: newest 100; people: 500;
 * life events / commitments: the `limit` we pass, max 200). A list that is
 * exactly at its cap may be missing rows, so say so instead of implying it is
 * complete.
 */
export function capNote(label: string, count: number, cap: number): string | null {
  return count >= cap ? `Showing the first ${cap} ${label} — there may be more.` : null;
}

export const DRAFTS_CAP = 100; // ListDrafts: LIMIT 100
export const PEOPLE_CAP = 500; // ListPeople: LIMIT 500
export const BRIEF_SOURCE_LIMIT = 30;

// ---------------------------------------------------------------------------
// Held replies: approve / edit / discard
// ---------------------------------------------------------------------------

export type HoldAction = "approve" | "edit" | "discard";

export interface HoldDraft {
  id: string;
  displayName: string;
  jid: string;
  channel: "whatsapp" | "imessage";
  draftText: string;
}

export type HoldPlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      action: HoldAction;
      /** What goes in the request's finalText ("" unless editing). */
      finalText: string;
      title: string;
      /** The exact text that will be sent, or null when nothing is sent. */
      willSend: string | null;
      confirmLabel: string;
      tone: "default" | "danger";
    };

const channelName = (c: HoldDraft["channel"]) => (c === "imessage" ? "iMessage" : "WhatsApp");

/**
 * Validate an action the way the server will, and describe what confirming it
 * does. Server rules (ActOnDraft): edit needs a non-blank finalText; approve of
 * an EMPTY draft would mark it approved while sending nothing, so we refuse it
 * here rather than let the UI claim a send that never happened.
 */
export function planHoldAction(action: HoldAction, draft: HoldDraft, editedText = ""): HoldPlan {
  const who = draft.displayName.trim() || draft.jid;
  const on = channelName(draft.channel);
  switch (action) {
    case "approve": {
      if (!draft.draftText.trim()) {
        return { ok: false, reason: "This draft is empty, so there is nothing to send. Edit it or discard it." };
      }
      return {
        ok: true, action, finalText: "",
        title: `Send this reply to ${who} on ${on}?`,
        willSend: draft.draftText, confirmLabel: "Send now", tone: "default",
      };
    }
    case "edit": {
      const text = editedText.trim();
      if (!text) return { ok: false, reason: "Write the reply you want to send first." };
      return {
        ok: true, action, finalText: text,
        title: `Send your edited reply to ${who} on ${on}?`,
        willSend: text, confirmLabel: "Send edited reply", tone: "default",
      };
    }
    case "discard":
      return {
        ok: true, action, finalText: "",
        title: `Discard this draft for ${who}?`,
        willSend: null, confirmLabel: "Discard draft", tone: "danger",
      };
    default: {
      const never: never = action;
      return never;
    }
  }
}

export type HoldOutcome =
  | { kind: "done"; message: string }
  /** Resolved in PAL but the bridge send failed: NOT delivered, and the draft can no longer be acted on. */
  | { kind: "delivery_failed"; message: string }
  /** Someone else (or an earlier click) already resolved it. */
  | { kind: "gone"; message: string }
  | { kind: "error"; message: string };

export class PersonalApiError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`whatsapp-personal ${status}: ${body.slice(0, 200)}`);
    this.name = "PersonalApiError";
    this.status = status;
  }
}

export function holdOutcome(
  action: HoldAction,
  result: { status?: string; sendError?: string } | null,
  err?: unknown,
): HoldOutcome {
  if (err) {
    if (err instanceof PersonalApiError && err.status === 404) {
      return { kind: "gone", message: "That draft was already handled, so it has been removed from the list." };
    }
    return { kind: "error", message: err instanceof Error ? err.message : "Couldn't update the reply" };
  }
  if (result?.sendError) {
    return {
      kind: "delivery_failed",
      message: `Not delivered: ${result.sendError}. PAL has already closed this draft, so it will not retry. Copy the text and send it yourself.`,
    };
  }
  return { kind: "done", message: action === "discard" ? "Draft discarded." : "Reply sent." };
}

// ---------------------------------------------------------------------------
// Bridge attention snapshot (read-only)
// ---------------------------------------------------------------------------

export type BridgeLink = "online" | "offline" | "auth_required" | "unknown";

/** A 401/403 means reachable-but-token-wrong; anything else is "can't reach it". */
export function bridgeLinkFromError(err: unknown): BridgeLink {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 403 ? "auth_required" : "offline";
}

/** The bridge builds the snapshot when the owner asks for a Brief in chat, so it can be old. */
export const SNAPSHOT_STALE_MS = 12 * 3_600_000;

export interface SnapshotLike {
  generatedAt: number | null;
  channel: string;
  items: Array<{ ref: string; id: string; label: string; why?: string; n: number; defaultAction: string }>;
}

export interface SnapshotThread {
  id: string;
  label: string;
  why?: string;
  channel: string;
  n: number;
  defaultAction: string;
}

/**
 * Split the snapshots into fresh threads (rank them) and stale channels (name
 * them, don't rank them: "waiting 3d" in a week-old snapshot is a stale claim).
 * Only `thread` items are taken; drafts/commitments come from the control-plane.
 */
export function threadsFromSnapshots(
  snaps: Array<SnapshotLike | null>,
  now: number,
): { threads: SnapshotThread[]; stale: Array<{ channel: string; generatedAt: number }> } {
  const threads: SnapshotThread[] = [];
  const stale: Array<{ channel: string; generatedAt: number }> = [];
  for (const s of snaps) {
    if (!s || s.generatedAt == null) continue;
    if (now - s.generatedAt > SNAPSHOT_STALE_MS) {
      if (s.items.some((i) => i.ref === "thread")) stale.push({ channel: s.channel, generatedAt: s.generatedAt });
      continue;
    }
    for (const i of s.items) {
      if (i.ref === "thread") {
        threads.push({ id: i.id, label: i.label, why: i.why, channel: s.channel, n: i.n, defaultAction: i.defaultAction });
      }
    }
  }
  return { threads, stale };
}

// ---------------------------------------------------------------------------
// Ranking: only call the model when there is something it hasn't seen
// ---------------------------------------------------------------------------

/**
 * Resolving a card shrinks the set; that must not cost another LLM call. Rank
 * only when the current items include a key the last ranking did not cover.
 */
export function needsRank(base: BriefItem[], rankedKeys: ReadonlySet<string> | null): boolean {
  if (base.length < 2) return false;
  if (!rankedKeys) return true;
  return base.some((b) => !rankedKeys.has(b.key));
}

// ---------------------------------------------------------------------------
// People & memory
// ---------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  displayName: string;
  relationship: string;
  isOwner: boolean;
  updatedAt: string;
}

export const personLabel = (p: PersonRow) => p.displayName.trim() || "Unnamed contact";

/** Case-insensitive match on name or relationship; blank query keeps server order. */
export function filterPeople(people: PersonRow[], query: string): PersonRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return people;
  return people.filter((p) => personLabel(p).toLowerCase().includes(q) || p.relationship.toLowerCase().includes(q));
}

/** Tolerant read of GET /v1/people: anything that isn't a well-formed row is dropped, not guessed at. */
export function parsePeople(raw: unknown): PersonRow[] {
  const list = (raw as { people?: unknown } | null)?.people;
  if (!Array.isArray(list)) return [];
  const out: PersonRow[] = [];
  for (const r of list) {
    const o = r as Record<string, unknown>;
    if (typeof o?.id !== "string" || !o.id) continue;
    out.push({
      id: o.id,
      displayName: typeof o.displayName === "string" ? o.displayName : "",
      relationship: typeof o.relationship === "string" ? o.relationship : "",
      isOwner: o.isOwner === true,
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
    });
  }
  return out;
}

export interface MemoryContext {
  personId: string;
  displayName: string;
  relationship: string;
  handles: Array<{ channel: string; handle: string }>;
  facts: string[];
  events: Array<{ channel: string; kind: string; direction: string; content: string; occurredAt: string }>;
}

/** Tolerant read of GET /v1/memory/context (facts are plain strings server-side). */
export function parseMemoryContext(raw: unknown): MemoryContext | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o.personId !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    personId: o.personId,
    displayName: str(o.displayName),
    relationship: str(o.relationship),
    handles: arr(o.handles).flatMap((h) => {
      const x = h as Record<string, unknown>;
      return typeof x?.handle === "string" ? [{ channel: str(x.channel), handle: x.handle }] : [];
    }),
    facts: arr(o.facts).filter((f): f is string => typeof f === "string" && f.trim() !== ""),
    events: arr(o.events).flatMap((e) => {
      const x = e as Record<string, unknown>;
      return typeof x?.content === "string"
        ? [{ channel: str(x.channel), kind: str(x.kind), direction: str(x.direction), content: x.content, occurredAt: str(x.occurredAt) }]
        : [];
    }),
  };
}

/** Compact relative time for lists ("3m", "2h", "4d"); unknown input is returned as-is. */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = Math.max(0, now - t);
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

// ---------------------------------------------------------------------------
// Documents: deadlines derived from the owner's documents
// ---------------------------------------------------------------------------

export interface DerivedDeadline {
  id: string;
  who: string;
  docType: string;
  deadline: string;
  basis: string;
  confidence: number;
  sources: string[];
}

export type Deadlines = { enabled: false } | { enabled: true; items: DerivedDeadline[] };

/** Tolerant read of the handler's snake_case payload; `deadlines` may be null. */
export function parseDeadlines(raw: unknown): Deadlines {
  const o = raw as { enabled?: unknown; deadlines?: unknown } | null;
  if (o?.enabled !== true) return { enabled: false };
  const list = Array.isArray(o.deadlines) ? o.deadlines : [];
  const items: DerivedDeadline[] = [];
  for (const r of list) {
    const d = r as Record<string, unknown>;
    if (typeof d?.id !== "string" || typeof d.deadline !== "string") continue;
    items.push({
      id: d.id,
      who: typeof d.who === "string" ? d.who : "",
      docType: typeof d.doc_type === "string" ? d.doc_type : "",
      deadline: d.deadline,
      basis: typeof d.basis === "string" ? d.basis : "",
      confidence: typeof d.confidence === "number" ? d.confidence : 0,
      sources: Array.isArray(d.source_refs) ? d.source_refs.filter((s): s is string => typeof s === "string") : [],
    });
  }
  items.sort((a, b) => a.deadline.localeCompare(b.deadline));
  return { enabled: true, items };
}
