import test from "node:test";
import assert from "node:assert/strict";
import { createApiKey, keyErrorMessage } from "./api-key-create.ts";

const input = { name: "ci", scopes: ["runs:read"] };

test("created: shows the server's rawKey and echoes the stored key's fields", async () => {
  const out = await createApiKey(async () => ({ key: { id: "k1", name: "ci", prefix: "pal_ab12", scopes: ["runs:read"], createdAt: "t" }, rawKey: "pal_ab12SERVERSECRET" }), input);
  assert.deepEqual(out, { kind: "created", rawKey: "pal_ab12SERVERSECRET", name: "ci", scopes: ["runs:read"], id: "k1", prefix: "pal_ab12", createdAt: "t" });
});

test("failure never fabricates a key and carries the server's reason", async () => {
  const out = await createApiKey(async () => { throw new Error('API 403: {"error":"cannot grant scope admin"}'); }, input);
  assert.equal(out.kind, "failed");
  assert.equal(out.kind === "failed" && out.message, "Not allowed: cannot grant scope admin");
  assert.equal(JSON.stringify(out).includes("ltn_"), false);
});

test("a 200 without a key is a failure, not an empty success", async () => {
  const out = await createApiKey(async () => ({ key: { id: "k", name: "n", prefix: "p", scopes: [], createdAt: "t" }, rawKey: "" }), input);
  assert.equal(out.kind, "failed");
});

test("keyErrorMessage: 400 shows the body, network errors pass through", () => {
  assert.equal(keyErrorMessage(new Error('API 400: {"error":"name required"}')), "name required");
  assert.equal(keyErrorMessage(new Error("Failed to fetch")), "Failed to fetch");
});
