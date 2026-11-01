import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  resolveReplyMode,
  decideContactReply,
  describeReplyMode,
  budgetFyiDue,
  markBudgetFyi,
  dayKey,
  type ReplyMode,
} from "./reply-mode.ts";

describe("resolveReplyMode", () => {
  test("unset/blank -> drafts (default)", () => {
    for (const v of [undefined, "", "  "]) {
      const r = resolveReplyMode(v);
      assert.equal(r.mode, "drafts");
      assert.equal(r.source, "default");
      assert.equal(r.warning, undefined);
    }
  });
  test("valid values (case/space-insensitive) come from env", () => {
    for (const m of ["drafts", "inner-circle", "everyone"] as const) {
      assert.deepEqual(resolveReplyMode(` ${m.toUpperCase()} `), { mode: m, source: "env" });
    }
  });
  test("invalid -> drafts + warning (refuse-safe)", () => {
    const r = resolveReplyMode("yolo");
    assert.equal(r.mode, "drafts");
    assert.equal(r.source, "invalid");
    assert.match(r.warning ?? "", /yolo/);
  });
  test("startup line states mode and source", () => {
    assert.match(describeReplyMode(resolveReplyMode(undefined)), /drafts.*default/);
    assert.match(describeReplyMode(resolveReplyMode("everyone")), /everyone.*PAL_REPLY_MODE/);
  });
});

const base = { isOwnerChannel: false, isGroup: false, inInnerCircle: false, spam: false };
const act = (mode: ReplyMode, o: Partial<typeof base> = {}) => decideContactReply({ mode, ...base, ...o }).action;

describe("decideContactReply matrix", () => {
  test("owner channel always sends (not a contact reply)", () => {
    for (const m of ["drafts", "inner-circle", "everyone"] as const) assert.equal(act(m, { isOwnerChannel: true }), "send");
  });
  test("drafts: nobody is auto-sent", () => {
    assert.equal(act("drafts", { inInnerCircle: true }), "draft");
    assert.equal(act("drafts"), "draft");
    assert.equal(act("drafts", { isGroup: true }), "draft");
    assert.equal(act("drafts", { spam: true }), "draft");
  });
  test("inner-circle: only known DM contacts are sent", () => {
    assert.equal(act("inner-circle", { inInnerCircle: true }), "send");
    assert.equal(act("inner-circle"), "draft"); // unknown
    assert.equal(act("inner-circle", { spam: true }), "draft");
    assert.equal(act("inner-circle", { inInnerCircle: true, spam: true }), "draft");
    assert.equal(act("inner-circle", { inInnerCircle: true, isGroup: true }), "draft");
  });
  test("everyone: legacy, sends to all", () => {
    for (const o of [{}, { inInnerCircle: true }, { isGroup: true }, { spam: true }]) assert.equal(act("everyone", o), "send");
  });
  test("a draft always carries a reason for the log", () => {
    assert.ok(decideContactReply({ mode: "drafts", ...base }).reason.length > 0);
    assert.ok(decideContactReply({ mode: "inner-circle", ...base }).reason.length > 0);
  });
});

describe("budget (402) FYI is at most once per day, recorded on delivery", () => {
  const t0 = new Date(2026, 10, 1, 9, 0).getTime();
  test("due until delivered; then silent for the day; due again next day", () => {
    const st = {};
    assert.equal(budgetFyiDue(st, t0), true);
    assert.equal(budgetFyiDue(st, t0 + 3_600_000), true); // not yet delivered (send failed) -> still due
    markBudgetFyi(st, t0);
    assert.equal(budgetFyiDue(st, t0 + 5 * 3_600_000), false);
    assert.notEqual(dayKey(t0), dayKey(t0 + 24 * 3_600_000));
    assert.equal(budgetFyiDue(st, t0 + 24 * 3_600_000), true);
  });
});

import { allowContactSend, ALLOW_OWNER_APPROVED, ALLOW_SAFETY_EXCEPTION, type SendAllow } from "./reply-mode.ts";

describe("allowContactSend (the send boundary)", () => {
  const g = (mode: ReplyMode, isOwner: boolean, allow?: SendAllow) => allowContactSend({ mode, destination: "x", isOwner, allow }).ok;
  const sendDec: SendAllow = { kind: "contact-reply", decision: { action: "send", reason: "" } };
  const draftDec: SendAllow = { kind: "contact-reply", decision: { action: "draft", reason: "reply-mode=drafts" } };
  test("owner destination always passes", () => {
    for (const m of ["drafts", "inner-circle", "everyone"] as const) assert.equal(g(m, true), true);
  });
  test("drafts/inner-circle: no token => blocked (every leak path)", () => {
    for (const m of ["drafts", "inner-circle"] as const) assert.equal(g(m, false), false);
  });
  test("a draft decision never opens the boundary", () => {
    for (const m of ["drafts", "inner-circle"] as const) assert.equal(g(m, false, draftDec), false);
  });
  test("send decision, owner-approved and safety exception open it", () => {
    assert.equal(g("inner-circle", false, sendDec), true);
    assert.equal(g("drafts", false, ALLOW_OWNER_APPROVED), true);
    assert.equal(g("drafts", false, ALLOW_SAFETY_EXCEPTION), true);
  });
  test("everyone: legacy, no token needed", () => assert.equal(g("everyone", false), true));
  test("blocked reason is logged text", () => assert.match(allowContactSend({ mode: "drafts", destination: "+1555", isOwner: false }).reason, /blocked/));
});
