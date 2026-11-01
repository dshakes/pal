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

/** Returns true (and records the day) when an FYI should be sent now. */
export function shouldSendBudgetFyi(state: BudgetFyiState, now: number): boolean {
  const k = dayKey(now);
  if (state.lastDay === k) return false;
  state.lastDay = k;
  return true;
}

export const BUDGET_FYI_TEXT =
  "your PAL spend limit was reached, so I couldn't draft replies — contacts are waiting on you. Nothing was sent. Raise the limit in Budgets or reply to them yourself.";
