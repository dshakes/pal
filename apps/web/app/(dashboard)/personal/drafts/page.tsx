"use client";

// /personal/drafts — Holds: replies PAL parked for the owner instead of sending
// (commitment / grounding gates, draft-confirm, VIP drafts).
//
// GET /v1/whatsapp/drafts?status=… (newest 100, both channels mixed), acted on
// with POST /v1/whatsapp/drafts/{id}/act. Approve / edit / discard stop at a
// confirm card (components/personal/hold-card); a delivery failure is shown as
// "not delivered", never as success (lib/pal-space.holdOutcome).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Edit3, Inbox, RefreshCw, X } from "lucide-react";
import { listDrafts, prettyJid, type Draft } from "@/lib/whatsapp-personal-client";
import { DRAFTS_CAP, capNote, makeLatest, reconcileResolved, timeAgo } from "@/lib/pal-space";
import { useToast } from "@/components/toast";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { Tabs } from "@/components/tabs";
import { ChannelTag, FailedSendNote, HoldCard, type FailedSend } from "@/components/personal/hold-card";

type StatusTab = Draft["status"];
type ChannelFilter = "all" | Draft["channel"];

const TABS = [
  { id: "pending", label: "Waiting on you" },
  { id: "approved", label: "Approved" },
  { id: "edited", label: "Edited" },
  { id: "discarded", label: "Discarded" },
] as const;

const EMPTY: Record<StatusTab, { title: string; hint: string }> = {
  pending: { title: "No replies are being held", hint: "When PAL parks a reply for your OK, it shows up here and on Today." },
  approved: { title: "Nothing approved yet", hint: "Replies you approve land here. The server records approval, not delivery, so a send that failed still appears here." },
  edited: { title: "Nothing edited yet", hint: "Replies you changed before sending land here." },
  discarded: { title: "Nothing discarded yet", hint: "Drafts you chose not to send land here." },
};

export default function HoldsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<StatusTab>("pending");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);

  // Only the latest request may write state (a slow answer for a tab the owner
  // already left must not overwrite the current one), and drafts acted on this
  // session stay hidden from polls that were already in flight.
  const latest = useRef(makeLatest());
  const resolvedIds = useRef<Set<string>>(new Set());

  const refresh = useCallback(
    async (silent = false) => {
      const req = latest.current.begin();
      if (!silent) setLoading(true);
      try {
        const { drafts: next } = await listDrafts(tab);
        if (!latest.current.isLatest(req)) return;
        let rows = next ?? [];
        if (tab === "pending") {
          const r = reconcileResolved(rows, resolvedIds.current);
          resolvedIds.current = r.resolved;
          rows = r.rows;
        }
        setDrafts(rows);
        setError(null);
      } catch (e) {
        if (!latest.current.isLatest(req)) return;
        // Keep whatever was already on screen; say the refresh failed.
        setError(e instanceof Error ? e.message : "Couldn't load holds");
      } finally {
        if (latest.current.isLatest(req)) setLoading(false);
      }
    },
    [tab],
  );

  useEffect(() => {
    setDrafts([]);
    void refresh();
  }, [refresh]);

  // Poll only while triaging the pending queue.
  useEffect(() => {
    if (tab !== "pending") return;
    const id = setInterval(() => void refresh(true), 8000);
    return () => clearInterval(id);
  }, [tab, refresh]);

  const onOutcome: React.ComponentProps<typeof HoldCard>["onOutcome"] = (draft, _action, outcome, sentText) => {
    if (outcome.kind === "error") {
      toast.error(outcome.message);
      return;
    }
    resolvedIds.current.add(draft.id);
    setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
    if (outcome.kind === "delivery_failed" && sentText) {
      setFailedSends((prev) => [
        ...prev,
        { id: draft.id, who: draft.displayName || prettyJid(draft.jid), channel: draft.channel, text: sentText, message: outcome.message },
      ]);
    } else if (outcome.kind === "gone") toast.info(outcome.message);
    else toast.success(outcome.message);
  };

  const visible = useMemo(() => (channel === "all" ? drafts : drafts.filter((d) => d.channel === channel)), [drafts, channel]);
  const counts = useMemo(
    () => ({ whatsapp: drafts.filter((d) => d.channel === "whatsapp").length, imessage: drafts.filter((d) => d.channel === "imessage").length }),
    [drafts],
  );
  const note = capNote("drafts", drafts.length, DRAFTS_CAP);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">Holds</h2>
          <p className="mt-0.5 max-w-2xl text-[13px] text-fg-3">
            Replies PAL parked instead of sending. Approving sends the text through the channel that queued it, and nothing goes out until you confirm.
          </p>
        </div>
        <Button variant="ghost" size="sm" icon={<RefreshCw className="h-3 w-3" />} onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>

      <Tabs tabs={TABS} value={tab} onChange={(id) => setTab(id as StatusTab)} />

      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Couldn&apos;t refresh holds ({error}).{drafts.length > 0 ? " Showing the last list that loaded." : ""}
        </p>
      )}
      {note && <p className="text-xs text-fg-3">{note}</p>}

      {failedSends.map((f) => (
        <FailedSendNote
          key={f.id}
          item={f}
          onCopy={(t) => void navigator.clipboard.writeText(t).then(() => toast.success("Copied."), () => toast.error("Couldn't copy."))}
          onDismiss={() => setFailedSends((prev) => prev.filter((x) => x.id !== f.id))}
        />
      ))}

      {drafts.length > 0 && (
        <div className="flex items-center gap-1.5" role="group" aria-label="Filter by channel">
          {([["all", `All (${drafts.length})`], ["whatsapp", `WhatsApp (${counts.whatsapp})`], ["imessage", `iMessage (${counts.imessage})`]] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={channel === id}
              onClick={() => setChannel(id)}
              className={`focus-ring rounded-md border px-2 py-0.5 text-xs ${channel === id ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-fg-3 hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState icon={Inbox} title={EMPTY[tab].title} description={EMPTY[tab].hint} size="compact" />
      ) : tab === "pending" ? (
        <ul className="space-y-3" aria-label="Held replies">
          {visible.map((d) => (
            <li key={d.id}>
              <HoldCard draft={d} onOutcome={onOutcome} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y divide-line rounded-[12px] border border-line bg-panel" aria-label="Resolved replies">
          {visible.map((d) => (
            <li key={d.id} className="px-4 py-3">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                {d.displayName.trim() || prettyJid(d.jid)}
                <ChannelTag channel={d.channel} />
                <span className="inline-flex items-center gap-1 text-[11px] font-normal text-fg-3">
                  {d.status === "discarded" ? <X className="h-3 w-3" aria-hidden /> : d.status === "edited" ? <Edit3 className="h-3 w-3" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
                  queued {timeAgo(d.createdAt)}
                </span>
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs text-fg-3">They said: {d.inboundText}</p>
              {d.status !== "discarded" && (
                <p className="mt-1 whitespace-pre-wrap text-sm text-fg">{d.finalText || d.draftText}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
