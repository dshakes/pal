import { type ReactNode } from "react";
import clsx from "clsx";

interface PageHeaderProps {
  title: string;
  description?: string;
  badge?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  badge,
  action,
  secondaryAction,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={clsx(
        // Flat, borderless title block on the canvas; the topbar carries the breadcrumb.
        "relative isolate bg-canvas px-4 pb-1 pt-6 md:px-8",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em] text-fg">
              {title}
            </h1>
            {badge}
          </div>
          {description && (
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-fg-3">
              {description}
            </p>
          )}
        </div>
        {(action || secondaryAction) && (
          <div className="flex max-w-full flex-wrap items-center gap-2">
            {secondaryAction}
            {action}
          </div>
        )}
      </div>
    </div>
  );
}

export function CountBadge({ count }: { count: number }) {
  return (
    <span className="num inline-flex items-center justify-center rounded-md bg-raised px-2 py-0.5 text-[12px] font-medium text-fg-2">
      {count}
    </span>
  );
}

export function DemoBadge() {
  return (
    <span className="rounded-md bg-warn-soft px-2 py-0.5 text-[12px] font-medium text-warn">
      Demo data
    </span>
  );
}
