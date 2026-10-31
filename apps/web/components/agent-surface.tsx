"use client";
// AgentSurface — the agent panel every page mounts. Three verbs:
//   Ask     — words → the shared assist engine (same allowlist + validation as ⌘K)
//   Explain — server-grounded explanations of what the page is showing
//   Act     — any state change the agent proposes stops at a ConfirmCard
// A page describes itself with useAgentSurface({ page, facts, explain, ... });
// the layout owns one sheet. Toggle: ⌘\ or the topbar button.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowUp, Sparkles, X } from "lucide-react";
import clsx from "clsx";
import type { ExplainRequest } from "@/lib/api";
import { ExplainInline } from "@/components/explain-inline";
import { PlanView, useAssist } from "@/components/assist-plan";
import { Kbd } from "@/components/ui";

export interface ExplainTarget {
  id: string;
  label: string;
  sub?: string;
  request: ExplainRequest;
}

export interface PageAgentContext {
  /** Human page name, e.g. "Overview". */
  page: string;
  /** Short, real facts the page is showing (counts, states) — grounding for Ask. */
  facts: string[];
  /** Starter questions shown as chips. */
  suggestions?: string[];
  /** Things on screen the agent can explain (server-grounded). */
  explain?: ExplainTarget[];
}

interface SurfaceState {
  open: boolean;
  setOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  ctx: PageAgentContext | null;
  setCtx: (c: PageAgentContext | null) => void;
}

const SurfaceContext = createContext<SurfaceState | null>(null);

