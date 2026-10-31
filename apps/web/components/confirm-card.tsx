"use client";
// ConfirmCard — the mutation gate. Every agent "Act" and every destructive
// action ends here: it states exactly what will happen, and nothing runs until
// the person presses the confirm button. Used inline (⌘K, agent surface).
import type { ReactNode } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import clsx from "clsx";

export function ConfirmCard({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  tone = "default",
  working = false,
  disabled = false,
  secondary,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  tone?: "default" | "danger";
  working?: boolean;
  disabled?: boolean;
  secondary?: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={title}
      className={clsx(
        "rounded-[10px] border p-3.5",
        tone === "danger" ? "border-bad/40 bg-bad-soft" : "border-line-strong bg-raised",
      )}
    >
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
        <ShieldCheck className={clsx("h-3.5 w-3.5", tone === "danger" ? "text-bad" : "text-accent")} aria-hidden />
        {title}
      </p>
      {children && <div className="mt-2 text-[13px] text-fg">{children}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={working || disabled}
          className={clsx(
            "focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium disabled:opacity-50",
            tone === "danger" ? "bg-bad text-canvas hover:opacity-90" : "bg-accent-strong text-on-accent hover:bg-accent",
          )}
        >
          {working && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {confirmLabel}
        </button>
        {secondary}
        <button type="button" onClick={onCancel} className="focus-ring inline-flex h-8 items-center rounded-md px-3 text-[13px] text-fg-3 hover:text-fg">
          Cancel
        </button>
      </div>
    </div>
  );
}
