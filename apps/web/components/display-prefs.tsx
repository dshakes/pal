"use client";
// Display controls: theme, contrast, density — one popover. Each choice is a
// native radio group (keyboard + screen-reader correct for free) and applies
// instantly via lib/display-prefs (data-* attribute on <html> + localStorage).

import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import clsx from "clsx";
import { applyPrefs, readPrefs, type DisplayPrefs } from "@/lib/display-prefs";
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui";

const GROUPS: Array<{ key: keyof DisplayPrefs; label: string; options: Array<[string, string]> }> = [
  { key: "theme", label: "Theme", options: [["dark", "Dark"], ["light", "Light"]] },
  { key: "contrast", label: "Contrast", options: [["system", "System"], ["normal", "Standard"], ["more", "More"]] },
  { key: "density", label: "Density", options: [["comfortable", "Comfortable"], ["compact", "Compact"]] },
];

export function DisplayPrefsControl() {
  const [prefs, setPrefs] = useState<DisplayPrefs>({ theme: "dark", contrast: "system", density: "comfortable" });
  useEffect(() => {
    try { setPrefs(readPrefs((k) => localStorage.getItem(k))); } catch { /* defaults */ }
  }, []);

  const set = <K extends keyof DisplayPrefs>(k: K, v: DisplayPrefs[K]) => {
    const next = { ...prefs, [k]: v };
    setPrefs(next);
    applyPrefs(next);
  };

  return (
    <Popover>
      <Tooltip label="Display">
        <PopoverTrigger
          aria-label="Display settings"
          className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[280px] space-y-3.5">
        {GROUPS.map((g) => (
          <fieldset key={g.key}>
            <legend className="mb-1.5 text-[12px] text-fg-3">{g.label}</legend>
            <div className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-line bg-canvas p-0.5">
              {g.options.map(([value, text]) => {
                const checked = prefs[g.key] === value;
                return (
                  <label
                    key={value}
                    className={clsx(
                      "relative flex h-7 cursor-pointer items-center justify-center rounded-md text-[12.5px] transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus-ring)]",
                      checked ? "bg-hover font-medium text-fg" : "text-fg-3 hover:text-fg",
                    )}
                  >
                    <input
                      type="radio"
                      name={`pref-${g.key}`}
                      value={value}
                      checked={checked}
                      onChange={() => set(g.key, value as never)}
                      className="sr-only"
                    />
                    {text}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </PopoverContent>
    </Popover>
  );
}
