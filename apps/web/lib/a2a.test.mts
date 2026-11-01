import test from "node:test";
import assert from "node:assert/strict";
import { a2aCardPath, classifyCardFailure, parseA2aCard, parseIdentityCard } from "./a2a.ts";

const good = {
  protocolVersion: "0.3.0", name: "support", description: "d", url: "http://x/v1/agents/support/a2a",
  preferredTransport: "JSONRPC", version: "v3", capabilities: { streaming: true },
  securitySchemes: { palBearer: { type: "http", description: "token" }, bad: 5 },
  defaultInputModes: ["text/plain", 7], defaultOutputModes: ["application/json"],
  skills: [{ id: "triage", name: "Triage", tags: ["a", 1] }, { name: "no id" }, "junk"],
  supportsAuthenticatedExtendedCard: false,
};

test("parseA2aCard keeps well-formed fields and drops malformed entries", () => {
  const c = parseA2aCard(good)!;
  assert.equal(c.name, "support");
  assert.equal(c.capabilities.streaming, true);
  assert.equal(c.capabilities.pushNotifications, false);
  assert.deepEqual(c.securitySchemes, [{ name: "palBearer", type: "http", description: "token" }]);
  assert.deepEqual(c.defaultInputModes, ["text/plain"]);
  assert.deepEqual(c.skills, [{ id: "triage", name: "Triage", description: "", tags: ["a"] }]);
});

test("parseA2aCard rejects payloads missing name/url/protocolVersion or non-objects", () => {
  for (const bad of [null, undefined, "x", [], {}, { ...good, url: undefined }, { ...good, name: 3 }, { ...good, protocolVersion: undefined }]) {
    assert.equal(parseA2aCard(bad), null);
  }
});

test("parseIdentityCard only surfaces string ids", () => {
  assert.deepEqual(parseIdentityCard({ spiffeId: "spiffe://x", jwksUri: 5 }), { spiffeId: "spiffe://x", jwksUri: undefined });
  assert.deepEqual(parseIdentityCard(null), {});
});

test("classifyCardFailure: 404 is one opaque case; 503 needs the base-url code", () => {
  assert.deepEqual(classifyCardFailure(404), { kind: "not_visible" });
  assert.deepEqual(classifyCardFailure(404, "whatever", "private"), { kind: "not_visible" });
  assert.deepEqual(classifyCardFailure(503, "public_base_url_required"), { kind: "needs_base_url" });
  assert.equal(classifyCardFailure(503, "other", "m").kind, "error");
  assert.equal(classifyCardFailure(500, undefined, "boom").kind, "error");
});

test("a2aCardPath encodes the agent name", () => {
  assert.equal(a2aCardPath("a b/c"), "/v1/agents/a%20b%2Fc/a2a/.well-known/agent-card.json");
});
