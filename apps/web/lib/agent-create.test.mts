import test from "node:test";
import assert from "node:assert/strict";
import { createAgentPath } from "./agent-create.ts";
import { parseApiError, suggestFix } from "../app/onboarding/onboarding-logic.ts";

test("createAgentPath: default keeps upsert semantics, createOnly opts in", () => {
  assert.equal(createAgentPath(), "/v1/agents");
  assert.equal(createAgentPath({ createOnly: false }), "/v1/agents");
  assert.equal(createAgentPath({ createOnly: true }), "/v1/agents?createOnly=1");
});

test("a createOnly 409 agent_exists surfaces as a rename prompt, not a generic failure", () => {
  const f = parseApiError(new Error('API 409: {"code":"agent_exists","error":"an agent named \\"x\\" already exists"}'));
  assert.equal(f.status, 409);
  assert.equal(f.code, "agent_exists");
  const fix = suggestFix(f, "create");
  assert.equal(fix.fix.action, "rename_agent");
  assert.match(fix.summary, /already exists/);
});
