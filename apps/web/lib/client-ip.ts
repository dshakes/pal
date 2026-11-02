// The single client IP the /api/pal proxy forwards to the control plane as
// X-Forwarded-For. The control plane rate-limits sign-up, sign-in, password
// reset, verification, bridge pairing and kiosk sessions per client IP, so
// this value must be one a browser cannot choose.
//
//   - `peer` is the TCP peer, stamped by peer-ip.cjs (unforgeable).
//   - Only when that peer is a configured trusted proxy
//     (PAL_DASHBOARD_TRUSTED_PROXIES, comma-separated CIDRs — your ingress)
//     is the incoming X-Forwarded-For consulted, walked from the RIGHT: each
//     proxy appends who connected to it, so the first hop outside the trusted
//     set is the client. Everything left of it is client-supplied.
//   - Otherwise the peer itself is the client; any X-Forwarded-For,
//     X-Real-IP or Forwarded the browser sent is ignored.
//
// Mirrors remoteIP in services/control-plane/internal/handlers/runtime_secrets.go.

function v4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = BigInt(0);
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << BigInt(8)) | BigInt(Number(p));
  }
  return n;
}

function v6ToBigInt(ip: string): bigint | null {
  if (!ip.includes(":")) return null;
  const [head, tail = ""] = ip.split("::");
  if (ip.split("::").length > 2) return null;
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const missing = 8 - h.length - t.length;
  if (missing < 0 || (!ip.includes("::") && missing !== 0)) return null;
  const groups = [...h, ...Array(ip.includes("::") ? missing : 0).fill("0"), ...t];
  let n = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Canonical form: strips brackets/port-less IPv6 brackets and the IPv4-mapped prefix. */
export function canonicalIp(raw: string): string {
  let s = raw.trim().replace(/^\[|\]$/g, "");
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  return s;
}

function toBig(ip: string): { n: bigint; bits: number } | null {
  const c = canonicalIp(ip);
  const v4 = v4ToBigInt(c);
  if (v4 !== null) return { n: v4, bits: 32 };
  const v6 = v6ToBigInt(c);
  return v6 === null ? null : { n: v6, bits: 128 };
}

export function inCidrs(ip: string, cidrs: readonly string[]): boolean {
  const a = toBig(ip);
  if (!a) return false;
  return cidrs.some((cidr) => {
    const [base, lenStr] = cidr.trim().split("/");
    const b = toBig(base ?? "");
    if (!b || b.bits !== a.bits) return false;
    const len = lenStr === undefined ? b.bits : Number(lenStr);
    if (!Number.isInteger(len) || len < 0 || len > b.bits) return false;
    const shift = BigInt(b.bits - len);
    return a.n >> shift === b.n >> shift;
  });
}

export function parseCidrs(env: string | undefined): string[] {
  return (env ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** The client IP to forward, or null when the peer is unknown (preload missing):
 *  then the proxy forwards none, and the control plane keys on the dashboard. */
export function clientIp(peer: string | null, xff: string | null, trusted: readonly string[]): string | null {
  if (!peer) return null;
  const p = canonicalIp(peer);
  if (!inCidrs(p, trusted)) return p;
  let client = p;
  const hops = (xff ?? "").split(",").map((h) => canonicalIp(h)).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!toBig(hops[i])) break; // garbage from a trusted proxy: stop at the last good hop
    client = hops[i];
    if (!inCidrs(client, trusted)) break;
  }
  return client;
}
