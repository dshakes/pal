import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compare, scan, scanTree } from "./check-literal-colors.mjs";

test("literal colors: flags white literals and hex, not tokens", () => {
  const rules = (s: string) => scan(s).map((v: { rule: string }) => v.rule);
  assert.deepEqual(rules(`<p className="text-white">`), ["text-white"]);
  assert.deepEqual(rules(`<div className="bg-white/[0.04] border-white/[0.1]">`), ["bg-white/[…]", "border-white/[…]"]);
  assert.deepEqual(rules(`style={{ color: "#ff8a6b" }}`), ["hex"]);
  assert.deepEqual(rules(`fill="#fff" stroke='#0B0C0F80'`), ["hex", "hex"]);
  assert.deepEqual(rules(`<p className="text-fg bg-panel border-line text-zinc-50">`), []);
  assert.deepEqual(rules(`text-white/70`), []); // opacity variant of white on a colored fill is not the foreground literal rule
  assert.deepEqual(rules(`"Fixes issue #123"`), []);
  assert.deepEqual(rules(`href="#main" &#123;`), []);
});

test("literal colors: ratchet — new file or more literals fail, improvement demands a lower baseline", () => {
  const v = (n: number) => Array.from({ length: n }, (_, i) => ({ line: i + 1, rule: "hex", text: "#fff" }));
  assert.equal(compare({}, {}).length, 0);
  assert.equal(compare({ "components/new.tsx": v(1) }, {}).length, 1);
  assert.equal(compare({ "a.tsx": v(3) }, { "a.tsx": 2 }).length, 1);
  assert.equal(compare({ "a.tsx": v(2) }, { "a.tsx": 2 }).length, 0);
  assert.match(compare({ "a.tsx": v(1) }, { "a.tsx": 2 })[0], /Lower the baseline/);
});

test("literal colors: the dashboard tree passes against its baseline", () => {
  const baseline = JSON.parse(readFileSync(new URL("./literal-colors-baseline.json", import.meta.url), "utf8"));
  assert.deepEqual(compare(scanTree(), baseline), []);
});
