import test from "node:test";
import assert from "node:assert/strict";
import { duplicateRuleMessage, DETECTORS, MODES, emptyDraft, hasBlockRule, parseDlpRules, toUpsertBody, validateDraft } from "./dlp.ts";

test("enums match the server validators (handlers/dlp_policy.go)", () => {
  assert.deepEqual([...DETECTORS], ["card_number", "secret_key", "email", "phone", "custom_regex"]);
  assert.deepEqual([...MODES], ["off", "audit", "block"]);
});

test("parseDlpRules drops unknown detectors/modes and malformed rows", () => {
  const rules = parseDlpRules({ rules: [
    { ruleId: "a", detector: "email", mode: "block", threshold: 3, updatedAt: "t" },
    { ruleId: "b", detector: "ssn", mode: "block" },
    { ruleId: "c", detector: "phone", mode: "shout" },
    { detector: "phone", mode: "off" },
    "junk",
    { ruleId: "d", detector: "custom_regex", mode: "audit", pattern: "x+" },
  ] });
  assert.deepEqual(rules.map((r) => r.ruleId), ["a", "d"]);
  assert.equal(rules[0].threshold, 3);
  assert.equal(rules[1].threshold, 1);
  assert.deepEqual(parseDlpRules(null), []);
  assert.deepEqual(parseDlpRules({ rules: "no" }), []);
});

test("validateDraft refuses only what the server certainly refuses", () => {
  const d = emptyDraft();
  assert.match(validateDraft(d) ?? "", /name/);
  assert.equal(validateDraft({ ...d, ruleId: "cards" }), null);
  assert.match(validateDraft({ ...d, ruleId: "x", detector: "custom_regex", pattern: "  " }) ?? "", /pattern/);
  // regex validity is the server's call (RE2 != JS RegExp): an unbalanced-looking pattern is sent, not judged.
  assert.equal(validateDraft({ ...d, ruleId: "x", detector: "custom_regex", pattern: "(?<n>a)\\p{L}" }), null);
  assert.match(validateDraft({ ...d, ruleId: "x", detector: "email", threshold: "0" }) ?? "", /Threshold/);
  assert.match(validateDraft({ ...d, ruleId: "x", detector: "phone", threshold: "1.5" }) ?? "", /Threshold/);
  // threshold is irrelevant (and unchecked) for detectors that ignore it
  assert.equal(validateDraft({ ...d, ruleId: "x", detector: "card_number", threshold: "abc" }), null);
});

test("toUpsertBody sends pattern only for custom_regex and threshold only for email/phone", () => {
  const base = { ...emptyDraft(), ruleId: " r1 ", pattern: "leftover", threshold: "4" };
  assert.deepEqual(toUpsertBody({ ...base, detector: "card_number" }), { ruleId: "r1", detector: "card_number", mode: "audit" });
  assert.deepEqual(toUpsertBody({ ...base, detector: "email" }), { ruleId: "r1", detector: "email", mode: "audit", threshold: 4 });
  assert.deepEqual(toUpsertBody({ ...base, detector: "custom_regex" }), { ruleId: "r1", detector: "custom_regex", mode: "audit", pattern: "leftover" });
});

test("hasBlockRule", () => {
  const r = parseDlpRules({ rules: [{ ruleId: "a", detector: "email", mode: "audit" }] });
  assert.equal(hasBlockRule(r), false);
  assert.equal(hasBlockRule(parseDlpRules({ rules: [{ ruleId: "a", detector: "email", mode: "block" }] })), true);
});

test("adding a rule whose name exists is refused; editing it is fine (server upserts by ruleId)", () => {
  const rules = parseDlpRules({ rules: [{ ruleId: "cards", detector: "card_number", mode: "block" }] });
  const d = { ...emptyDraft(), ruleId: " cards " };
  assert.match(duplicateRuleMessage(rules, d, false) ?? "", /exists/);
  assert.equal(duplicateRuleMessage(rules, d, true), null);
  assert.equal(duplicateRuleMessage(rules, { ...d, ruleId: "other" }, false), null);
  assert.equal(duplicateRuleMessage(null, d, false), null);
});
