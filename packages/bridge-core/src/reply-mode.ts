// PAL_REPLY_MODE — who the bridges may AUTO-SEND contact replies to (GA PR-1).
// Pure: both bridges call these; the held-draft path itself is the existing one.
//   drafts       (default) every contact reply is drafted to the owner, never auto-sent
//   inner-circle auto-send only to contacts in the owner's `## Relationships`; draft the rest
//   everyone     legacy behaviour (reply to everybody)
// Unknown/invalid value => refuse-safe: drafts + a warning.

export type ReplyMode = "drafts" | "inner-circle" | "everyone";
export const REPLY_MODES: readonly ReplyMode[] = ["drafts", "inner-circle", "everyone"];

export interface ReplyModeResolution {
  mode: ReplyMode;
  source: "env" | "default" | "invalid";
  /** set when source === "invalid"; log it once at startup */
  warning?: string;
}

export function resolveReplyMode(raw: string | undefined): ReplyModeResolution {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return { mode: "drafts", source: "default" };
  if ((REPLY_MODES as readonly string[]).includes(v)) return { mode: v as ReplyMode, source: "env" };
  return {
    mode: "drafts",
    source: "invalid",
    warning: `PAL_REPLY_MODE=${JSON.stringify(raw)} is not one of ${REPLY_MODES.join("|")} — using "drafts" (safe)`,
  };
}

export interface ContactReplyInput {
  mode: ReplyMode;
  /** the owner's own channel — not a contact reply, never held by mode */
  isOwnerChannel: boolean;
  isGroup: boolean;
  /** sender has a relationship in the owner's `## Relationships` */
  inInnerCircle: boolean;
  /** sender matched the spam heuristic */
  spam: boolean;
}

export interface ContactReplyDecision {
  action: "send" | "draft";
  /** for logs: why a draft was forced (empty when sending) */
  reason: string;
}

export function decideContactReply(i: ContactReplyInput): ContactReplyDecision {
  if (i.isOwnerChannel || i.mode === "everyone") return { action: "send", reason: "" };
  if (i.mode === "drafts") return { action: "draft", reason: "reply-mode=drafts" };
  // inner-circle
  if (i.spam) return { action: "draft", reason: "reply-mode=inner-circle: spam-matched sender" };
  if (i.isGroup) return { action: "draft", reason: "reply-mode=inner-circle: group" };
  if (!i.inInnerCircle) return { action: "draft", reason: "reply-mode=inner-circle: sender not in ## Relationships" };
  return { action: "send", reason: "" };
}

// ── SEND BOUNDARY ─────────────────────────────────────────────────────────
// A branch flag is not an invariant: the guarantee lives where bytes leave the
// bridge (send()/sendMessage(), next to the mute check). Any NON-owner
// destination is refused unless the call carries an explicit, typed allow:
//   contact-reply    a decideContactReply "send" decision for THAT contact
//   owner-approved   owner approved a draft / typed an owner command / owner REST send
//   safety-exception the documented life-threat canned reply (the ONLY auto-send
//                    that bypasses drafts mode; prompt-injection refusals do NOT)
export type SendAllow =
  | { kind: "contact-reply"; decision: ContactReplyDecision }
  | { kind: "owner-approved" }
  | { kind: "safety-exception" };

export const ALLOW_OWNER_APPROVED: SendAllow = { kind: "owner-approved" };
export const ALLOW_SAFETY_EXCEPTION: SendAllow = { kind: "safety-exception" };

export interface SendGateInput {
  mode: ReplyMode;
  destination: string;
  isOwner: boolean;
  allow?: SendAllow;
}

export function allowContactSend(i: SendGateInput): { ok: boolean; reason: string } {
  if (i.isOwner) return { ok: true, reason: "owner destination" };
  if (i.mode === "everyone") return { ok: true, reason: "reply-mode=everyone" };
  const a = i.allow;
  if (a?.kind === "owner-approved") return { ok: true, reason: "owner-approved" };
  if (a?.kind === "safety-exception") return { ok: true, reason: "safety-exception" };
  if (a?.kind === "contact-reply" && a.decision.action === "send") return { ok: true, reason: "contact-reply allowed" };
  return {
    ok: false,
    reason: `reply-mode=${i.mode}: unapproved send to ${i.destination} blocked${a?.kind === "contact-reply" ? ` (${a.decision.reason})` : ""}`,
  };
}

/** One-line startup log text. */
export function describeReplyMode(r: ReplyModeResolution): string {
  return `reply mode: ${r.mode} (source: ${r.source === "env" ? "PAL_REPLY_MODE" : r.source === "default" ? "default" : "PAL_REPLY_MODE invalid -> safe default"})`;
}

// ── Budget (HTTP 402) hold ───────────────────────────────────────────────
// A 402 from the control-plane means no draft could be made. Never drop it
// silently and never send a canned fallback: log every time, FYI the owner at
// most once per local day.
export interface BudgetFyiState { lastDay?: string }

export function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** True when no FYI has been delivered yet today. Pure; record success with markBudgetFyi. */
export function budgetFyiDue(state: BudgetFyiState, now: number): boolean {
  return state.lastDay !== dayKey(now);
}

/** Call only after the FYI was actually delivered. */
export function markBudgetFyi(state: BudgetFyiState, now: number): void {
  state.lastDay = dayKey(now);
}

export const BUDGET_FYI_TEXT =
  "your PAL spend limit was reached, so I couldn't draft replies — contacts are waiting on you. Nothing was sent. Raise the limit in Budgets or reply to them yourself.";

// ── Owner-approved REST send (dashboard Approve/Edit, cross-bridge relay) ──
/** Thrown by a bridge send that the reply-mode boundary refused when the caller asked to be told. */
export class ReplyModeBlockedError extends Error {
  constructor(public readonly destination: string) {
    super(`reply mode blocked the send to ${destination}`);
    this.name = "ReplyModeBlockedError";
  }
}

/**
 * Run an owner-approved send and map it to an HTTP result. The allow is ALWAYS
 * owner-approved (these routes are bearer-guarded and only the owner's approve /
 * edit / relay hits them). A boundary refusal is a 409, never a false "sent".
 */
export async function ownerApprovedSend(
  send: (allow: SendAllow) => Promise<{ ok: boolean; reason?: string }>,
): Promise<{ status: 200 | 409 | 500; body: Record<string, unknown> }> {
  try {
    const r = await send(ALLOW_OWNER_APPROVED);
    if (r.ok) return { status: 200, body: { status: "sent" } };
    if (r.reason === "reply-mode") return { status: 409, body: { error: "blocked by reply mode", code: "reply_mode_blocked" } };
    return { status: 500, body: { error: r.reason ?? "send failed" } };
  } catch (err) {
    if (err instanceof ReplyModeBlockedError) return { status: 409, body: { error: "blocked by reply mode", code: "reply_mode_blocked" } };
    return { status: 500, body: { error: String(err) } };
  }
}
