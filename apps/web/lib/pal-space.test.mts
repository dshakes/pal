import test from "node:test";
import assert from "node:assert/strict";
import {
  PersonalApiError, bridgeLinkFromError, capNote, failedLabels, filterPeople, holdOutcome, needsRank,
  parseMemoryContext, parsePeople, planHoldAction, settle, threadsFromSnapshots, timeAgo, SNAPSHOT_STALE_MS,
  type HoldDraft,
} from "./pal-space.ts";
import { buildBriefItems } from "./brief.ts";

const draft: HoldDraft = { id: "d1", displayName: "Raju", jid: "1555@s.whatsapp.net", channel: "whatsapp", draftText: "sure, tomorrow" };

test("approve names recipient + channel and the exact text that goes out", () => {
  const p = planHoldAction("approve", draft);
  assert.ok(p.ok);
  if (p.ok) {
    assert.match(p.title, /Raju.*WhatsApp/);
    assert.equal(p.willSend, "sure, tomorrow");
    assert.equal(p.finalText, "");
  }
});

test("approve of an empty draft is refused (server would mark it sent while sending nothing)", () => {
  const p = planHoldAction("approve", { ...draft, draftText: "   " });
  assert.equal(p.ok, false);
});

test("edit mirrors the server: blank is refused, text is trimmed", () => {
  assert.equal(planHoldAction("edit", draft, " \n ").ok, false);
  const p = planHoldAction("edit", draft, "  see you at 5  ");
  assert.ok(p.ok);
  if (p.ok) {
    assert.equal(p.finalText, "see you at 5");
    assert.equal(p.willSend, "see you at 5");
  }
});

test("discard sends nothing and is the danger tone; falls back to jid when unnamed", () => {
  const p = planHoldAction("discard", { ...draft, displayName: " ", channel: "imessage" });
  assert.ok(p.ok);
  if (p.ok) {
    assert.equal(p.willSend, null);
    assert.equal(p.tone, "danger");
    assert.match(p.title, /1555@s\.whatsapp\.net/);
  }
});

test("outcomes: sendError is NOT success; 404 means already handled", () => {
  assert.equal(holdOutcome("approve", { status: "approved" }).kind, "done");
  const f = holdOutcome("approve", { status: "approved", sendError: "bridge unreachable" });
  assert.equal(f.kind, "delivery_failed");
  assert.match(f.message, /Not delivered/);
  assert.equal(holdOutcome("approve", null, new PersonalApiError(404, "{}")).kind, "gone");
  assert.equal(holdOutcome("approve", null, new PersonalApiError(500, "boom")).kind, "error");
  assert.equal(holdOutcome("discard", { status: "discarded" }).message, "Draft discarded.");
});

test("capNote only fires at the cap", () => {
  assert.equal(capNote("drafts", 99, 100), null);
  assert.match(capNote("drafts", 100, 100) ?? "", /first 100 drafts/);
});

test("settle + failedLabels name the sources that failed", async () => {
  const ok = await settle(Promise.resolve([1]));
  const bad = await settle(Promise.reject(new Error("x")));
  assert.deepEqual(failedLabels([["held replies", ok], ["automations", bad]]), ["automations"]);
});

test("bridge errors: 401/403 = auth, everything else = offline", () => {
  assert.equal(bridgeLinkFromError({ status: 401 }), "auth_required");
  assert.equal(bridgeLinkFromError({ status: 403 }), "auth_required");
  assert.equal(bridgeLinkFromError({ status: 503 }), "offline");
  assert.equal(bridgeLinkFromError(new TypeError("fetch failed")), "offline");
});

const now = Date.parse("2026-11-01T12:00:00Z");
const snap = (channel: string, generatedAt: number | null) => ({
  generatedAt, channel,
  items: [
    { ref: "thread", id: "t1", label: "Madhu", why: "3d", n: 1, defaultAction: "draft" },
    { ref: "draft", id: "x", label: "ignored", n: 2, defaultAction: "send" },
  ],
});

