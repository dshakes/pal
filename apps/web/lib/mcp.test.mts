import test from "node:test";
import assert from "node:assert/strict";
import { parseApiError, isAuthRequired, policyEntry, needsVmId, SLUG_RE, mcpEndpoint } from "./mcp.ts";

test("parseApiError reads status and JSON code", () => {
  const e = parseApiError(new Error('API 409: {"code":"authorization_required","error":"connect first"}'));
  assert.equal(e.status, 409);
  assert.equal(e.message, "connect first");
  assert.ok(isAuthRequired(e));
});

test("parseApiError tolerates plain bodies and non-API errors", () => {
  assert.deepEqual(parseApiError(new Error("API 400: bad url")), { status: 400, message: "bad url" });
  assert.equal(parseApiError(new Error("boom")).status, null);
  assert.ok(!isAuthRequired(parseApiError(new Error('API 502: {"code":"mcp_error"}'))));
});

test("policy entry, stdio, slug, endpoint", () => {
  assert.equal(policyEntry("gh"), "gh");
  assert.equal(policyEntry("gh", "list_issues"), "gh.list_issues");
  assert.ok(needsVmId("stdio") && !needsVmId("streamable-http"));
  assert.ok(SLUG_RE.test("my-server") && !SLUG_RE.test("My_Server") && !SLUG_RE.test("-x"));
  assert.equal(mcpEndpoint("http://localhost:8080/"), "http://localhost:8080/mcp");
});
