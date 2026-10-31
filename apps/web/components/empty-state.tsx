import { type LucideIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode } from "react";
import clsx from "clsx";

interface EmptyStateProps {
  icon?: LucideIcon;
  illustration?: ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  secondaryActionHref?: string;
  onSecondaryAction?: () => void;
  // Optional contextual suggestion chips — surfaced beneath the action
  // buttons to nudge the user toward the most useful next move.
  suggestions?: Array<{ label: string; onClick?: () => void; href?: string }>;
  // Compact mode (lower padding, smaller icon) for inline empties
  // inside cards. Default is hero-sized for whole-page empties.
  size?: "hero" | "compact";
}

export function EmptyState({
  icon: Icon,
  illustration,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  secondaryActionLabel,
  secondaryActionHref,
  onSecondaryAction,
  suggestions,
  size = "hero",
}: EmptyStateProps) {
  const isHero = size === "hero";
  return (
    <div
      className={clsx(
        "relative isolate flex flex-col items-center justify-center overflow-hidden text-center",
        "rounded-[12px] border border-dashed border-line-strong bg-panel",
        isHero ? "px-6 py-16" : "px-6 py-10"
      )}
    >
      {illustration ? (
        <div className="mb-6">{illustration}</div>
      ) : Icon ? (
        <div
          className={clsx(
            "mb-4 flex items-center justify-center rounded-[10px]",
            "bg-raised ring-1 ring-line",
            isHero ? "h-14 w-14" : "h-10 w-10"
          )}
        >
          <Icon className={clsx("text-fg-3", isHero ? "h-6 w-6" : "h-5 w-5")} />
        </div>
      ) : null}
      <h3 className="mb-1.5 text-[15px] font-semibold text-fg">{title}</h3>
      <p className={clsx(
        "max-w-md text-[13px] leading-relaxed text-fg-3",
        (actionLabel || secondaryActionLabel || suggestions) && "mb-6"
      )}>
        {description}
      </p>
      <div className="flex flex-col items-center gap-3">
        {(actionLabel || secondaryActionLabel) && (
          <div className="flex items-center gap-3">
            {actionLabel && actionHref && !onAction && (
              <Link
                href={actionHref}
                className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-[13px] font-medium text-on-accent transition-colors duration-150 hover:bg-accent-strong"
              >
                {actionLabel}
              </Link>
            )}
            {actionLabel && onAction && (
              <button
                onClick={onAction}
                className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-[13px] font-medium text-on-accent transition-colors duration-150 hover:bg-accent-strong"
              >
                {actionLabel}
              </button>
            )}
            {secondaryActionLabel && secondaryActionHref && !onSecondaryAction && (
              <Link
                href={secondaryActionHref}
                className="focus-ring inline-flex h-9 items-center gap-2 rounded-md border border-line-strong px-4 text-[13px] font-medium text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg"
              >
                {secondaryActionLabel}
              </Link>
            )}
            {secondaryActionLabel && onSecondaryAction && (
              <button
                onClick={onSecondaryAction}
                className="focus-ring inline-flex h-9 items-center gap-2 rounded-md border border-line-strong px-4 text-[13px] font-medium text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg"
              >
                {secondaryActionLabel}
              </button>
            )}
          </div>
        )}
        {suggestions && suggestions.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {suggestions.map((s, i) => {
              const cls =
                "focus-ring rounded-full border border-line px-3 py-1 text-[12px] text-fg-2 transition-colors duration-150 hover:border-accent/50 hover:text-fg";
              if (s.href) {
                return (
                  <Link key={i} href={s.href} className={cls}>
                    {s.label}
                  </Link>
                );
              }
              return (
                <button key={i} onClick={s.onClick} className={cls}>
                  {s.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
