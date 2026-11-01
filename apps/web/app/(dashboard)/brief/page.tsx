"use client";

// /brief — Today. The pal home: one ranked list of what needs the owner.
//
// Sources, each of which can fail on its own (a down source is NAMED, never
// faked, and the rest still render):
//   held replies   GET /v1/whatsapp/drafts?status=pending   (newest 100)
//   suggestions    GET /v1/life-events?status=suggested
//   commitments    GET /v1/commitments?status=open          (urgency-first)
//   threads        each bridge's attention snapshot, READ-ONLY via /api/bridge
// Ranking = deterministic base order + at most one control-plane LLM pass that
// may only reorder/annotate (lib/brief). Acting on a held reply or dismissing a
// suggestion always stops at a confirm card. Threads are copy-a-chat-command
// only: chat is their acting surface and the dashboard never mutates a bridge.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Clock, Copy, Inbox, Loader2, MessageCircle, RefreshCw, Smartphone, Sparkles, X, Zap } from "lucide-react";
import { api, type Commitment, type LifeEvent } from "@/lib/api";
import { listDrafts, prettyJid, type Draft } from "@/lib/whatsapp-personal-client";
import { fetchAttention, fetchHealth } from "@/lib/bridge-client";
import { BRIDGE_CHANNELS, type BridgeChannel } from "@/lib/bridge-types";
import { useAuth } from "@/lib/auth";
import { useModels } from "@/lib/model-context";
import { useToast } from "@/components/toast";
import { Button } from "@/components/button";
import { Skeleton } from "@/components/skeleton";
import { PageHeader } from "@/components/page-header";
import { ConfirmCard } from "@/components/confirm-card";
import { EmptyState } from "@/components/empty-state";
import { AskBar } from "@/components/ask-bar";
import { SuggestedSteps } from "@/components/suggested-steps";
import { FailedSendNote, HoldCard, type FailedSend } from "@/components/personal/hold-card";
import {
  RANK_SYSTEM_PROMPT, applyRank, buildBriefItems, buildRankPrompt, greeting, parseRank, rankCacheKey, type BriefItem,
} from "@/lib/brief";
import {
  BRIEF_SOURCE_LIMIT, DRAFTS_CAP, bridgeLinkFromError, capNote, dataOr, failedLabels, itemSetKey, makeLatest, needsRank, reconcileResolved, settle, threadsFromSnapshots,
  timeAgo, type BridgeLink, type SnapshotThread,
} from "@/lib/pal-space";

type Rank = { order: string[]; why: Record<string, string>; covered: ReadonlySet<string> };
type StaleSnap = { channel: string; generatedAt: number };
const CHANNEL_NAME: Record<BridgeChannel, string> = { whatsapp: "WhatsApp", imessage: "iMessage" };