test("snapshot: only fresh threads are ranked; stale channels are named, not ranked", () => {
  const r = threadsFromSnapshots([snap("whatsapp", now - 60_000), snap("imessage", now - SNAPSHOT_STALE_MS - 1), null, snap("x", null)], now);
  assert.deepEqual(r.threads.map((t) => `${t.channel}:${t.id}`), ["whatsapp:t1"]);
  assert.deepEqual(r.stale.map((s) => s.channel), ["imessage"]);
});

test("needsRank: shrinking the set never re-ranks; a new key does", () => {
  const items = buildBriefItems({
    now,
    holds: [
      { id: "a", displayName: "A", inboundText: "", draftText: "x", channel: "whatsapp", createdAt: "2026-11-01T11:00:00Z" },
      { id: "b", displayName: "B", inboundText: "", draftText: "x", channel: "whatsapp", createdAt: "2026-11-01T11:00:00Z" },
      { id: "c", displayName: "C", inboundText: "", draftText: "x", channel: "whatsapp", createdAt: "2026-11-01T11:00:00Z" },
    ],
  });
  assert.equal(needsRank(items, null), true);
  const keys = new Set(items.map((i) => i.key));
  assert.equal(needsRank(items.slice(1), keys), false); // one resolved, two left
  assert.equal(needsRank([...items, { ...items[0], key: "hold:new" }], keys), true);
  assert.equal(needsRank(items.slice(0, 1), null), false); // nothing to order
});

test("people: tolerant parse, filter by name or relationship", () => {
  const people = parsePeople({
    people: [
      { id: "1", displayName: "Madhu", relationship: "sister", isOwner: false, updatedAt: "t" },
      { id: "2", displayName: "", relationship: "", isOwner: true, updatedAt: "t" },
      { displayName: "no id" },
      null,
    ],
  });
  assert.equal(people.length, 2);
  assert.deepEqual(filterPeople(people, "SIST").map((p) => p.id), ["1"]);
  assert.deepEqual(filterPeople(people, "unnamed").map((p) => p.id), ["2"]);
  assert.equal(filterPeople(people, "  ").length, 2);
  assert.deepEqual(parsePeople(null), []);
  assert.deepEqual(parsePeople({ people: "nope" }), []);
});

test("memory context: facts are strings, malformed rows dropped", () => {
  const c = parseMemoryContext({
    personId: "p1", displayName: "Madhu", relationship: "sister",
    handles: [{ channel: "whatsapp", handle: "+1555" }, { channel: "x" }],
    facts: ["likes tea", 4, " "],
    events: [{ channel: "imessage", kind: "message", direction: "in", content: "hi", occurredAt: "t" }, { content: 3 }],
  });
  assert.ok(c);
  assert.equal(c?.handles.length, 1);
  assert.deepEqual(c?.facts, ["likes tea"]);
  assert.equal(c?.events.length, 1);
  assert.equal(parseMemoryContext({}), null);
});

test("timeAgo", () => {
  assert.equal(timeAgo("2026-11-01T11:00:00Z", now), "1h ago");
  assert.equal(timeAgo("garbage", now), "garbage");
});

import { parseDeadlines } from "./pal-space.ts";

test("deadlines: disabled unless the server says enabled; null list tolerated; sorted by date; sourceless rows dropped", () => {
  assert.deepEqual(parseDeadlines({ enabled: false, deadlines: [] }), { enabled: false });
  assert.deepEqual(parseDeadlines(null), { enabled: false });
  assert.deepEqual(parseDeadlines({ enabled: true, deadlines: null }), { enabled: true, items: [] });
  const r = parseDeadlines({
    enabled: true,
    deadlines: [
      { id: "b", who: "A", doc_type: "EAD", deadline: "2027-02-01", basis: "x", confidence: 0.8, source_refs: ["mail"] },
      { id: "a", who: "B", doc_type: "AP", deadline: "2026-12-01", basis: "y", confidence: 0.7, source_refs: [] },
      { who: "no id" },
    ],
  });
  assert.ok(r.enabled);
  if (r.enabled) assert.deepEqual(r.items.map((i) => i.id), ["a", "b"]);
});
