import test from "node:test";
import assert from "node:assert/strict";
import { clientIp, inCidrs, parseCidrs } from "./client-ip.ts";

test("untrusted peer: the browser's X-Forwarded-For is ignored", () => {
  assert.equal(clientIp("203.0.113.9", "1.1.1.1", []), "203.0.113.9");
  assert.equal(clientIp("203.0.113.9", "1.1.1.1", ["10.0.0.0/8"]), "203.0.113.9");
  assert.equal(clientIp("::ffff:203.0.113.9", null, []), "203.0.113.9");
});

test("trusted ingress: rightmost untrusted hop wins; forged left entries ignored", () => {
  const trust = ["10.0.0.0/8"];
  assert.equal(clientIp("10.0.0.5", "6.6.6.6, 198.51.100.7", trust), "198.51.100.7");
  assert.equal(clientIp("10.0.0.5", "198.51.100.7, 10.0.0.9", trust), "198.51.100.7");
  assert.equal(clientIp("10.0.0.5", "garbage, 198.51.100.7", trust), "198.51.100.7");
  assert.equal(clientIp("10.0.0.5", "198.51.100.7, garbage", trust), "10.0.0.5"); // stop at garbage
  assert.equal(clientIp("10.0.0.5", null, trust), "10.0.0.5");
});

test("no peer (preload missing): forward nothing", () => {
  assert.equal(clientIp(null, "1.1.1.1", []), null);
});

test("CIDR matching, v4 and v6", () => {
  assert.ok(inCidrs("10.1.2.3", ["10.0.0.0/8"]));
  assert.ok(!inCidrs("11.1.2.3", ["10.0.0.0/8"]));
  assert.ok(inCidrs("192.168.1.1", ["192.168.1.1"]));
  assert.ok(inCidrs("fd00::1", ["fd00::/8"]));
  assert.ok(!inCidrs("fe80::1", ["fd00::/8"]));
  assert.ok(!inCidrs("10.0.0.1", ["fd00::/8"]));
  assert.ok(!inCidrs("not-an-ip", ["0.0.0.0/0"]));
  assert.deepEqual(parseCidrs(" 10.0.0.0/8 , ,fd00::/8"), ["10.0.0.0/8", "fd00::/8"]);
});
