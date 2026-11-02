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
