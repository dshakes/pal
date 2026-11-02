// Wiring tests for the reply-mode SEND BOUNDARY (GA PR-1), WhatsApp twin of
// services/imessage-bridge/src/reply-mode-boundary.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");

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
const allCalls = (prefix: string) => {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const i = SRC.indexOf(prefix, from);
    if (i < 0) return out;
    out.push(call(SRC.slice(i, i + 400)));
    from = i + 1;
  }
};

describe("WhatsApp send boundary", () => {
  it("sendMessage() enforces allowContactSend after the mute check and before the socket", () => {
    const fn = SRC.slice(SRC.indexOf("  async sendMessage("));
    const mute = fn.indexOf("MUTED — send BLOCKED at boundary");
    const gate = fn.indexOf("allowContactSend(");
    const sock = fn.indexOf("this.socket.sendMessage(jid, { text }");
    expect(gate).toBeGreaterThan(mute);
    expect(sock).toBeGreaterThan(gate);
    expect(fn.slice(gate, sock)).toMatch(/if \(!gate\.ok\) \{[\s\S]*holdBlockedSend\([\s\S]*return undefined/);
    expect(fn.slice(gate, gate + 400)).toContain("mode: this.replyMode.mode");
  });
  it("reactions go through the same boundary (owner-only unless the mode allows)", () => {
    const fn = SRC.slice(SRC.indexOf("private async sendReaction("));
    expect(fn.indexOf("allowContactSend(")).toBeGreaterThan(-1);
    expect(fn.indexOf("allowContactSend(")).toBeLessThan(fn.indexOf("this.socket.sendMessage(jid"));
    expect(fn).toMatch(/if \(!gate\.ok\) \{[\s\S]{0,200}return;/);
  });
  it("a blocked send is queued + paged to the owner as a draft, never dropped silently", () => {
    expect(SRC).toMatch(/holdBlockedSend\(to: string, text: string\)[\s\S]{0,900}queueDraft\(/);
    expect(SRC).toContain("could not be handed to the owner");
  });
  it("the mode decision is made INSIDE handleAgentReply so queue replay and history catch-up agree", () => {
    const fn = SRC.slice(SRC.indexOf("private async handleAgentReply("));
    expect(fn.slice(0, 6000)).toContain("decideContactReply(");
    // not (only) at the live call site
    const live = SRC.slice(SRC.indexOf("this.handleAgentReply(from, text, {") - 200, SRC.indexOf("this.handleAgentReply(from, text, {") + 100);
    expect(live).not.toContain("decideContactReply(");
  });
  it("inner-circle membership ignores contact-controlled display names", () => {
    expect(SRC).toContain("declaredRelationshipFor(jid)");
    const i = SRC.indexOf("private isInnerCircleJid");
    expect(SRC.slice(i, i + 400)).not.toContain("senderName");
  });
});

describe("WhatsApp: every leak path carries a typed allow", () => {
  const contact = "this.contactAllow(";
  it.each([
    ["overnight replay / history catch-up main reply", "this.sendMessage(from, msg.text, {", contact],
    ["live watch follow-up", "this.sendMessage(w.jid, followUp", contact],
    ["garbled voice-note ack", "this.sendMessage(from, ack, {", contact],
    ["voice-note 🙏 reaction", 'this.sendReaction(from, msg.key, "🙏"', contact],
    ["auto-reaction instead of reply", "this.sendReaction(from, opts.msgKey, verdict.reaction", contact],
    ["handoff disclosure", "this.sendMessage(from, disclosure", contact],
    ["greeting fallback", "this.sendMessage(to, reply", contact],
    ["contact share", "this.sendMessage(from, numbers", contact],
    ["prompt-injection refusal (held in drafts)", 'this.sendMessage(from, escalationRefusalReply("prompt-injection"', contact],
    ["life-threat refusal (documented exception)", "this.sendMessage(from, reply, { allow: ALLOW_SAFETY_EXCEPTION", "ALLOW_SAFETY_EXCEPTION"],
    ["owner-approved pending send", "this.sendMessage(pending.targetJid, body", "ALLOW_OWNER_APPROVED"],
    ["owner-approved draft", "this.sendMessage(pending.targetJid, pending.draftText", "ALLOW_OWNER_APPROVED"],
    ["owner-edited draft", "this.sendMessage(pending.targetJid, replacement", "ALLOW_OWNER_APPROVED"],
  ])("%s", (_n, anchor, token) => {
    expect(call(anchor)).toContain(token);
  });
  it("every spouse-agent reply carries contactAllow, and the agent is skipped when the mode drafts", () => {
    const sends = allCalls("this.sendMessage(from, resp.replyToSpouse").concat(allCalls("this.sendMessage(from, reply, {"));
    expect(sends.length).toBeGreaterThanOrEqual(4);
    for (const c of sends.filter((x) => !x.includes("ALLOW_SAFETY_EXCEPTION"))) expect(c).toContain("this.contactAllow(from)");
    expect(SRC).toContain("const spouseAllow = this.contactAllow(from);");
    expect(SRC).toMatch(/spouseAllow\.decision\.action !== "send"/);
    expect(SRC).toMatch(/spouse agent skipped — reply mode drafts/);
  });
  it("greeting fallbacks are skipped under a hold", () => {
    expect(SRC).toContain("opts.mutedHold ? false : await this.sendGreetingFallback");
  });
});

describe("WhatsApp: auto-act is opt-in", () => {
  it("uses autoActEnabled / explicit owner opt-in, never default-on", () => {
    expect(SRC).toMatch(/autoActEnabled\(process\.env\.PAL_LIFE_EVENT_AUTOACT\) \|\| isAutoActOptedIn\(\)/);
  });
});

const INDEX = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("WhatsApp: pushName spoof cannot open a trust gate", () => {
  it("spouse agent decides on handle/alias only", () => {
    expect(SRC).toContain("const relForAgent = this.ownerProfileStore.declaredRelationshipFor(from);");
  });
  it("## Now, location sharing and contact-share use the trusted (declared) relationship", () => {
    expect(SRC).toContain("const trustedRelationship = opts.isGroup ? undefined : this.ownerProfileStore.declaredRelationshipFor(from);");
    expect(SRC).toContain("isInnerCircle(trustedRelationship) ? this.ownerProfileStore.nowBlock()");
    expect(SRC).toContain("const canShare = isInnerCircle(trustedRelationship) && !denyLoc;");
    expect(SRC).toContain("requesterInnerCircle: isInnerCircle(trustedRelationship)");
    // the name-matched `relationship` must not feed those gates
    expect(SRC).not.toContain("isInnerCircle(relationship)");
  });
  it("task capture from a 'VIP/spouse' needs a declared relationship", () => {
    const i = SRC.indexOf("private async maybeCaptureCommitment(");
    expect(SRC.slice(i, i + 1600)).toContain("declaredRelationshipFor(jid)");
  });
});

describe("WhatsApp: owner-approved REST send + retry + hold keys", () => {
  it("/send carries owner-approved via ownerApprovedSend and reports a block as 409 (never 'sent')", () => {
    expect(INDEX).toContain("ownerApprovedSend(");
    expect(INDEX).toMatch(/sendMessage\(to, message, \{ allow, throwOnBlock: true \}\)/);
    expect(INDEX).toContain("ReplyModeBlockedError");
    expect(INDEX).not.toMatch(/session\.sendMessage\(to, message\);/);
  });
  it("sendMessage throws (and queues no second draft) when throwOnBlock is set", () => {
    const fn = SRC.slice(SRC.indexOf("  async sendMessage("));
    const gate = fn.indexOf("if (!gate.ok)");
    expect(fn.slice(gate, gate + 700)).toMatch(/if \(opts\.throwOnBlock\) throw new ReplyModeBlockedError\(to\);[\s\S]*holdBlockedSend/);
  });
  it("critique-retry text goes through the guarded path, not the raw socket", () => {
    expect(SRC).not.toContain("this.socket?.sendMessage(sendJid");
    expect(SRC).toContain("this.sendMessage(sendJid, retried.trim(), { allow: this.contactAllow(sendJid) })");
  });
  it("held drafts use composite owner::contact keys", () => {
    expect(SRC).toContain("this.pendingDraftEdits.set(`${ownerThread}::${to}`");
    expect(SRC).toContain("this.pendingDraftEdits.set(`${ownerThread}::${from}`");
  });
});

describe("bridge HTTP hardening (Host allowlist, fail-closed token, peer tokens)", () => {
  it("Host allowlist runs before cors/json and guards the websocket upgrade", () => {
    const host = INDEX.indexOf("isAllowedHost(req.headers.host, ALLOWED_HOSTS)");
    expect(host).toBeGreaterThan(-1);
    expect(host).toBeLessThan(INDEX.indexOf("app.use(\n  cors("));
    expect(INDEX).toMatch(/verifyClient: .*isAllowedHost\(/);
    expect(INDEX).toContain("res.status(403).json({ error: \"forbidden host\" })");
  });
  it("an unset token refuses /session with 403 naming PAL_BRIDGE_TOKEN (never next())", () => {
    expect(INDEX).toContain('tokenPolicy(BRIDGE_TOKEN, "PAL_BRIDGE_TOKEN", process.env)');
    const fn = INDEX.slice(INDEX.indexOf("function requireToken("));
    expect(fn.slice(0, 500)).toMatch(/action === "refuse"[\s\S]*status\(403\)/);
    // nothing may call next() before the policy checks (open-dev hatch is the only pass-through)
    expect(fn.slice(0, fn.indexOf('action === "refuse"'))).toMatch(/^[^]*\{\s*if \(TOKEN_POLICY\.action === "open-dev"\) (\{ next\(\); return; \}|return next\(\);)\s*if \(TOKEN_POLICY\.action === "refuse"|^[^]*action === "open-dev"/);
    expect(fn.slice(0, fn.indexOf('action === "refuse"'))).toContain('TOKEN_POLICY.action === "open-dev"');
    expect(INDEX).not.toMatch(/if \(!BRIDGE_TOKEN\) return next\(\);/);
  });
  it("every call to the iMessage bridge sends PAL_IMESSAGE_BRIDGE_TOKEN (the peer's token, not ours)", () => {
    const calls = [...SRC.matchAll(/fetch\(`\$\{(imBase|imUrl|peerBase)\}\/session\//g)];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const m of calls) {
      const win = SRC.slice(Math.max(0, m.index! - 700), m.index! + 500);
      expect(win, `no token near: ${win.slice(0, 80)}`).toMatch(/peerAuthHeaders\("imessage"|Authorization/);
    }
    expect(SRC).not.toMatch(/peerAuthHeaders\("whatsapp"/);
  });
});

describe("WhatsApp: throwOnBlock covers mute and blocked groups; trust-gate follow-ups", () => {
  it("mute and blocked-group refusals throw typed errors for REST callers", () => {
    expect(SRC).toContain('if (opts.throwOnBlock) throw new ReplyModeBlockedError(to, "muted");');
    expect(SRC).toContain('if (opts.throwOnBlock) throw new ReplyModeBlockedError(to, "group_blocked");');
  });
  it("confidence tiering uses the trusted relationship, not the pushName-matched one", () => {
    expect(SRC).toContain("relationship: trustedRelationship, // trust gate");
    expect(SRC).toMatch(/ownerSamples\.length === 0 &&\s+!trustedRelationship &&/);
  });
  it("startup WARN + one owner FYI (registered 🧭 prefix) lists name-only relationships", () => {
    expect(SRC).toContain("untrustedRelationshipNames()");
    expect(SRC).toMatch(/confirmToSelf\(\s*`🧭 \$\{names\.length\}/);
    expect(SRC).toMatch(/connection === "open"[\s\S]{0,1500}this\.checkTrustList\(\)/);
  });
});
