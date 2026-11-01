import clsx from "clsx";
import type { Tone } from "@/lib/observability";

const TONE: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok ring-ok/25",
  bad: "bg-bad-soft text-bad ring-bad/25",
  warn: "bg-warn-soft text-warn ring-warn/25",
  muted: "bg-raised text-fg-3 ring-line",
};

/** Small status pill; colour comes from the semantic tone, never the text alone. */
export function TonePill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", TONE[tone])}>
      {children}
    </span>
  );
}
