import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketRuns, pickBucketMs } from "./timeseries.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

test("bucket size grows with the span and never exceeds the column cap", () => {
  assert.equal(pickBucketMs(30 * MIN), MIN);
  assert.equal(pickBucketMs(10 * 60 * MIN), 15 * MIN); // 10h -> 40 columns of 15m
  assert.equal(pickBucketMs(1000 * 86_400_000), 86_400_000); // huge spans fall back to days
  for (const span of [MIN, 59 * MIN, 5 * 3_600_000, 3 * 86_400_000, 40 * 86_400_000]) {
    const b = pickBucketMs(span);
    assert.ok(span / b <= 48 || b === 86_400_000, `span ${span} bucket ${b}`);
  }
});

test("counts, failures and cost are bucketed; gaps are zero-filled", () => {
  const s = bucketRuns([
    { at: T0, failed: false, costUsd: 0.01 },
    { at: T0 + 10_000, failed: true, costUsd: 0.02 },
    { at: T0 + 5 * MIN, failed: false, costUsd: 0.5 },
  ])!;
  assert.equal(s.bucketMs, MIN);
  // one empty bucket either side of the data
  assert.deepEqual(s.runs, [0, 2, 0, 0, 0, 0, 1, 0]);
  assert.deepEqual(s.failed, [0, 1, 0, 0, 0, 0, 0, 0]);
  assert.equal(s.costUsd[1].toFixed(2), "0.03");
  assert.equal(s.x[1], T0 / 1000); // uPlot wants seconds
  assert.equal(s.x[1] - s.x[0], 60);
  // Every run lands in exactly one bucket.
  assert.equal(s.runs.reduce((a, b) => a + b, 0), 3);
});

test("no runs, or only garbage timestamps, is no chart", () => {
  assert.equal(bucketRuns([]), null);
  assert.equal(bucketRuns([{ at: NaN, failed: false, costUsd: 0 }]), null);
});

test("a single run is one column with an empty bucket either side (never a one-point axis)", () => {
  const s = bucketRuns([{ at: T0 + 1234, failed: true, costUsd: 1 }])!;
  assert.deepEqual(s.runs, [0, 1, 0]);
  assert.deepEqual(s.failed, [0, 1, 0]);
});
