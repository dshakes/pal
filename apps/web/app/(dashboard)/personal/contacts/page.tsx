"use client";

// /personal/contacts — People & memory.
//
// People: GET /v1/people (the cross-channel person graph, newest 500).
// Memory for one person: GET /v1/memory/context?personId= — facts, handles and
// the unified recent timeline. Everything is read-only here; teaching happens
// in chat. Contacts the assistant has stepped aside for (you typed in the
// thread) come from the bridge's bot state and are shown read-only, and the
// section degrades to a note when the bridge is down.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { AlertTriangle, Search, UserMinus, Users } from "lucide-react";
import { api } from "@/lib/api";
import { useBridge } from "@/components/personal/bridge-context";
import { prettyJid } from "@/lib/whatsapp-personal-client";
import {
  PEOPLE_CAP, capNote, filterPeople, makeLatest, parseMemoryContext, parsePeople, personLabel, timeAgo,
  type MemoryContext, type PersonRow,
} from "@/lib/pal-space";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";

export default function PeopleAndMemoryPage() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listPeople()
      .then((raw) => {
        if (cancelled) return;
        setPeople(parsePeople(raw));
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load people");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = useMemo(() => filterPeople(people, query), [people, query]);
  const note = capNote("people", people.length, PEOPLE_CAP);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-fg">People &amp; memory</h2>
        <p className="mt-0.5 max-w-2xl text-[13px] text-fg-3">
          Everyone PAL knows across WhatsApp and iMessage, and what it remembers about them. To teach it something, tell it in your self-chat.
        </p>
      </div>

      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> Couldn&apos;t load people ({error}).
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-[320px_minmax(0,1fr)]">
        <section aria-label="People" className="min-w-0 rounded-[12px] border border-line bg-panel">
          <div className="border-b border-line p-3">
            <label className="relative block">
              <span className="sr-only">Search people</span>
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-fg-3" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or relationship"
                className="focus-ring h-8 w-full rounded-md border border-line bg-canvas pl-8 pr-2 text-[13px] text-fg placeholder:text-fg-3"
              />
            </label>
          </div>
          {loading ? (
            <div className="space-y-2 p-3" aria-busy="true">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : shown.length === 0 ? (
            <EmptyState
              icon={Users}
              size="compact"
              title={people.length === 0 ? (error ? "People unavailable" : "No people yet") : "No match"}
              description={
                people.length === 0
                  ? error
                    ? "Try again in a moment."
                    : "People appear once PAL has seen a conversation on a connected channel."
                  : "Nobody matches that search."
              }
            />
          ) : (
            <ul className="max-h-[60vh] divide-y divide-line overflow-auto">
              {shown.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(p.id)}
                    aria-pressed={selected === p.id}
                    className={clsx("focus-ring flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-hover", selected === p.id && "bg-accent-soft")}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-fg">
                        {personLabel(p)}
                        {p.isOwner && <span className="ml-1.5 text-[11px] font-normal text-fg-3">you</span>}
                      </span>
                      {p.relationship && <span className="block truncate text-[11px] text-fg-3">{p.relationship}</span>}
                    </span>
                    {p.updatedAt && <span className="shrink-0 text-[11px] text-fg-3">{timeAgo(p.updatedAt)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {note && <p className="border-t border-line px-3 py-2 text-[11px] text-fg-3">{note}</p>}
        </section>

        <MemoryPane personId={selected} name={people.find((p) => p.id === selected)} />
      </div>

      <PausedSection />
    </div>
  );
}

function MemoryPane({ personId, name }: { personId: string | null; name?: PersonRow }) {
  const [ctx, setCtx] = useState<MemoryContext | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  // A slow answer for a previously selected person must never render under the
  // current one: only the latest request may write state.
  const latest = useRef(makeLatest());

  const load = useCallback(async (id: string) => {
    const req = latest.current.begin();
    setState("loading");
    setCtx(null);
    try {
      const parsed = parseMemoryContext(await api.getMemoryContext(id, { limit: 30 }));
      if (!latest.current.isLatest(req) || (parsed && parsed.personId !== id)) return;
      setCtx(parsed);
      setState(parsed ? "idle" : "error");
    } catch {
      if (latest.current.isLatest(req)) setState("error");
    }
  }, []);

  useEffect(() => {
    if (personId) void load(personId);
    else latest.current.begin(); // deselect: invalidate anything in flight
  }, [personId, load]);

  if (!personId) {
    return (
      <section aria-label="Memory" className="rounded-[12px] border border-dashed border-line-strong bg-panel p-8 text-center text-[13px] text-fg-3">
        Pick someone to see what PAL remembers about them.
      </section>
    );
  }
  if (state === "loading") return <Skeleton className="h-64 w-full rounded-[12px]" />;
  if (state === "error" || !ctx) {
    return (
      <section aria-label="Memory" role="alert" className="rounded-[12px] border border-warn/30 bg-warn-soft p-4 text-[13px] text-warn">
        Couldn&apos;t load memory for {name ? personLabel(name) : "this person"}.{" "}
        <button type="button" className="underline" onClick={() => void load(personId)}>Retry</button>
      </section>
    );
  }
  return (
    <section aria-label="Memory" className="min-w-0 space-y-4 rounded-[12px] border border-line bg-panel p-4">
      <header>
        <h3 className="text-sm font-semibold text-fg">{ctx.displayName.trim() || (name ? personLabel(name) : "Unnamed contact")}</h3>
        <p className="text-xs text-fg-3">
          {ctx.relationship || "No relationship on file"}
          {ctx.handles.length > 0 && ` · ${ctx.handles.map((h) => `${h.channel}: ${h.channel === "whatsapp" ? prettyJid(h.handle) : h.handle}`).join(", ")}`}
        </p>
      </header>

      <div>
        <h4 className="text-xs font-semibold text-fg-2">Facts</h4>
        {ctx.facts.length === 0 ? (
          <p className="mt-1 text-xs text-fg-3">Nothing learned yet.</p>
        ) : (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px] text-fg">
            {ctx.facts.map((f, i) => <li key={`${i}-${f}`}>{f}</li>)}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold text-fg-2">Recent timeline</h4>
        {ctx.events.length === 0 ? (
          <p className="mt-1 text-xs text-fg-3">No conversation history recorded.</p>
        ) : (
          <ol className="mt-1 space-y-1.5">
            {ctx.events.map((e, i) => (
              <li key={`${i}-${e.occurredAt}`} className="rounded-lg bg-raised px-3 py-2 text-xs text-fg-2">
                <span className="mr-2 text-fg-3">
                  {e.direction === "out" ? "You" : e.direction === "in" ? "Them" : e.kind} · {e.channel} · {timeAgo(e.occurredAt)}
                </span>
                <span className="whitespace-pre-wrap text-fg">{e.content}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function PausedSection() {
  const { state, bot } = useBridge();
  const live = state === "connected" || state === "reconnecting";
  const paused = useMemo(
    () =>
      Object.entries(bot?.paused ?? {})
        .map(([jid, until]) => ({ jid, until: Number(until) }))
        .filter((e) => e.until > Date.now())
        .sort((a, b) => a.until - b.until),
    [bot?.paused],
  );
  return (
    <section aria-label="Paused contacts" className="rounded-[12px] border border-line bg-panel p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <UserMinus className="h-3.5 w-3.5 text-fg-3" aria-hidden /> Stepped aside for
      </h3>
      {!live ? (
        <p className="mt-1 text-xs text-fg-3">
          The bridge isn&apos;t reachable, so current pauses can&apos;t be read. <Link href="/personal/setup" className="text-accent hover:underline">Check channels</Link>
        </p>
      ) : paused.length === 0 ? (
        <p className="mt-1 text-xs text-fg-3">PAL isn&apos;t paused for anyone. When you type in a thread, it steps aside for that contact for a while.</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1 text-[13px] text-fg">
            {paused.map((p) => (
              <li key={p.jid} className="flex justify-between gap-3">
                <span>{prettyJid(p.jid)}</span>
                <span className="text-xs text-fg-3">resumes in {Math.max(1, Math.round((p.until - Date.now()) / 60_000))}m</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-fg-3">
            Pauses expire on their own. To end them early use <Link href="/personal/auto-reply" className="text-accent hover:underline">Auto-reply</Link>.
          </p>
        </>
      )}
    </section>
  );
}
