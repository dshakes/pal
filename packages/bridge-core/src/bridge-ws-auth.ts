// WebSocket authorization for both bridges (GA PR-1). A bridge WS streams every inbound
// message and (WhatsApp) the pairing QR, and a BROWSER WebSocket is exempt from the
// same-origin policy: any web page the owner visits can open ws://localhost:3100/ws.
// Two independent gates, both required:
//   1. Origin  — a browser always sends Origin; it must be a dashboard origin.
//   2. Auth    — the bridge token (non-browser clients, via Authorization: Bearer) or a
//      short-lived SINGLE-USE ticket the dashboard SERVER mints through the token-guarded
//      REST route (browsers can't hold the secret). Fail-closed when no token is configured.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { TokenPolicy } from "./bridge-http-guard.js";

export const WS_TICKET_TTL_MS = 60_000;

export class WsTicketStore {
  private readonly tickets = new Map<string, { tenantId: string; exp: number }>();
  constructor(private readonly ttlMs = WS_TICKET_TTL_MS, private readonly max = 200) {}

  issue(tenantId: string, now = Date.now()): { ticket: string; expiresInMs: number } {
    for (const [k, v] of this.tickets) if (v.exp <= now) this.tickets.delete(k);
    if (this.tickets.size >= this.max) this.tickets.delete(this.tickets.keys().next().value as string);
    const ticket = randomBytes(24).toString("hex");
    this.tickets.set(ticket, { tenantId, exp: now + this.ttlMs });
    return { ticket, expiresInMs: this.ttlMs };
  }

  /** Single use: the ticket is consumed even when it fails the tenant/expiry check. */
  redeem(ticket: string | undefined, tenantId: string, now = Date.now()): boolean {
    if (!ticket) return false;
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return !!t && t.exp > now && t.tenantId === tenantId;
  }
}

const DASHBOARD_DEFAULTS = ["http://localhost:3001", "http://127.0.0.1:3001"];

/** Dashboard origins: defaults + the bridge's CORS list (never "*") + PAL_BRIDGE_ALLOWED_ORIGINS. */
export function allowedWsOrigins(corsOrigin: string | undefined, env: Record<string, string | undefined> = process.env): string[] {
  const split = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().replace(/\/$/, "").toLowerCase()).filter((s) => s && s !== "*");
  return [...new Set([...DASHBOARD_DEFAULTS, ...split(corsOrigin), ...split(env.PAL_BRIDGE_ALLOWED_ORIGINS)])];
}

function tokenEquals(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface WsAuthInput {
  origin: string | undefined;
  allowedOrigins: readonly string[];
  policy: TokenPolicy;
  token: string;
  bearer?: string;
  ticket?: string;
  tenantId: string;
  tickets: WsTicketStore;
  now?: number;
}

export type WsAuthResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

export function authorizeWs(i: WsAuthInput): WsAuthResult {
  if (i.origin !== undefined && !i.allowedOrigins.includes(i.origin.trim().replace(/\/$/, "").toLowerCase())) {
    return { ok: false, status: 403, reason: "origin not allowed" };
  }
  if (i.policy.action === "refuse") return { ok: false, status: 403, reason: "bridge token not configured" };
  if (i.policy.action === "open-dev") return { ok: true };
  if (i.bearer && tokenEquals(i.bearer, i.token)) return { ok: true };
  if (i.tickets.redeem(i.ticket, i.tenantId, i.now)) return { ok: true };
  return { ok: false, status: 401, reason: "unauthorized" };
}
