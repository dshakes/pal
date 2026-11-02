import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { stampPeer, HEADER } = require("../peer-ip.cjs") as { stampPeer: (h: Record<string, string>, p: string, dev?: boolean) => void; HEADER: string };

test("a client-sent peer header is replaced by the real TCP peer", () => {
  const h: Record<string, string> = { [HEADER]: "6.6.6.6" };
  stampPeer(h, "203.0.113.9");
  assert.equal(h[HEADER], "203.0.113.9");
});

test("an internal loopback hop keeps the stamp from the first hop", () => {
  const h: Record<string, string> = { [HEADER]: "203.0.113.9" };
  stampPeer(h, "127.0.0.1", true);
  assert.equal(h[HEADER], "203.0.113.9");
  const fresh: Record<string, string> = {};
  stampPeer(fresh, "::1");
  assert.equal(fresh[HEADER], "::1");
});

test("in production a loopback peer cannot supply its own stamp", () => {
  const h: Record<string, string> = { [HEADER]: "6.6.6.6" };
  stampPeer(h, "127.0.0.1", false);
  assert.equal(h[HEADER], "127.0.0.1");
});

test("installed on http.Server: handlers see the stamp", async () => {
  const srv = http.createServer((req, res) => res.end(String(req.headers[HEADER])));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  srv.close();
  assert.equal(body, "127.0.0.1");
});
