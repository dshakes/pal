"use client";
// ─────────────────────────────────────────────────────────────────────────
// ⌘K — search + Ask PAL, on cmdk (combobox semantics, roving selection,
// fuzzy filter) inside a Radix dialog (focus trap + return, Escape, portal).
//
// Mounted ONCE in (dashboard)/layout.tsx. Opens on ⌘K / Ctrl+K, or from any
// inline command bar via openAsk() (lib/ask-events). Type to filter pages,
// agents and runs; the "Ask PAL" row hands the words to the shared assist
// engine (components/assist-plan → lib/assistant: allowlisted routes, ids only
// from real context). Navigation, answers and explanations run directly;
// anything that changes state stops at a ConfirmCard.
// ─────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot, CircleDot, Gauge, Hash, Inbox, Loader2, Play, Plug, Plus, RefreshCw, Repeat, Server,
  Settings, Sparkles, Sun, Zap, type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { ASK_EVENT, type AskEventDetail } from "@/lib/ask-events";
import { MODE_LABEL } from "@/lib/workspace-nav";
import { useWorkspaceMode } from "@/lib/use-workspace-mode";
import { PlanView, useAssist } from "@/components/assist-plan";
import { Kbd } from "@/components/ui";

export function CommandPalette() {
  const router = useRouter();
  const { mode, switchTo } = useWorkspaceMode();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pendingSubmit = useRef<string | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const { plan, setPlan, ask, reset, loadContext, confirmAgent, confirmVms, agentNames, runs } = useAssist(close);

  const go = useCallback((path: string) => { router.push(path); setOpen(false); }, [router]);

  // Open → load real context (and run a queued openAsk({submit})). Close → reset.
  useEffect(() => {
    if (open) {
      void loadContext().then(() => {
        const q = pendingSubmit.current;
        pendingSubmit.current = null;
        if (q) void ask(q);
      });
    } else {
      reset();
      setQuery("");
    }
    // ask is read at open time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadContext, reset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((p) => !p);
      }
    };
    const onAsk = (e: Event) => {
      const d = (e as CustomEvent<AskEventDetail>).detail ?? {};
      setQuery(d.query ?? "");
      if (d.submit && d.query) pendingSubmit.current = d.query;
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(ASK_EVENT, onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(ASK_EVENT, onAsk);
    };
  }, []);

  const other = mode === "pal" ? "runtime" : "pal";
  const q = query.trim();
  const thinking = plan?.state === "thinking";

  const nav: Array<[string, LucideIcon, string, string]> = [
    ["Today, your Brief", Sun, "/brief", "pal"],
    ["Holds, replies waiting on you", Inbox, "/personal/drafts", "pal"],
    ["Automations", Zap, "/automations", "pal"],
    ["Overview", Gauge, "/overview", "Runtime"],
    ["Agents", Bot, "/agents", "Runtime"],
    ["Runs", Play, "/runs", "Runtime"],
    ["Sandboxes", Server, "/runtime", "Runtime"],
    ["Connectors", Plug, "/connectors", "Runtime"],
    ["Settings", Settings, "/settings", ""],
  ];

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Ask PAL or search"
      loop
      overlayClassName="v3-overlay fixed inset-0 z-[100] bg-black/55"
      contentClassName="v3-pop fixed left-1/2 top-[12vh] z-[101] w-[calc(100%-2rem)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-[14px] border border-line bg-panel shadow-[var(--elev-4)] outline-none"
    >
      <Dialog.Title className="sr-only">Ask PAL or search</Dialog.Title>
      <Dialog.Description className="sr-only">Type to search pages, agents and runs, or ask PAL in plain words. Changes always ask first.</Dialog.Description>
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Sparkles className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <Command.Input
          value={query}
          onValueChange={(v) => { setQuery(v); if (plan) reset(); }}
          placeholder={mode === "pal" ? "Ask PAL or search, like “what needs me today?”" : "Ask PAL or search, like “why did my last run fail?”"}
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-fg !shadow-none !outline-none placeholder:text-fg-3"
        />
        <span className="hidden sm:inline-flex"><Kbd>Esc</Kbd></span>
      </div>

      {plan && (
        <div className="border-b border-line p-3">
          <PlanView plan={plan} setPlan={setPlan} onConfirmAgent={confirmAgent} onConfirmVms={confirmVms} onNavigate={close} />
        </div>
      )}

      <Command.List className="max-h-[min(52vh,420px)] overflow-y-auto overscroll-contain p-1.5">
        {/* With 2+ characters the Ask row is always there, so "no matches" never strands you. */}
        {q.length < 2 && (
          <Command.Empty className="px-4 py-10 text-center">
            <p className="text-sm text-fg-2">No matches</p>
            <p className="mt-1 text-[12px] text-fg-3">Describe what you want, like “create an agent that triages GitHub issues”.</p>
          </Command.Empty>
        )}

        {q.length >= 2 && (
          <Group heading="Ask PAL" forceMount>
            <Command.Item value={`__ask ${q}`} forceMount onSelect={() => void ask(q)} className={itemCls(true)}>
              <ItemIcon icon={thinking ? Loader2 : Sparkles} agentic spin={thinking} />
              <span className="min-w-0 flex-1 truncate">Ask PAL: “{q}”</span>
              <span className="hidden text-[12px] text-fg-3 sm:block">Enter to ask</span>
            </Command.Item>
          </Group>
        )}

        <Group heading="Go to">
          {nav.map(([label, icon, path, meta]) => (
            <Command.Item key={path} value={`${label} ${meta}`} onSelect={() => go(path)} className={itemCls()}>
              <ItemIcon icon={icon} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {meta && <span className="hidden text-[12px] text-fg-3 sm:block">{meta}</span>}
            </Command.Item>
          ))}
        </Group>

        <Group heading="Actions">
          <Command.Item value={`switch to ${MODE_LABEL[other]}`} onSelect={() => { switchTo(other); setOpen(false); }} className={itemCls()}>
            <ItemIcon icon={Repeat} /> <span className="flex-1">Switch to {MODE_LABEL[other]}</span>
          </Command.Item>
          <Command.Item value="create new agent" onSelect={() => go("/agents/create")} className={itemCls()}>
            <ItemIcon icon={Plus} /> <span className="flex-1">Create new agent</span>
          </Command.Item>
          <Command.Item value="refresh this page" onSelect={() => { router.refresh(); setOpen(false); }} className={itemCls()}>
            <ItemIcon icon={RefreshCw} /> <span className="flex-1">Refresh this page</span>
          </Command.Item>
        </Group>

        {/* Agents + runs only once you type, so the empty palette stays calm. */}
        {q.length > 0 && agentNames.length > 0 && (
          <Group heading="Agents">
            {agentNames.slice(0, 40).map((name) => (
              <Command.Item key={name} value={`agent ${name}`} onSelect={() => go(`/agents/${encodeURIComponent(name)}`)} className={itemCls()}>
                <ItemIcon icon={Bot} /> <span className="min-w-0 flex-1 truncate">{name}</span>
              </Command.Item>
            ))}
          </Group>
        )}

        {q.length > 0 && runs.length > 0 && (
          <Group heading="Runs">
            {runs.slice(0, 12).map((r) => (
              <Command.Item key={r.id} value={`run ${r.id} ${r.agentName} ${r.status}`} onSelect={() => go(`/runs/${encodeURIComponent(r.id)}`)} className={itemCls()}>
                <ItemIcon icon={Hash} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{r.id.slice(0, 8)}</span>
                <span className="hidden truncate text-[12px] text-fg-3 sm:block">{r.agentName}, {r.status}</span>
              </Command.Item>
            ))}
          </Group>
        )}
      </Command.List>

      <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[12px] text-fg-3">
        <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span className="flex items-center gap-1"><Kbd>↵</Kbd> select</span>
        <span className="ml-auto hidden items-center gap-1.5 text-accent sm:flex">
          <CircleDot className="h-2.5 w-2.5" aria-hidden /> Changes always ask first
        </span>
      </div>
    </Command.Dialog>
  );
}

function Group({ heading, children, forceMount }: { heading: string; children: React.ReactNode; forceMount?: boolean }) {
  return (
    <Command.Group
      heading={heading}
      forceMount={forceMount}
      className="mb-1 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3"
    >
      {children}
    </Command.Group>
  );
}

function itemCls(agentic = false) {
  return clsx(
    "flex h-10 cursor-default select-none items-center gap-3 rounded-lg px-2.5 text-[13.5px] text-fg-2 outline-none",
    agentic ? "data-[selected=true]:bg-accent-soft data-[selected=true]:text-fg" : "data-[selected=true]:bg-hover data-[selected=true]:text-fg",
  );
}

function ItemIcon({ icon: Icon, agentic, spin }: { icon: LucideIcon; agentic?: boolean; spin?: boolean }) {
  return (
    <span className={clsx("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", agentic ? "bg-accent-soft text-accent" : "text-fg-3")}>
      <Icon className={clsx("h-4 w-4", spin && "animate-spin")} aria-hidden />
    </span>
  );
}
