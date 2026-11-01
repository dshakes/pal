"use client";

// TimeSeries — the one uPlot wrapper (canvas, ~22 kB gz, loaded only when a chart
// mounts). Colours are theme tokens resolved at draw time, never literals, and
// the chart redraws when `data-theme` / `data-contrast` flips. Width follows
// the container (ResizeObserver) so it is right at any viewport.

import { useEffect, useRef } from "react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export type SeriesToken = "ok" | "bad" | "warn" | "accent";
export interface ChartSeries {
  label: string;
  values: number[];
  token: SeriesToken;
  /** Draw as columns (counts) instead of a line. */
  bars?: boolean;
}

const SWATCH: Record<SeriesToken, string> = { ok: "bg-ok", bad: "bg-bad", warn: "bg-warn", accent: "bg-accent" };
const plain = (v: number) => String(v);

const VAR: Record<SeriesToken | "fg" | "line", string> = {
  ok: "--color-ok",
  bad: "--color-bad",
  warn: "--color-warn",
  accent: "--color-accent",
  fg: "--color-fg-3",
  line: "--color-line",
};

/** Resolve a token to a concrete colour the canvas can use (handles color-mix/var chains). */
function resolve(token: keyof typeof VAR): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${VAR[token]})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

export function TimeSeries({
  x,
  series,
  height = 168,
  ariaLabel,
  fmt = plain,
  minTop = 1,
}: {
  /** Epoch seconds, ascending. Callers memoize x/series/fmt: a new identity rebuilds the chart. */
  x: number[];
  series: ChartSeries[];
  height?: number;
  ariaLabel: string;
  fmt?: (v: number) => string;
  /** The y axis always reaches at least this, so an all-zero series isn't auto-scaled to 0..100. */
  minTop?: number;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || x.length === 0) return;
    let plot: uPlot | null = null;
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    let dead = false;

    void import("uplot").then(({ default: U }) => {
      if (dead) return;
      const build = () => {
        plot?.destroy();
        const axis = { stroke: resolve("fg"), grid: { stroke: resolve("line"), width: 1 }, ticks: { stroke: resolve("line"), width: 1 } };
        plot = new U(
          {
            width: Math.max(el.clientWidth, 240),
            height,
            legend: { show: false },
            cursor: { drag: { x: false, y: false } },
            scales: {
              x: { time: true },
              y: { range: (_u, _min, max) => [0, Math.max(max * 1.1, minTop)] },
            },
            axes: [
              { ...axis, font: "11px system-ui" },
              { ...axis, font: "11px system-ui", size: 76, values: (_u, vals) => vals.map((v) => fmt(v)) },
            ],
            series: [
              {},
              ...series.map((s) => {
                const c = resolve(s.token);
                return s.bars
                  ? { label: s.label, stroke: c, fill: c, width: 0, paths: U.paths.bars!({ size: [0.7, 48] }), points: { show: false } }
                  : { label: s.label, stroke: c, width: 2, points: { show: false }, value: (_u: uPlot, v: number | null) => (v == null ? "" : fmt(v)) };
              }),
            ],
          },
          [x, ...series.map((s) => s.values)],
          el,
        );
      };
      build();
      ro = new ResizeObserver(() => plot?.setSize({ width: Math.max(el.clientWidth, 240), height }));
      ro.observe(el);
      mo = new MutationObserver(build);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-contrast"] });
    });

    return () => {
      dead = true;
      ro?.disconnect();
      mo?.disconnect();
      plot?.destroy();
    };
  }, [x, series, height, fmt, minTop]);

  return (
    <div>
      <div ref={host} role="img" aria-label={ariaLabel} data-testid="time-series" className="w-full min-w-0 overflow-hidden" style={{ minHeight: height }} />
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-fg-3" aria-hidden>
        {series.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-sm ${SWATCH[s.token]}`} />
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
