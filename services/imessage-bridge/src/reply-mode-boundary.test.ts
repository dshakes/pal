// Wiring tests for the reply-mode SEND BOUNDARY (GA PR-1). The pure rules live in
// bridge-core/reply-mode.test.ts; these pin that send() enforces them and that every
// contact-facing path carries the right typed allow (so in drafts mode each one is
// blocked into the owner's draft queue unless it is an approved/safety send).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./session.ts", import.meta.url), "utf8");

/** Full text of the first call statement starting at `anchor` (to its closing paren). */
function call(anchor: string): string {
  const i = SRC.indexOf(anchor);
  expect(i, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  const open = SRC.indexOf("(", i);
  let d = 0;
  for (let k = open; k < SRC.length; k++) {
    if (SRC[k] === "(") d++;
    else if (SRC[k] === ")" && --d === 0) return SRC.slice(i, k + 1);
  }
  throw new Error("unbalanced");
}
const allCalls = (prefix: string) => [...SRC.matchAll(new RegExp(prefix.replace(/[.(]/g, "\\$&"), "g"))].map((m) => call(SRC.slice(m.index!, m.index! + 400)));

describe("iMessage send boundary", () => {
  it("send() enforces allowContactSend after the mute check and before any delivery", () => {
    const send = SRC.slice(SRC.indexOf("async send(to: string, text: string, allow?: SendAllow)"));
    const mute = send.indexOf("MUTED — send BLOCKED at boundary");
    const gate = send.indexOf("allowContactSend(");
    const deliver = send.indexOf("this.sender.send(");
    expect(mute).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(mute);
    expect(deliver).toBeGreaterThan(gate);
    expect(send.slice(gate, deliver)).toMatch(/if \(!gate\.ok\) \{[\s\S]*holdBlockedSend\([\s\S]*return \{ ok: false/);
    expect(send.slice(gate, gate + 400)).toContain("mode: this.replyMode.mode");
    expect(send.slice(gate, deliver)).toMatch(/return \{ ok: false/);
  });
  it("a blocked send is handed to the owner as a draft, never dropped silently", () => {
    expect(SRC).toMatch(/holdBlockedSend\(to: string, text: string\)[\s\S]{0,800}draftToOwnerForApproval\(/);
    expect(SRC).toContain("could not be handed to the owner");
  });
  it("replyMode resolves from PAL_REPLY_MODE and is logged at start", () => {
    expect(SRC).toContain("resolveReplyMode(process.env.PAL_REPLY_MODE)");
    expect(SRC).toContain("describeReplyMode(this.replyMode)");
  });
});

describe("iMessage: every leak path carries a typed allow", () => {
  const contact = "this.contactAllow(";
  it.each([
    ["live watch follow-up", "this.send(w.jid, followUp", contact],
    ["garbled voice-note ack", "this.send(row.handle, ack,", contact],
    ["main reply burst", "this.send(sendTarget, piece.text", contact],
    ["greeting fallback", "this.send(target, reply", contact],
    ["contact share", "this.send(row.handle, numbers", contact],
    ["prompt-injection refusal (held in drafts)", 'this.send(row.handle, escalationRefusalReply("prompt-injection"', contact],
    ["life-threat refusal (documented exception)", 'this.send(row.handle, escalationRefusalReply("life-threat"', "ALLOW_SAFETY_EXCEPTION"],
    ["owner-approved draft", "this.send(pending.target, pending.draft", "ALLOW_OWNER_APPROVED"],
    ["owner-approved pending send", "this.send(pending.target, body", "ALLOW_OWNER_APPROVED"],
    ["owner tapback retry", "this.send(recipientHandle, trimmed", "ALLOW_OWNER_APPROVED"],
  ])("%s", (_n, anchor, token) => {
    expect(call(anchor)).toContain(token);
  });
  it("every spouse-agent reply to the contact carries contactAllow", () => {
    const sends = allCalls("this.send(handle, resp.replyToSpouse").concat(allCalls("this.send(handle, reply"));
    expect(sends.length).toBeGreaterThanOrEqual(4);
    for (const c of sends) expect(c).toContain("this.contactAllow(handle)");
  });
  it("spouse agent is skipped when reply mode would draft", () => {
    expect(SRC).toMatch(/spouse agent skipped — reply mode drafts/);
    expect(SRC).toContain("const spouseAllow = this.contactAllow(row.handle);");
    expect(SRC).toMatch(/spouseAllow\.decision\.action !== "send"/);
  });
  it("membership is decided after the owner's address-book name is hydrated", () => {
    const iSpouse = SRC.indexOf("const spouseAllow");
    expect(SRC.lastIndexOf("await this.hydrateContactName(row.handle)", iSpouse)).toBeGreaterThan(iSpouse - 400);
    const iMode = SRC.indexOf("const modeDecision");
    expect(SRC.lastIndexOf("await this.hydrateContactName(row.handle)", iMode)).toBeGreaterThan(iMode - 900);
  });
});

describe("iMessage: auto-act is opt-in", () => {
  it("uses autoActEnabled / explicit owner opt-in, never default-on", () => {
    expect(SRC).toMatch(/autoActEnabled\(process\.env\.PAL_LIFE_EVENT_AUTOACT\) \|\| isAutoActOptedIn\(\)/);
    expect(SRC).not.toMatch(/PAL_LIFE_EVENT_AUTOACT \|\| "on"/);
  });
});

const INDEX = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("iMessage: owner-approved REST send + doc link", () => {
  it("/send carries owner-approved via ownerApprovedSend (dashboard Approve/Edit delivers; a block is 409)", () => {
    expect(INDEX).toMatch(/ownerApprovedSend\(\(allow\) => s\.send\(to, message, allow\)\)/);
    expect(INDEX).not.toMatch(/await s\.send\(to, message\);/);
  });
  it("doc-link delivery (owner-approved relay + re-delivery watch) carries owner-approved", () => {
    expect(call("this.send(target, buildDocLinkMessage")).toContain("ALLOW_OWNER_APPROVED");
  });
});

describe("bridge HTTP hardening (Host allowlist, fail-closed token, peer tokens)", () => {
  it("Host allowlist runs before cors/json and guards the websocket upgrade", () => {
    const host = INDEX.indexOf("isAllowedHost(req.headers.host, ALLOWED_HOSTS)");
    expect(host).toBeGreaterThan(-1);
    expect(host).toBeLessThan(INDEX.indexOf("app.use(cors("));
    expect(INDEX).toMatch(/verifyClient:[\s\S]{0,400}isAllowedHost\(/);
    expect(INDEX).toContain("res.status(403).json({ error: \"forbidden host\" })");
  });
  it("an unset token refuses /session with 403 naming PAL_IMESSAGE_BRIDGE_TOKEN (never next())", () => {
    expect(INDEX).toContain('tokenPolicy(BRIDGE_TOKEN, "PAL_IMESSAGE_BRIDGE_TOKEN", process.env)');
    const fn = INDEX.slice(INDEX.indexOf("function requireToken("));
    expect(fn.slice(0, 500)).toMatch(/action === "refuse"[\s\S]*status\(403\)/);
    // nothing may call next() before the policy checks (open-dev hatch is the only pass-through)
    expect(fn.slice(0, fn.indexOf('action === "refuse"'))).toMatch(/^[^]*\{\s*if \(TOKEN_POLICY\.action === "open-dev"\) (\{ next\(\); return; \}|return next\(\);)\s*if \(TOKEN_POLICY\.action === "refuse"|^[^]*action === "open-dev"/);
    expect(fn.slice(0, fn.indexOf('action === "refuse"'))).toContain('TOKEN_POLICY.action === "open-dev"');
    expect(INDEX).not.toMatch(/if \(!BRIDGE_TOKEN\) \{ next\(\); return; \}/);
  });
  it("refuses to start on a non-loopback bind without a token (ported from WhatsApp)", () => {
    expect(INDEX).toMatch(/!isLoopback && !BRIDGE_TOKEN[\s\S]{0,200}process\.exit\(1\)/);
  });
  it("every call to the WhatsApp bridge sends PAL_BRIDGE_TOKEN (the peer's token, not ours)", () => {
    const calls = [...SRC.matchAll(/fetch\(`\$\{(waBase|waUrl|peerBase)\}\/session\//g)];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const m of calls) {
      const win = SRC.slice(Math.max(0, m.index! - 700), m.index! + 500);
      expect(win, `no token near: ${win.slice(0, 80)}`).toMatch(/peerAuthHeaders\("whatsapp"|Authorization/);
    }
    expect(SRC).not.toMatch(/peerAuthHeaders\("imessage"/);
  });
});

describe("WebSocket is authorised at the upgrade (cross-site WS hijack)", () => {
  it("verifyClient enforces Host, Origin and token/ticket via authorizeWs, on loopback too", () => {
    const i = INDEX.indexOf("verifyClient:");
    expect(i).toBeGreaterThan(-1);
    const body = INDEX.slice(i, i + 1500);
    expect(body).toContain("isAllowedHost(req.headers.host, ALLOWED_HOSTS)");
    expect(body).toMatch(/authorizeWs\(\{\s*origin: req\.headers\.origin,/);
    expect(body).toContain("authorizeWs(");
    expect(body).toContain("policy: TOKEN_POLICY");
    expect(body).toContain('searchParams.get("ticket")');
    expect(body).toMatch(/cb\(r\.ok, r\.ok \? undefined : r\.status/);
  });
  it("no loopback-only exemption remains; nothing is sent before auth (QR / messages)", () => {
    expect(INDEX).not.toMatch(/if \(BRIDGE_TOKEN && !isLoopback\)/);
    expect(INDEX).not.toMatch(/searchParams\.get\("token"\)/);
  });
  it("tickets are minted only through the token-guarded /session route", () => {
    const guard = INDEX.indexOf('app.use("/session", requireToken');
    const route = INDEX.indexOf('app.post("/session/:tenantId/ws-ticket"');
    expect(guard).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(guard);
    expect(INDEX).toContain("WS_TICKETS.issue(req.params.tenantId)");
  });
});
