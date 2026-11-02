import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { isAllowedHost, hostnameOf, parseAllowedHosts, tokenPolicy } from "./bridge-http-guard.ts";

describe("Host allowlist (DNS-rebinding defence)", () => {
  test("loopback hosts with any port pass", () => {
    for (const h of ["localhost", "localhost:3100", "127.0.0.1:3200", "127.0.0.1", "[::1]:3100", "[::1]", "LOCALHOST:1"]) assert.equal(isAllowedHost(h), true, h);
  });
  test("rebinding / foreign / missing hosts are rejected", () => {
    for (const h of ["evil.example.com", "evil.example.com:3100", "127.0.0.1.evil.com", "localhost.evil.com:80", "192.168.1.5:3100", "", undefined, "[::2]:1"]) assert.equal(isAllowedHost(h), false, String(h));
  });
  test("explicit PAL_BRIDGE_ALLOWED_HOSTS extends it", () => {
    const extra = parseAllowedHosts("bridge.internal, mac.local:3100");
    assert.deepEqual(extra, ["bridge.internal", "mac.local"]);
    assert.equal(isAllowedHost("bridge.internal:3100", extra), true);
    assert.equal(isAllowedHost("other.internal", extra), false);
  });
  test("hostnameOf", () => {
    assert.equal(hostnameOf("[::1]:3100"), "::1");
    assert.equal(hostnameOf("a.b:9"), "a.b");
  });
});

describe("tokenPolicy (fail-closed)", () => {
  test("token set => enforce", () => assert.equal(tokenPolicy("s3cret", "PAL_BRIDGE_TOKEN", {}).action, "enforce"));
  test("token unset => refuse, message names the env var", () => {
    const p = tokenPolicy("", "PAL_IMESSAGE_BRIDGE_TOKEN", {});
    assert.equal(p.action, "refuse");
    assert.match((p as { message: string }).message, /PAL_IMESSAGE_BRIDGE_TOKEN/);
  });
  test("escape hatch opens in dev with a warning", () => {
    const p = tokenPolicy("", "PAL_BRIDGE_TOKEN", { PAL_BRIDGE_ALLOW_NO_TOKEN: "1" });
    assert.equal(p.action, "open-dev");
    assert.match((p as { warning: string }).warning, /dev only/);
  });
  test("escape hatch is ignored in prod/production/staging", () => {
    for (const e of ["prod", "production", "staging", "PROD"]) {
      assert.equal(tokenPolicy("", "PAL_BRIDGE_TOKEN", { PAL_BRIDGE_ALLOW_NO_TOKEN: "1", PAL_ENV: e }).action, "refuse", e);
    }
  });
  test("hatch must be exactly 1", () => assert.equal(tokenPolicy("", "T", { PAL_BRIDGE_ALLOW_NO_TOKEN: "true" }).action, "refuse"));
});

import { peerAuthHeaders } from "./bridge-http-guard.ts";
describe("peerAuthHeaders sends the DIALLED bridge's token", () => {
  const env = { PAL_BRIDGE_TOKEN: "wa-tok", PAL_IMESSAGE_BRIDGE_TOKEN: "im-tok" };
  test("whatsapp peer => PAL_BRIDGE_TOKEN; imessage peer => PAL_IMESSAGE_BRIDGE_TOKEN", () => {
    assert.equal(peerAuthHeaders("whatsapp", {}, env).Authorization, "Bearer wa-tok");
    assert.equal(peerAuthHeaders("imessage", {}, env).Authorization, "Bearer im-tok");
  });
  test("keeps caller headers; no token => no Authorization header", () => {
    assert.deepEqual(peerAuthHeaders("whatsapp", { "Content-Type": "application/json" }, {}), { "Content-Type": "application/json" });
    assert.equal(peerAuthHeaders("imessage", { a: "b" }, env).a, "b");
  });
});
