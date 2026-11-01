import clsx from "clsx";
import type { RunStatus } from "@/lib/types";

// Run status as a small pill (v3 tokens). Any status the dashboard doesn't
// know — the API currently reports a run waiting on approval as
// "unspecified" — renders as a neutral "Unknown" instead of crashing.

type Tone = "neutral" | "live" | "hold" | "ok" | "bad";

const STATUS: Record<RunStatus | "waiting", { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "live" },
  paused: { label: "Paused", tone: "hold" },
  waiting: { label: "Waiting", tone: "hold" },
  succeeded: { label: "Succeeded", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const TONE: Record<Tone, { pill: string; dot: string }> = {
  neutral: { pill: "bg-raised text-fg-2", dot: "bg-fg-3" },
  live: { pill: "bg-accent-soft text-accent", dot: "bg-accent status-running" },
  hold: { pill: "bg-warn-soft text-warn", dot: "bg-warn" },
  ok: { pill: "bg-ok-soft text-ok", dot: "bg-ok" },
  bad: { pill: "bg-bad-soft text-bad", dot: "bg-bad" },
};

export function statusLabel(status: string): string {
  return STATUS[status as keyof typeof STATUS]?.label ?? "Unknown";
}

export function StatusBadge({ status }: { status: RunStatus | string }) {
  const s = STATUS[status as keyof typeof STATUS] ?? { label: "Unknown", tone: "neutral" as Tone };
  const t = TONE[s.tone];
  return (
    <span
      className={clsx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium", t.pill)}
      title={s.label === "Unknown" ? `API status: ${status}` : undefined}
    >
      <span aria-hidden className={clsx("h-1.5 w-1.5 rounded-full", t.dot)} />
      {s.label}
    </span>
  );
}
