"use client";

// Support tab of the agent panel (ADR 0059): ask "why did X happen / how do
// I…", answered from this workspace's own runs and incidents and the PAL docs.
// It can hand off to the debug agent, link a page, or escalate to a person with
// a redacted, signed bundle (confirmed first, like every other write).

import { useState } from "react";
import Link from "next/link";
import { ArrowUp, BookOpen, LifeBuoy, Loader2 } from "lucide-react";
import { api, AssistError } from "@/lib/api";
import { docsHref, safeInternalHref, shortRef, splitRefs, type SupportAnswer } from "@/lib/debug";
import { ConfirmCard } from "@/components/confirm-card";
import { DebugThis } from "@/components/debug-panel";
import { useCan } from "@/components/role-gate";

type Turn = { role: "user" | "agent"; text: string };

const DOCS_BASE = process.env.NEXT_PUBLIC_DOCS_BASE_URL;

export function SupportPanel({ onNavigate, runId }: { onNavigate?: () => void; runId?: string }) {
  const canAsk = useCan("runs:execute");
  const [q, setQ] = useState("");
  const [history, setHistory] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState<SupportAnswer | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [err, setErr] = useState("");
  const [escalate, setEscalate] = useState<"closed" | "confirm" | "sending" | { id: string; digest: string }>("closed");
  const [escErr, setEscErr] = useState("");

  const ask = async (text: string) => {
    const question = text.trim();
    if (question.length < 2) return;
    setState("loading");
    setEscalate("closed");
    try {
      const a = await api.supportAsk(question, { runId, history: history.slice(-6) });
      setAnswer(a);
      setHistory((h) => [...h, { role: "user" as const, text: question }, { role: "agent" as const, text: a.answer }].slice(-12));
      setQ("");
      setState("idle");
    } catch (e) {
      setErr(e instanceof AssistError ? e.message : "Couldn't get an answer right now.");
      setState("error");
    }
  };

  const lastQuestion = [...history].reverse().find((t) => t.role === "user")?.text ?? q.trim();
  const sendEscalation = async () => {
    setEscalate("sending");
    setEscErr("");
    try {
      const r = await api.supportEscalate({ question: lastQuestion || "Help needed", runId, transcript: history });
      setEscalate({ id: r.id, digest: r.digest });
    } catch (e) {
      setEscErr(e instanceof Error ? e.message.replace(/^API \d+: /, "") : "Escalation failed.");
      setEscalate("confirm");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {!answer && state !== "loading" && (
          <div className="rounded-[10px] border border-line p-3">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
              <LifeBuoy className="h-3.5 w-3.5 text-accent" aria-hidden /> Support
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-3">
              Ask why something happened or how to do something. Answers come from this workspace&apos;s runs and incidents and the PAL docs. When it can&apos;t answer, you can hand the question to a person.
            </p>
          </div>
        )}
        {state === "loading" && (
          <p className="flex items-center gap-1.5 text-[13px] text-fg-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Checking your runs and the docs…
          </p>
        )}
        {state === "error" && <p role="alert" className="rounded-md bg-warn-soft px-3 py-2 text-[12px] text-warn">{err}</p>}
        {answer && state !== "loading" && (
          <section aria-label="Support answer" className="space-y-2.5">
            <p className="text-[13px] leading-relaxed text-fg">
              {splitRefs(answer.answer).map((part, i) =>
                part.ref ? (
                  <span key={i} className="mx-0.5 rounded bg-raised px-1 font-mono text-[11px] text-fg-2 ring-1 ring-line" title={part.ref}>{shortRef(part.ref)}</span>
                ) : (
                  <span key={i}>{part.text}</span>
                ),
              )}
            </p>
            {answer.docs.length > 0 && (
              <ul className="space-y-1" aria-label="Docs">
                {answer.docs.map((d) => {
                  const href = docsHref(d.path, DOCS_BASE);
                  return (
                    <li key={d.slug} className="flex items-center gap-1.5 text-[12px] text-fg-2">
                      <BookOpen className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden />
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-fg">{d.title}</a>
                      ) : (
                        <span>{d.title} <span className="font-mono text-fg-3">{d.path}</span></span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {answer.actions.length > 0 && (
              <div className="flex flex-col items-start gap-2">
                {answer.actions.map((a) =>
                  a.kind === "debug_run" ? (
                    <DebugThis key={a.runId} target={{ kind: "run", runId: a.runId }} label={a.label ?? "Debug this run"} />
                  ) : a.kind === "debug_incident" ? (
                    <DebugThis key={a.incidentId} target={{ kind: "incident", incidentId: a.incidentId }} label={a.label ?? "Debug this incident"} />
                  ) : safeInternalHref(a.href) ? (
                    <Link
                      key={a.href}
                      href={a.href}
                      onClick={onNavigate}
                      className="focus-ring inline-flex h-7 items-center rounded-md border border-line-strong px-2.5 text-[12px] text-fg-2 hover:border-accent hover:text-fg"
                    >
                      {a.label ?? "Open"}
                    </Link>
                  ) : null,
                )}
              </div>
            )}
          </section>
        )}

        {(answer || history.length > 0) && (
          <div className="border-t border-line pt-3">
            {escalate === "closed" ? (
              <button
                type="button"
                onClick={() => setEscalate("confirm")}
                className={
                  answer?.suggestEscalation
                    ? "focus-ring inline-flex h-8 items-center rounded-md bg-action px-3 text-[13px] font-medium text-on-action hover:bg-action/90"
                    : "focus-ring inline-flex h-7 items-center rounded-md px-1 text-[12px] text-fg-3 underline underline-offset-2 hover:text-fg"
                }
              >
                {answer?.suggestEscalation ? "Hand this to a person" : "Still stuck? Escalate to a person"}
              </button>
            ) : escalate === "confirm" || escalate === "sending" ? (
              <ConfirmCard
                title="Escalate to a person"
                confirmLabel="Send to support"
                working={escalate === "sending"}
                onConfirm={sendEscalation}
                onCancel={() => setEscalate("closed")}
              >
                <p className="text-[12px] leading-relaxed text-fg-2">
                  Sends your question, this conversation{runId ? ", and the run's steps, errors and token counts" : ""}. Run input and output values are never included. Secrets are removed and emails and phone numbers are masked. The bundle is signed.
                </p>
                {escErr && <p className="mt-1.5 text-[12px] text-bad">{escErr}</p>}
              </ConfirmCard>
            ) : (
              <p role="status" className="rounded-md bg-ok-soft px-2.5 py-2 text-[12px] text-ok">
                Escalated. Reference <span className="font-mono">{escalate.id.slice(0, 8)}</span>, bundle digest{" "}
                <span className="font-mono">{escalate.digest.slice(0, 12)}</span>.
              </p>
            )}
          </div>
        )}
      </div>
      {canAsk ? (
        <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void ask(q); }}>
          <div className="flex items-end gap-2 rounded-[10px] border border-line-strong bg-canvas p-2 focus-within:border-accent">
            <label htmlFor="support-ask" className="sr-only">Ask support</label>
            <textarea
              id="support-ask"
              rows={2}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(q); } }}
              placeholder="Why did my run fail? How do I…?"
              className="min-h-[40px] flex-1 resize-none bg-transparent text-[13.5px] text-fg !shadow-none !outline-none placeholder:text-fg-3"
            />
            <button
              type="submit"
              aria-label="Ask"
              disabled={q.trim().length < 2 || state === "loading"}
              className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-action text-on-action hover:bg-action/90 disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </form>
      ) : (
        <p className="border-t border-line p-3 text-[12px] text-fg-3">Your role can&apos;t run the support agent.</p>
      )}
    </div>
  );
}