export function AgentSurfaceProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<PageAgentContext | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setOpen((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const value = useMemo(() => ({ open, setOpen, ctx, setCtx }), [open, ctx]);
  return <SurfaceContext.Provider value={value}>{children}</SurfaceContext.Provider>;
}

export function useAgentSurfaceToggle() {
  const s = useContext(SurfaceContext);
  return { open: s?.open ?? false, toggle: () => s?.setOpen((p) => !p) };
}

/** Pages call this to describe themselves to the agent. Cleared on unmount. */
export function useAgentSurface(ctx: PageAgentContext) {
  // Depend on the (stable) setter and a serialized key, not on the context
  // value: the value changes whenever ctx does, which would re-run this
  // effect forever. The key re-runs it only when the page's facts change.
  const setCtx = useContext(SurfaceContext)?.setCtx;
  const key = JSON.stringify(ctx);
  useEffect(() => {
    setCtx?.(JSON.parse(key) as PageAgentContext);
    return () => setCtx?.(null);
  }, [key, setCtx]);
}

export function AgentSurface() {
  const s = useContext(SurfaceContext);
  const open = s?.open ?? false;
  const close = useCallback(() => s?.setOpen(false), [s]);
  const ctx = s?.ctx;
  const { plan, setPlan, ask, reset, loadContext, confirmAgent, confirmVms } = useAssist(close);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) void loadContext();
    else { reset(); setQ(""); }
  }, [open, loadContext, reset]);

  const onScreen = ctx ? `${ctx.page} page. ${ctx.facts.join("; ")}` : undefined;
  const submit = (text: string) => {
    if (text.trim().length < 2) return;
    setQ(text);
    void ask(text, onScreen);
  };

  // ≥1024px the panel docks beside the page and reflows it (nothing is
  // covered); below that it is a modal sheet with a scrim.
  const docked = useMediaQuery("(min-width: 1024px)");
  useEffect(() => {
    if (open && docked) inputRef.current?.focus();
  }, [open, docked]);
  const Title = docked ? "h2" : Dialog.Title;
  const Desc = docked ? "p" : Dialog.Description;
  const CloseBtn = docked ? "button" : Dialog.Close;

  const body = (
    <>
          <header className="flex items-center gap-2.5 border-b border-line px-4 py-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <Title className="text-[14px] font-semibold text-fg">PAL agent</Title>
              <Desc className="truncate text-[12px] text-fg-3">
                {ctx ? `Looking at ${ctx.page}` : "Ask about anything in this workspace"}
              </Desc>
            </div>
            <span className="hidden sm:inline-flex"><Kbd>⌘\</Kbd></span>
            <CloseBtn type="button" onClick={close} className="focus-ring rounded-md p-1.5 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close agent panel">
              <X className="h-4 w-4" />
            </CloseBtn>
          </header>

          <Tabs.Root defaultValue="ask" className="flex min-h-0 flex-1 flex-col">
            <Tabs.List aria-label="Agent" className="flex gap-1 border-b border-line px-3">
              {[["ask", "Ask"], ["explain", "Explain"]].map(([v, l]) => (
                <Tabs.Trigger
                  key={v}
                  value={v}
                  className="focus-ring relative -mb-px h-10 px-2.5 text-[13px] font-medium text-fg-3 hover:text-fg data-[state=active]:text-fg data-[state=active]:shadow-[inset_0_-2px_0_var(--color-accent)]"
                >
                  {l}
                  {v === "explain" && ctx?.explain?.length ? (
                    <span className="num ml-1.5 rounded bg-raised px-1 text-[11px] text-fg-3">{ctx.explain.length}</span>
                  ) : null}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            <Tabs.Content value="ask" className="flex min-h-0 flex-1 flex-col outline-none">
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                {ctx && ctx.facts.length > 0 && (
                  <section aria-label="What the agent can see">
                    <p className="text-[12px] text-fg-3">On this page</p>
                    <ul className="mt-1.5 space-y-1">
                      {ctx.facts.slice(0, 6).map((f) => (
                        <li key={f} className="flex gap-2 text-[13px] text-fg-2">
                          <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-fg-3" />
                          {f}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {plan ? (
                  <PlanView plan={plan} setPlan={setPlan} onConfirmAgent={confirmAgent} onConfirmVms={confirmVms} onNavigate={close} />
                ) : (
                  ctx?.suggestions?.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {ctx.suggestions.map((sug) => (
                        <button
                          key={sug}
                          type="button"
                          onClick={() => submit(sug)}
                          className="focus-ring rounded-full border border-line-strong px-2.5 py-1 text-[12px] text-fg-2 hover:border-accent hover:text-fg"
                        >
                          {sug}
                        </button>
                      ))}
                    </div>
                  ) : null
                )}
              </div>
              <form
                className="border-t border-line p-3"
                onSubmit={(e) => { e.preventDefault(); submit(q); }}
              >
                <div className="flex items-end gap-2 rounded-[10px] border border-line-strong bg-canvas p-2 focus-within:border-accent">
                  <label htmlFor="agent-ask" className="sr-only">Ask PAL</label>
                  <textarea
                    id="agent-ask"
                    ref={inputRef}
                    rows={2}
                    value={q}
                    onChange={(e) => { setQ(e.target.value); if (plan) reset(); }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(q); } }}
                    placeholder="Ask, or tell PAL what to do"
                    className="min-h-[40px] flex-1 resize-none bg-transparent text-[13.5px] text-fg !shadow-none !outline-none placeholder:text-fg-3"
                  />
                  <button
                    type="submit"
                    aria-label="Send"
                    disabled={q.trim().length < 2}
                    className={clsx("focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-action text-on-action hover:bg-action/90 disabled:opacity-40")}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-1.5 text-[11.5px] text-fg-3">Changes always stop for your confirmation.</p>
              </form>
            </Tabs.Content>

            <Tabs.Content value="explain" className="min-h-0 flex-1 overflow-y-auto p-4 outline-none">
              {ctx?.explain?.length ? (
                <ul className="space-y-3">
                  {ctx.explain.map((t) => (
                    <li key={t.id} className="rounded-[10px] border border-line p-3">
                      <p className="truncate text-[13px] font-medium text-fg">{t.label}</p>
                      {t.sub && <p className="mt-0.5 line-clamp-2 text-[12px] text-fg-3">{t.sub}</p>}
                      <ExplainInline request={t.request} label="Explain" size="xs" className="mt-2" />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="py-10 text-center">
                  <p className="text-[13px] text-fg-2">Nothing here needs explaining.</p>
                  <p className="mt-1 text-[12px] text-fg-3">Failed runs and eval cases on this page show up here.</p>
                </div>
              )}
            </Tabs.Content>
          </Tabs.Root>
    </>
  );

  if (docked) {
    return open ? (
      <aside
        aria-label="PAL agent"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}
        className="v3-sheet flex w-[400px] shrink-0 flex-col border-l border-line bg-panel"
      >
        {body}
      </aside>
    ) : null;
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => s?.setOpen(o)}>
      <Dialog.Portal>
        <Dialog.Overlay className="v3-overlay fixed inset-0 z-[70] bg-black/50" />
        <Dialog.Content
          className="v3-sheet fixed inset-y-0 right-0 z-[71] flex w-full flex-col border-l border-line bg-panel shadow-[var(--elev-4)] outline-none sm:w-[420px]"
          onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
        >
          {body}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function useMediaQuery(q: string): boolean {
  // Start from the real answer on the client so the first open lands in the
  // right mode (SSR has no window; the panel renders nothing while closed).
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}
