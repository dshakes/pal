"use client";

// HoldCard — one held reply, with approve / edit / discard that STOP at a
// confirm card. Used by Today and Holds so the gate is implemented once.
//
// Endpoint: POST /v1/whatsapp/drafts/{id}/act (lib/whatsapp-personal-client).
// On approve/edit the CONTROL-PLANE delivers the text through the bridge that
// queued the draft; the dashboard never talks to the bridge for this. The
// server closes the draft BEFORE delivering, so a failed delivery is reported
// as "not delivered" and the text is handed back to copy (lib/pal-space).

import { useState } from "react";
import clsx from "clsx";
import { Check, Edit3, Inbox, MessageCircle, Smartphone, Sparkles, Trash2 } from "lucide-react";
import { actOnDraft, prettyJid, type Draft } from "@/lib/whatsapp-personal-client";
import { holdOutcome, planHoldAction, timeAgo, type HoldAction, type HoldOutcome, type HoldPlan } from "@/lib/pal-space";
import { Button } from "@/components/button";
import { ConfirmCard } from "@/components/confirm-card";

type Mode = { kind: "view" } | { kind: "edit" } | { kind: "confirm"; plan: Extract<HoldPlan, { ok: true }> };

export function ChannelTag({ channel }: { channel: Draft["channel"] }) {
  const Icon = channel === "whatsapp" ? MessageCircle : Smartphone;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-raised px-1.5 py-0.5 text-[11px] font-medium text-fg-2">
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {channel === "whatsapp" ? "WhatsApp" : "iMessage"}
    </span>
  );
}

export function HoldCard({
  draft, why, onOutcome,
}: {
  draft: Draft;
  /** The ranker's one-line reason (Today only). */
  why?: string;
  /** Called once the server has answered; the parent removes the row and reports. */
  onOutcome: (draft: Draft, action: HoldAction, outcome: HoldOutcome, sentText: string | null) => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [text, setText] = useState(draft.draftText);
  const [working, setWorking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const who = draft.displayName.trim() || prettyJid(draft.jid);

  const stage = (action: HoldAction) => {
    const plan = planHoldAction(action, draft, text);
    if (!plan.ok) {
      setRefusal(plan.reason);
      return;
    }
    setRefusal(null);
    setMode({ kind: "confirm", plan });
  };

  const confirm = async (plan: Extract<HoldPlan, { ok: true }>) => {
    setWorking(true);
    let outcome: HoldOutcome;
    try {
      const res = await actOnDraft(draft.id, plan.action, plan.finalText);
      outcome = holdOutcome(plan.action, res);
    } catch (err) {
      outcome = holdOutcome(plan.action, null, err);
    }
    setWorking(false);
    // A plain error keeps the card open so the person can retry; every other
    // outcome means the server no longer has a pending draft.
    if (outcome.kind === "error") setMode({ kind: "view" });
    onOutcome(draft, plan.action, outcome, plan.willSend);
  };

  return (
    <article aria-label={`Held reply to ${who}`} className="rounded-[12px] border border-line-strong bg-panel p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Inbox className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
            Reply to {who}
            <ChannelTag channel={draft.channel} />
            <span className="text-[11px] font-normal text-fg-3">{timeAgo(draft.createdAt)}</span>
          </p>
          {why && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-accent">
              <Sparkles className="h-2.5 w-2.5" aria-hidden /> {why}
            </p>
          )}
          <p className="mt-2 whitespace-pre-wrap rounded-lg bg-raised px-3 py-2 text-xs text-fg-2">
            <span className="mr-1 text-fg-3">They said:</span>
            {draft.inboundText || <em className="text-fg-3">(empty)</em>}
          </p>

          {mode.kind === "edit" ? (
            <textarea
              value={text}
              onChange={(e) => { setText(e.target.value); setRefusal(null); }}
              aria-label="Edit reply"
              rows={Math.min(8, Math.max(3, text.split("\n").length))}
              className="focus-ring mt-2 w-full resize-y rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-fg"
            />
          ) : (
            <p className="mt-2 whitespace-pre-wrap rounded-lg border border-line px-3 py-2 text-sm text-fg">
              <span className="mr-1 text-xs text-fg-3">Draft:</span>
              {draft.draftText || <em className="text-fg-3">(empty)</em>}
            </p>
          )}

          {refusal && (
            <p role="alert" className="mt-2 text-xs text-warn">{refusal}</p>
          )}

          <div className={clsx("mt-3", mode.kind === "confirm" && "max-w-xl")}>
            {mode.kind === "confirm" ? (
              <ConfirmCard
                title={mode.plan.title}
                confirmLabel={mode.plan.confirmLabel}
                tone={mode.plan.tone}
                working={working}
                onConfirm={() => void confirm(mode.plan)}
                onCancel={() => setMode({ kind: "view" })}
              >
                {mode.plan.willSend !== null ? (
                  <>
                    <blockquote className="whitespace-pre-wrap rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg">
                      {mode.plan.willSend}
                    </blockquote>
                    <p className="mt-2 text-xs text-fg-3">
                      PAL sends this for you right away. It cannot be unsent.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-fg-3">Nothing is sent. The draft is closed and removed from your holds.</p>
                )}
              </ConfirmCard>
            ) : mode.kind === "edit" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" icon={<Check className="h-3 w-3" />} disabled={!text.trim()} onClick={() => stage("edit")}>
                  Review &amp; send
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setMode({ kind: "view" }); setText(draft.draftText); setRefusal(null); }}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" icon={<Check className="h-3 w-3" />} onClick={() => stage("approve")}>
                  Approve
                </Button>
                <Button size="sm" variant="secondary" icon={<Edit3 className="h-3 w-3" />} onClick={() => { setText(draft.draftText); setMode({ kind: "edit" }); }}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3 w-3" />} onClick={() => stage("discard")}>
                  Discard
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export interface FailedSend {
  id: string;
  who: string;
  channel: Draft["channel"];
  text: string;
  message: string;
}

/** Stays on screen until dismissed: the reply was NOT delivered and PAL won't retry. */
export function FailedSendNote({ item, onDismiss, onCopy }: { item: FailedSend; onDismiss: () => void; onCopy: (text: string) => void }) {
  return (
    <div role="alert" className="rounded-[12px] border border-bad/40 bg-bad-soft p-4">
      <p className="text-sm font-medium text-bad">Reply to {item.who} was not delivered</p>
      <p className="mt-1 text-xs text-fg-2">{item.message}</p>
      <blockquote className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg">{item.text}</blockquote>
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => onCopy(item.text)}>Copy text</Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </div>
    </div>
  );
}
