"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import clsx from "clsx";
import { highlightJson } from "@/lib/json-highlight";

interface JsonViewerProps {
  data: unknown;
  label: string;
  defaultOpen?: boolean;
}

export function JsonViewer({ data, label, defaultOpen = false }: JsonViewerProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (data === undefined || data === null) return null;

  const formatted = JSON.stringify(data, null, 2);
  const highlighted = highlightJson(formatted);

  return (
    <div className="rounded-lg border border-zinc-800 bg-surface-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        {label}
      </button>
      {open && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <pre
            className={clsx(
              "max-h-64 overflow-auto font-mono text-xs leading-relaxed text-zinc-300"
            )}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </div>
      )}
    </div>
  );
}
