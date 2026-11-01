"use client";

// Inline "Explain this" — one click asks the control-plane (POST
// /v1/assist/explain) for a grounded, plain-language read of a run or a
// failing eval case. Server-side grounding: for runs the server loads the
// run + journal itself; the browser only sends the id.

import { useState } from "react";
import Link from "next/link";
import { Loader2, Sparkles, X } from "lucide-react";
import clsx from "clsx";
import { api, AssistError, type ExplainRequest } from "@/lib/api";
import { useCan } from "@/components/role-gate";

export function ExplainInline({
  request, label = "Explain", className, size = "sm",
}: {
  request: ExplainRequest;
  label?: string;
  className?: string;
  size?: "sm" | "xs";
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [text, setText] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  // Explaining calls the model (spends money), so read-only roles don't get it.
  const canRun = useCan("runs:execute");

  const run = async () => {
    setState("loading");
    setNeedsKey(false);
    try {
      setText(await api.assistExplain(request));
      setState("done");
    } catch (err) {
      setNeedsKey(err instanceof AssistError && err.code === "no_provider");
      setText(err instanceof Error ? err.message : "Couldn't get an explanation.");
      setState("error");
    }
  };

  if (!canRun) return null;

  if (state === "idle" || state === "loading") {
    return (
      <button
        type="button"
        onClick={run}
        disabled={state === "loading"}
        className={clsx(
          "focus-ring inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent-soft font-medium text-accent transition-colors hover:border-accent/60 disabled:opacity-60",
          size === "xs" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-[12px]",
          className,
        )}
      >
        {state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
        {state === "loading" ? "Explaining…" : label}
      </button>
    );
  }

  return (
    <div
      role="status"
      className={clsx(
        "relative rounded-lg border px-3 py-2.5 pr-8 text-xs leading-relaxed",
        state === "done" ? "border-accent/30 bg-accent-soft text-fg" : "border-warn/40 bg-warn-soft text-warn",
        className,
      )}
    >
      {state === "done" && (
        <span className="mb-1 flex items-center gap-1 text-[12px] font-medium text-accent">
          <Sparkles className="h-3 w-3" /> PAL explains
        </span>
      )}
      <p>{text}</p>
      {needsKey && (
        <Link href="/settings?tab=providers" className="mt-1 inline-block font-medium underline underline-offset-2">
          Add a model key
        </Link>
      )}
      <button
        type="button"
        aria-label="Dismiss explanation"
        onClick={() => setState("idle")}
        className="focus-ring absolute right-2 top-2 rounded p-0.5 text-fg-3 hover:text-fg"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
