import test from "node:test";
import assert from "node:assert/strict";
import { highlightJson } from "./json-highlight.ts";

test("json highlight: one pass, numbers never touch the markup we add", () => {
  const out = highlightJson(JSON.stringify({ version: "2.4.0", n: 400, ok: true, x: null }));
  assert.equal(
    out,
    '{<span class="text-fg-2">"version"</span>:<span class="text-ok">"2.4.0"</span>,<span class="text-fg-2">"n"</span>:<span class="text-accent">400</span>,<span class="text-fg-2">"ok"</span>:<span class="text-warn">true</span>,<span class="text-fg-2">"x"</span>:<span class="text-fg-3">null</span>}',
  );
});

test("json highlight: data cannot inject markup", () => {
  const out = highlightJson(JSON.stringify({ msg: "<img src=x onerror=alert(1)>" }));
  assert.ok(!out.includes("<img"));
  assert.ok(out.includes("&lt;img"));
});