export default function TodayPage() {
  const { user } = useAuth();
  const { isConfigured } = useModels();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [events, setEvents] = useState<LifeEvent[]>([]);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [threads, setThreads] = useState<SnapshotThread[]>([]);
  const [stale, setStale] = useState<StaleSnap[]>([]);
  const [link, setLink] = useState<Record<BridgeChannel, BridgeLink>>({ whatsapp: "unknown", imessage: "unknown" });
  const [failed, setFailed] = useState<string[]>([]);
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);
  const [rank, setRank] = useState<Rank | null>(null);
  const [ranking, setRanking] = useState(false);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismissBusy, setDismissBusy] = useState(false);

  const tenantId = user?.tenantId;
  // Late polls must not overwrite newer ones, nor resurrect a draft acted on this session.
  const latestLoad = useRef(makeLatest());
  const resolvedIds = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const req = latestLoad.current.begin();
    const [d, e, c] = await Promise.all([
      settle(listDrafts("pending").then((r) => r.drafts ?? [])),
      settle(api.listLifeEvents({ status: "suggested", limit: BRIEF_SOURCE_LIMIT })),
      settle(api.listCommitments({ status: "open", limit: BRIEF_SOURCE_LIMIT, strict: true })),
    ]);
    // Bridges: health first, then the read-only attention snapshot. Any failure
    // degrades to "offline"/no threads — never to an error page.
    const nextLink: Record<BridgeChannel, BridgeLink> = { whatsapp: "unknown", imessage: "unknown" };
    const snaps = await Promise.all(
      BRIDGE_CHANNELS.map(async (ch) => {
        try {
          await fetchHealth(ch);
          nextLink[ch] = "online";
        } catch (err) {
          nextLink[ch] = bridgeLinkFromError(err);
          return null;
        }
        if (!tenantId) return null;
        return fetchAttention(tenantId, ch).catch(() => null);
      }),
    );
    if (!latestLoad.current.isLatest(req)) return;
    const t = threadsFromSnapshots(snaps, Date.now());
    const rec = d.ok ? reconcileResolved(d.data, resolvedIds.current) : { rows: [] as Draft[], resolved: resolvedIds.current };
    resolvedIds.current = rec.resolved;
    setDrafts(rec.rows);
    setEvents(dataOr(e, []));
    setCommitments(dataOr(c, []));
    setThreads(t.threads);
    setStale(t.stale);
    setLink(nextLink);
    setFailed(failedLabels([["held replies", d], ["suggestions", e], ["commitments", c]]));
    setLoading(false);
  }, [tenantId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const base = useMemo(
    () =>
      buildBriefItems({
        holds: drafts.map((x) => ({ ...x, displayName: x.displayName || prettyJid(x.jid) })),
        lifeEvents: events,
        commitments,
        threads: threads.map((t) => ({ id: t.id, label: t.label, why: t.why, channel: t.channel })),
      }),
    [drafts, events, commitments, threads],
  );
  const baseSig = itemSetKey(base); // sorted: a reorder is not a new set
  const baseRef = useRef(base);
  baseRef.current = base;
  const rankRef = useRef(rank);
  rankRef.current = rank;

  // One reorder-only LLM pass per distinct item set. Resolving a card shrinks
  // the set and never re-ranks; a failed pass is remembered (covered) so the
  // 30s poll does not retry it.
  useEffect(() => {
    const items = baseRef.current;
    if (!isConfigured || !needsRank(items, rankRef.current?.covered ?? null)) return;
    const covered = new Set(items.map((i) => i.key));
    const cacheKey = rankCacheKey(items);
    try {
      const hit = sessionStorage.getItem(cacheKey);
      const cached = hit ? parseRank(hit, items) : null;
      if (cached) {
        setRank({ ...cached, covered });
        return;
      }
    } catch {
      /* storage unavailable: just rank */
    }
    let cancelled = false;
    setRanking(true);
    void api.assistJSON(RANK_SYSTEM_PROMPT, buildRankPrompt(items), { maxTokens: 500 }).then((raw) => {
      if (cancelled) return;
      const parsed = raw ? parseRank(raw, items) : null;
      setRank({ order: parsed?.order ?? [], why: parsed?.why ?? {}, covered });
      setRanking(false);
      if (parsed) {
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify(parsed));
        } catch {
          /* ignore */
        }
      }
    });
    return () => {
      cancelled = true;
      setRanking(false);
    };
  }, [baseSig, isConfigured]);

  const items = useMemo(() => applyRank(base, rank), [base, rank]);
  const draftById = useMemo(() => new Map(drafts.map((d) => [d.id, d])), [drafts]);
  const threadByKey = useMemo(() => new Map(threads.map((t) => [`thread:${t.channel}:${t.id}`, t])), [threads]);

  const onHoldOutcome: React.ComponentProps<typeof HoldCard>["onOutcome"] = (draft, _action, outcome, sentText) => {
    if (outcome.kind === "error") {
      toast.error(outcome.message);
      return;
    }
    resolvedIds.current.add(draft.id);
    setDrafts((prev) => prev.filter((x) => x.id !== draft.id));
    if (outcome.kind === "delivery_failed" && sentText) {
      setFailedSends((prev) => [
        ...prev,
        { id: draft.id, who: draft.displayName || prettyJid(draft.jid), channel: draft.channel, text: sentText, message: outcome.message },
      ]);
    } else if (outcome.kind === "gone") toast.info(outcome.message);
    else toast.success(outcome.message);
  };

  const dismissEvent = async (id: string) => {
    setDismissBusy(true);
    try {
      await api.dismissLifeEvent(id);
      setEvents((prev) => prev.filter((e) => e.id !== id));
      setDismissing(null);
      toast.success("Dismissed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't dismiss that.");
    } finally {
      setDismissBusy(false);
    }
  };

  const copy = (text: string, done: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success(done),
      () => toast.error("Couldn't copy."),
    );

  const now = new Date();
  const firstName = user?.name?.split(" ")[0];
  const holdCount = drafts.length;
  const anyOnline = link.whatsapp === "online" || link.imessage === "online";
  const notes = [
    capNote("held replies", drafts.length, DRAFTS_CAP),
    capNote("suggestions", events.length, BRIEF_SOURCE_LIMIT),
    capNote("open commitments", commitments.length, BRIEF_SOURCE_LIMIT),
  ].filter((n): n is string => n !== null);

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title={`${greeting(now.getHours())}${firstName ? `, ${firstName}` : ""}`}
        description={
          loading
            ? "Gathering what needs you…"
            : items.length === 0
              ? "Nothing needs you right now."
              : `${items.length} thing${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} you${holdCount ? `, ${holdCount} repl${holdCount === 1 ? "y" : "ies"} waiting for your OK` : ""}.`
        }
      />
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-8">
        <div className="mb-6">
          <AskBar
            placeholder="Ask PAL anything, like “what did I miss?”"
            examples={["What needs me today?", "Show replies waiting on me", "Open automations"]}
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section aria-labelledby="needs-you" className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="needs-you" className="flex items-center gap-2 text-sm font-semibold text-fg">
                What needs you
                {ranking && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-normal text-fg-3">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> ranking
                  </span>
                )}
                {rank && rank.order.length > 0 && !ranking && (
                  <span className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium text-fg-3">
                    <Sparkles className="h-2.5 w-2.5 text-accent" aria-hidden /> ranked by PAL
                  </span>
                )}
              </h2>
              <Button variant="ghost" size="sm" icon={<RefreshCw className="h-3 w-3" />} onClick={() => void load()}>
                Refresh
              </Button>
            </div>

            {failed.length > 0 && (
              <p role="status" className="mb-3 flex items-center gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                Couldn&apos;t load {failed.join(" and ")}. Showing what loaded.
              </p>
            )}
            {notes.map((n) => (
              <p key={n} className="mb-3 text-xs text-fg-3">{n}</p>
            ))}

            {failedSends.length > 0 && (
              <div className="mb-3 space-y-2">
                {failedSends.map((f) => (
                  <FailedSendNote
                    key={f.id}
                    item={f}
                    onCopy={(t) => void copy(t, "Copied.")}
                    onDismiss={() => setFailedSends((prev) => prev.filter((x) => x.id !== f.id))}
                  />
                ))}
              </div>
            )}

            {loading ? (
              <div className="space-y-2" aria-busy="true">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 w-full rounded-xl" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="You're all caught up"
                description={
                  failed.length > 0
                    ? "Some sources didn't load, so this may not be everything."
                    : anyOnline
                      ? "Held replies, suggestions and threads waiting on you show up here."
                      : "Connect a channel so PAL can start catching what needs you."
                }
                {...(!anyOnline ? { actionLabel: "Connect a channel", actionHref: "/personal/setup" } : {})}
              />
            ) : (
              <ol className="space-y-2" aria-label="Ranked items">
                {items.map((item) => (
                  <li key={item.key}>
                    {item.kind === "hold" && draftById.get(item.id) ? (
                      <HoldCard draft={draftById.get(item.id)!} why={item.why} onOutcome={onHoldOutcome} />
                    ) : item.kind === "life_event" ? (
                      <>
                        <RowCard item={item} icon={Zap}>
                          <Button size="sm" variant="ghost" icon={<X className="h-3 w-3" />} onClick={() => setDismissing(item.id)}>Dismiss</Button>
                          <Link href="/automations" className="text-[12px] font-medium text-accent hover:underline">Open</Link>
                        </RowCard>
                        {dismissing === item.id && (
                          <div className="mt-2 max-w-xl">
                            <ConfirmCard
                              title="Dismiss this suggestion?"
                              confirmLabel="Dismiss"
                              working={dismissBusy}
                              onConfirm={() => void dismissEvent(item.id)}
                              onCancel={() => setDismissing(null)}
                            >
                              It leaves your Today list. PAL takes no other action.
                            </ConfirmCard>
                          </div>
                        )}
                      </>
                    ) : item.kind === "commitment" ? (
                      <RowCard item={item} icon={Clock}>
                        <Link href="/personal" className="text-[12px] font-medium text-accent hover:underline">View</Link>
                      </RowCard>
                    ) : item.kind === "thread" && threadByKey.get(item.key) ? (
                      <RowCard item={item} icon={MessageCircle}>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Copy className="h-3 w-3" />}
                          onClick={() => {
                            const t = threadByKey.get(item.key)!;
                            const cmd = `${t.n} ${t.defaultAction}`;
                            void copy(cmd, `Copied “${cmd}”. Send it in your self-chat.`);
                          }}
                        >
                          Copy chat command
                        </Button>
                      </RowCard>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <aside className="space-y-4">
            <section aria-label="Channels" className="rounded-[12px] border border-line bg-panel p-4">
              <h2 className="text-xs font-semibold text-fg">Channels</h2>
              <ul className="mt-2.5 space-y-2">
                {BRIDGE_CHANNELS.map((ch) => (
                  <li key={ch} className="flex items-center justify-between text-xs" data-testid={`bridge-${ch}`}>
                    <span className="flex items-center gap-2 text-fg-2">
                      <Smartphone className="h-3.5 w-3.5 text-fg-3" aria-hidden />
                      {CHANNEL_NAME[ch]}
                    </span>
                    <span className={clsx("flex items-center gap-1.5", link[ch] === "online" ? "text-ok" : link[ch] === "auth_required" ? "text-warn" : "text-fg-3")}>
                      <span className={clsx("h-1.5 w-1.5 rounded-full", link[ch] === "online" ? "bg-ok" : link[ch] === "auth_required" ? "bg-warn" : "bg-fg-3")} aria-hidden />
                      {link[ch] === "online" ? "Connected" : link[ch] === "offline" ? "Offline" : link[ch] === "auth_required" ? "Needs token" : "Checking"}
                    </span>
                  </li>
                ))}
              </ul>
              {BRIDGE_CHANNELS.some((c) => link[c] === "offline" || link[c] === "auth_required") && (
                <p className="mt-2 text-[11px] text-fg-3">
                  Threads waiting on you from an unreachable channel aren&apos;t shown until it&apos;s back.
                </p>
              )}
              {stale.map((s) => (
                <p key={s.channel} className="mt-2 text-[11px] text-fg-3" data-testid="stale-snapshot">
                  {s.channel === "whatsapp" ? "WhatsApp" : "iMessage"}&apos;s waiting-threads list is from {timeAgo(new Date(s.generatedAt).toISOString())}, so it is hidden. Ask for “today” in your self-chat to refresh it.
                </p>
              ))}
              <Link href="/personal/setup" className="mt-3 inline-flex text-[12px] font-medium text-accent hover:underline">
                Manage channels
              </Link>
            </section>

            <section aria-label="At a glance" className="grid grid-cols-2 gap-2">
              <Stat label="Held replies" value={loading ? "—" : String(holdCount)} href="/personal/drafts" icon={Inbox} />
              <Stat label="Suggestions" value={loading ? "—" : String(events.length)} href="/automations" icon={Zap} />
            </section>

            <SuggestedSteps
              page="pal Today (personal home)"
              facts={[
                `${holdCount} held replies`,
                `${events.length} suggested automations`,
                `${commitments.length} open commitments`,
                `WhatsApp ${link.whatsapp}`,
                `iMessage ${link.imessage}`,
                isConfigured ? "model provider configured" : "no model provider key",
              ]}
              fallback={[
                ...(isConfigured ? [] : [{ label: "Add a model provider key", href: "/settings?tab=providers" }]),
                ...(anyOnline ? [] : [{ label: "Connect WhatsApp or iMessage", href: "/personal/setup" }]),
                { label: "Tune automation trust levels", href: "/automations" },
                { label: "Teach PAL about your people", href: "/personal/contacts" },
              ].slice(0, 3)}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, href, icon: Icon }: { label: string; value: string; href: string; icon: typeof Inbox }) {
  return (
    <Link href={href} className="focus-ring rounded-[12px] border border-line bg-panel p-3 transition-colors hover:bg-hover">
      <Icon className="h-3.5 w-3.5 text-fg-3" aria-hidden />
      <p className="mt-2 text-xl font-semibold tabular-nums text-fg">{value}</p>
      <p className="text-[11px] text-fg-3">{label}</p>
    </Link>
  );
}

function RowCard({ item, icon: Icon, children }: { item: BriefItem; icon: typeof Inbox; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-4 sm:flex-row sm:items-center">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-fg-3">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{item.title}</p>
        <p className="truncate text-xs text-fg-3">
          {item.detail}
          {item.channel ? ` · ${item.channel}` : ""}
        </p>
        {item.why && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-accent">
            <Sparkles className="h-2.5 w-2.5" aria-hidden /> {item.why}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
