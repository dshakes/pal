"use client";

// Inline "Ask PAL" bar for the home pages. Hands the query to the one ⌘K
// engine (openAsk) so every command bar shares validation + confirm steps.

import { useState, type FormEvent } from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import { openAsk } from "@/lib/ask-events";

export function AskBar({ placeholder, examples }: { placeholder: string; examples: string[] }) {
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    openAsk({ query: q.trim(), submit: true });
    setQ("");
  };
  return (
    <div>
      <form onSubmit={submit} className="flex items-center gap-2 rounded-[10px] border border-line bg-panel px-3 py-1.5 transition-colors focus-within:border-accent">
        <Sparkles className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label="Ask PAL"
          className="min-w-0 flex-1 bg-transparent py-1 text-[14px] text-fg !shadow-none !outline-none placeholder:text-fg-3"
        />
        <button
          type="submit"
          aria-label="Send to PAL"
          disabled={q.trim().length < 2}
          className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-action text-on-action transition-opacity disabled:opacity-30"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => openAsk({ query: ex, submit: true })}
            className="focus-ring rounded-full border border-line px-2.5 py-1 text-[12px] text-fg-2 transition-colors hover:border-accent/50 hover:text-fg"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
