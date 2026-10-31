"use client";

import clsx from "clsx";
import { MODE_LABEL, type WorkspaceMode } from "@/lib/workspace-nav";
import { useWorkspaceMode } from "@/lib/use-workspace-mode";

/**
 * pal ⇄ Runtime switch. Two clear home spaces: the personal layer and the
 * builder runtime. Each half carries its brand accent (coral→magenta for pal,
 * indigo→cyan for Runtime) as a small dot — solid UI, gradient only as a mark.
 */
export function ModeSwitch({ compact = false }: { compact?: boolean }) {
  const { mode, switchTo } = useWorkspaceMode();
  return (
    <div
      role="group"
      aria-label="Space"
      className="grid grid-cols-2 gap-0.5 rounded-lg border border-line bg-canvas p-0.5"
    >
      {(["pal", "runtime"] as WorkspaceMode[]).map((m) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={active}
            onClick={() => !active && switchTo(m)}
            className={clsx(
              "focus-ring flex h-7 items-center justify-center gap-1.5 rounded-md px-2 font-medium transition-colors duration-150",
              compact ? "text-xs" : "text-[12.5px]",
              active ? "bg-hover text-fg shadow-[var(--elev-1)]" : "text-fg-3 hover:text-fg",
            )}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ backgroundImage: m === "pal" ? "var(--pal-grad)" : "var(--rt-grad)" }}
            />
            {MODE_LABEL[m]}
          </button>
        );
      })}
    </div>
  );
}
