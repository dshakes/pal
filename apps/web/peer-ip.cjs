// Preloaded into the dashboard server (`node -r ./peer-ip.cjs server.js`, and
// NODE_OPTIONS for `next dev`). Next exposes no peer address to route
// handlers, and only fills X-Forwarded-For when the client did not send one,
// so a handler cannot tell a forged hop from the real one. This stamps the TCP
// peer into `x-pal-peer-ip` before Next sees the request, replacing anything a
// client sent under that name; the /api/pal proxy derives the one client IP it
// forwards from it (lib/client-ip.ts).
//
// Only under `next dev` (NODE_ENV !== "production"), a loopback peer that
// already carries the header is an internal hop (dev forwards to a worker
// process over localhost), so its value is kept. The production server has no
// such hop, so there a loopback peer (e.g. a sidecar reverse proxy) can never
// supply its own value: the header is always overwritten.
"use strict";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS preload (`node --require`), loaded before any ESM
const http = require("node:http");

const HEADER = "x-pal-peer-ip";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Stamp `peer` into headers unless this is an internal loopback hop that
 *  already carries a stamp. Exported for tests. */
function stampPeer(headers, peer, dev = process.env.NODE_ENV !== "production") {
  if (!(dev && LOOPBACK.has(peer) && headers[HEADER])) headers[HEADER] = peer;
}

const emit = http.Server.prototype.emit;
if (!emit.__palPeerIp) {
  const patched = function (event, req, ...rest) {
    if (event === "request" && req && req.headers) {
      stampPeer(req.headers, (req.socket && req.socket.remoteAddress) || "");
    }
    return emit.call(this, event, req, ...rest);
  };
  patched.__palPeerIp = true;
  http.Server.prototype.emit = patched;
}

module.exports = { stampPeer, HEADER };
