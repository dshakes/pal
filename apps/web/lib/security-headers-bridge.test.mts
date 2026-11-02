import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeWsOrigins, buildCsp } from "./security-headers.ts";

test("CSP allows exactly the bridge ws origins, no wildcard in prod", () => {
  const o = bridgeWsOrigins({});
  assert.deepEqual(o.sort(), ["ws://127.0.0.1:3100", "ws://127.0.0.1:3200", "ws://localhost:3100", "ws://localhost:3200"]);
  const csp = buildCsp("n", false);
  assert.match(csp, /connect-src 'self' [^;]*ws:\/\/localhost:3100/);
  assert.doesNotMatch(csp.split("; ").find((d) => d.startsWith("connect-src"))!, /\*| ws: | wss: /);
});
test("configured https bridge becomes wss", () => {
  assert.ok(bridgeWsOrigins({ NEXT_PUBLIC_PAL_BRIDGE_URL: "https://b.example:3100" }).includes("wss://b.example:3100"));
});
