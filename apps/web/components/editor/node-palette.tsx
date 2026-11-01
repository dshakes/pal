"use client";

import { type DragEvent } from "react";
import {
  Zap,
  Brain,
  Wrench,
  GitBranch,
  Repeat,
  ShieldCheck,
  Plug,
  Bot,
  CircleStop,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { NODE_TYPE_CONFIGS, type NodeType } from "@/lib/workflow-types";

// ---- Icon lookup -----------------------------------------------------------

const iconComponents: Record<string, LucideIcon> = {
  Zap,
  Brain,
  Wrench,
  GitBranch,
  Repeat,
  ShieldCheck,
  Plug,
  Bot,
  CircleStop,
};

// ---- Color map for palette items -------------------------------------------

const paletteColors: Record<string, { bg: string; text: string; border: string }> = {
  emerald: {
    bg: "bg-ok-soft",
    text: "text-ok",
    border: "border-ok",
  },
  indigo: {
    bg: "bg-accent-soft",
    text: "text-accent",
    border: "border-accent",
  },
  blue: {
    bg: "bg-accent-soft",
    text: "text-accent",
    border: "border-accent",
  },
  yellow: {
    bg: "bg-yellow-500/10",
    text: "text-yellow-400",
    border: "border-yellow-500/20",
  },
  purple: {
    bg: "bg-accent-soft",
    text: "text-accent",
    border: "border-accent",
  },
  red: {
    bg: "bg-bad-soft",
    text: "text-bad",
    border: "border-bad",
  },
  teal: {
    bg: "bg-teal-500/10",
    text: "text-teal-400",
    border: "border-teal-500/20",
  },
  orange: {
    bg: "bg-orange-500/10",
    text: "text-orange-400",
    border: "border-orange-500/20",
  },
  gray: {
    bg: "bg-raised",
    text: "text-fg-2",
    border: "border-zinc-500/20",
  },
};

// ---- Group configs by category ---------------------------------------------

const categories = ["Triggers", "AI", "Tools", "Logic", "Integration"] as const;

function groupByCategory() {
  const grouped: Record<string, typeof NODE_TYPE_CONFIGS> = {};
  for (const cat of categories) {
    grouped[cat] = NODE_TYPE_CONFIGS.filter((c) => c.category === cat);
  }
  return grouped;
}

// ---- Component -------------------------------------------------------------

export function NodePalette() {
  const groups = groupByCategory();

  function onDragStart(event: DragEvent, nodeType: NodeType) {
    event.dataTransfer.setData("application/reactflow-type", nodeType);
    event.dataTransfer.effectAllowed = "move";
  }

  return (
    <aside className="flex w-56 flex-col border-r border-line bg-panel">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-3">
          Nodes
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {categories.map((cat) => (
          <div key={cat} className="mb-4">
            <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wider text-fg-3">
              {cat}
            </h3>
            <div className="space-y-1.5">
              {groups[cat].map((config) => {
                const Icon = iconComponents[config.icon];
                const colors = paletteColors[config.color] ?? paletteColors.gray;

                return (
                  <div
                    key={config.type}
                    draggable
                    onDragStart={(e) => onDragStart(e, config.type)}
                    className={clsx(
                      "flex cursor-grab items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors active:cursor-grabbing",
                      "border-line bg-raised hover:border-line-strong hover:bg-hover"
                    )}
                  >
                    <div
                      className={clsx(
                        "flex h-6 w-6 items-center justify-center rounded-md",
                        colors.bg,
                        colors.text
                      )}
                    >
                      {Icon && <Icon className="h-3.5 w-3.5" />}
                    </div>
                    <span className="text-xs font-medium text-fg-2">
                      {config.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
