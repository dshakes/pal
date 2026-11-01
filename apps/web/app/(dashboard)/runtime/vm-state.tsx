import clsx from "clsx";
import { vmTone, type VmTone } from "@/lib/sandbox";

const TONE: Record<VmTone, { pill: string; dot: string }> = {
  neutral: { pill: "bg-raised text-fg-2", dot: "bg-fg-3" },
  live: { pill: "bg-accent-soft text-accent", dot: "bg-accent status-running" },
  hold: { pill: "bg-warn-soft text-warn", dot: "bg-warn" },
  ok: { pill: "bg-ok-soft text-ok", dot: "bg-ok" },
  bad: { pill: "bg-bad-soft text-bad", dot: "bg-bad" },
};

/** Sandbox (microVM) state as a pill. Unknown states render as-is, neutral. */
export function VmState({ state }: { state: string }) {
  const t = TONE[vmTone(state)];
  return (
    <span className={clsx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium capitalize", t.pill)}>
      <span aria-hidden className={clsx("h-1.5 w-1.5 rounded-full", t.dot)} />
      {state}
    </span>
  );
}
