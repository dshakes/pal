// Pure bucketing for the observe charts. No verdicts here: these are counts and
// sums of what the runs list returned, laid out on a time axis. Pass/fail
// judgements (SLO burn, anomalies) always come from the server.

export interface RunPoint {
  at: number; // epoch ms
  failed: boolean;
  costUsd: number;
}

export interface Series {
  /** Bucket start, epoch SECONDS (uPlot's native time unit). */
  x: number[];
  runs: number[];
  failed: number[];
  costUsd: number[];
  bucketMs: number;
}

const STEPS = [60_000, 5 * 60_000, 15 * 60_000, 3_600_000, 6 * 3_600_000, 86_400_000];

/** Smallest round bucket that keeps the chart at or under `maxBuckets` columns. */
export function pickBucketMs(spanMs: number, maxBuckets = 48): number {
  return STEPS.find((s) => spanMs / s <= maxBuckets) ?? STEPS[STEPS.length - 1];
}

/**
 * Zero-filled buckets from the first to the last point so gaps read as gaps, with
 * one empty bucket either side so a lone column keeps a sane axis (a time axis
 * over a single instant is auto-scaled across years) and the edge bars don't clip.
 */
export function bucketRuns(points: RunPoint[], maxBuckets = 48): Series | null {
  const pts = points.filter((p) => Number.isFinite(p.at));
  if (pts.length === 0) return null;
  const min = Math.min(...pts.map((p) => p.at));
  const max = Math.max(...pts.map((p) => p.at));
  const bucketMs = pickBucketMs(max - min, maxBuckets);
  const start = Math.floor(min / bucketMs) * bucketMs - bucketMs;
  const n = Math.floor((max - start) / bucketMs) + 2;
  const s: Series = {
    x: Array.from({ length: n }, (_, i) => (start + i * bucketMs) / 1000),
    runs: new Array<number>(n).fill(0),
    failed: new Array<number>(n).fill(0),
    costUsd: new Array<number>(n).fill(0),
    bucketMs,
  };
  for (const p of pts) {
    const i = Math.floor((p.at - start) / bucketMs);
    s.runs[i] += 1;
    if (p.failed) s.failed[i] += 1;
    s.costUsd[i] += p.costUsd;
  }
  return s;
}
