import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBridgeWsUrl } from "./bridge-client.ts";

test("buildBridgeWsUrl: ws scheme, tenant and ticket in the query, no bridge token", () => {
  const u = new URL(buildBridgeWsUrl("http://localhost:3100/", "t 1", "abc123"));
  assert.equal(u.protocol, "ws:");
  assert.equal(u.pathname, "/ws");
  assert.equal(u.searchParams.get("tenantId"), "t 1");
  assert.equal(u.searchParams.get("ticket"), "abc123");
  assert.equal(u.searchParams.has("token"), false);
});

test("buildBridgeWsUrl: https bridge -> wss", () => {
  assert.equal(new URL(buildBridgeWsUrl("https://b.example", "t", "x")).protocol, "wss:");
});
