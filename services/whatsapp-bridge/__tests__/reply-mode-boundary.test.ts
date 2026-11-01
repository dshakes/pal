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
