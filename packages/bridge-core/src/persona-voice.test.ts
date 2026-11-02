// De-owner the persona (consumer GA PR-2): the `## Voice` profile section is
// the ONLY source of dialect + pronouns. No Voice ⇒ neutral English, they/them.
//   cd packages/bridge-core && npx tsx --test src/persona-voice.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseProfile, ownerPronouns } from "./owner-profile.ts";
import { agentPersonaPrompt, detectBotTells, inferStyle } from "./natural.ts";

const style = inferStyle([]);

// The exact block the owner adds to keep today's behaviour (see the PR body).
const OWNER_VOICE = `## Voice
- dialect: te-telangana
- languages: English, Telugu
- pronouns: he/him
- register: medium-tone Telangana Telugu; short verbs (vasta, cheptha, chustha), casual imperatives (cheppu, not cheppandi); -andi only for elders; English is fine whenever unsure
- never: ra, ro, da, rey, ayya, vora, bava, baava
`;

// Third-party "he" the persona legitimately keeps (a tracked person, a friend).
const THIRD_PARTY = ["lemme know when he lands", "yeah he's in Dublin", "yeah he said Friday works"];
function ownerHeCount(p: string): string[] {
  let t = p;
  for (const k of THIRD_PARTY) t = t.split(k).join("");
  return t.match(/.{25}\b(?:he|his|him|himself|he's)\b.{15}/gi) ?? [];
}

const variants = [
  { audience: "contact" as const },
  { audience: "owner" as const },
  { audience: "contact" as const, canWebSearch: true, disclosed: true },
  { audience: "contact" as const, inboundUrgent: true, unansweredBacklog: 3, schedulingEnabled: true, freeSlotsBlock: "after 6pm" },
];

// ── parser ──

test("parser: ## Voice section → typed voice, kept out of prose", () => {
  const prof = parseProfile(`# Owner profile\n\n## About me\nI run a shop.\n\n${OWNER_VOICE}\n## Facts\n- married: yes\n`);
  const v = prof.voice;
  assert.ok(v);
  assert.equal(v.dialect, "te-telangana");
  assert.deepEqual(v.languages, ["English", "Telugu"]);
  assert.equal(v.pronouns.poss, "his");
  assert.equal(v.pronouns.plural, false);
  assert.equal(v.register.length, 1);
  assert.deepEqual(v.neverUse, ["ra", "ro", "da", "rey", "ayya", "vora", "bava", "baava"]);
  assert.ok(!prof.prose.includes("te-telangana"), "voice leaked into prose");
  assert.equal(prof.facts?.maritalStatus, "married", "following section still parsed");
});

test("parser: no ## Voice (or only template comments) ⇒ undefined; pronouns default they", () => {
  assert.equal(parseProfile("## About me\nhi\n").voice, undefined);
  assert.equal(parseProfile("## Voice\n# - dialect: <x>\n").voice, undefined);
  assert.equal(ownerPronouns(undefined).subj, "they");
});

test("parser: pronoun sets, unknown pronoun ignored, bare bullet = register, 'Voice & languages' heading", () => {
  assert.equal(parseProfile("## Voice\n- pronouns: she/her\n").voice?.pronouns.obj, "her");
  assert.equal(parseProfile("## Voice\n- pronouns: they/them\n").voice?.pronouns.plural, true);
  assert.equal(parseProfile("## Voice\n- pronouns: xe/xem\n- dialect: x\n").voice?.pronouns.subj, "they");
  assert.deepEqual(parseProfile("## Voice\n- lowercase, dry\n").voice?.register, ["lowercase, dry"]);
  assert.equal(parseProfile("## Voice & languages\n- dialect: te-telangana\n").voice?.dialect, "te-telangana");
});

// ── persona ──

test("persona with no Voice is neutral: no dialect rules, no he/his, no placeholders", () => {
  for (const isGroup of [false, true]) {
    for (const v of variants) {
      const p = agentPersonaPrompt("Ada", style, isGroup, v);
      assert.doesNotMatch(p, /Telangana|TELANGANA|TELUGU-OR-ENGLISH|cheppu|-andi|vacchina/i);
      assert.deepEqual(ownerHeCount(p), [], "owner he/his leaked into neutral persona");
      assert.ok(!p.includes("${"), "unrendered template placeholder");
      assert.match(p, /their/);
    }
  }
});

test("persona with the dialect declared contains the rules and the owner's pronouns", () => {
  const voice = parseProfile(OWNER_VOICE).voice;
  const p = agentPersonaPrompt("Ada", style, false, { voice, audience: "contact" });
  assert.match(p, /TELANGANA DIALECT RULE/);
  assert.match(p, /this is his native register/);
  assert.match(p, /TELUGU-OR-ENGLISH RULE/);
  assert.match(p, /NEVER use the vocative\/address particles/);
  assert.match(p, /cheppu/);
  assert.ok(!p.includes("${"));
});

test("persona uses declared pronouns (she/her, they/them) and verb agreement", () => {
  const she = agentPersonaPrompt("Ada", style, false, { voice: parseProfile("## Voice\n- pronouns: she/her\n").voice });
  assert.match(she, /her calendar/);
  assert.match(she, /she's heads-down/);
  assert.deepEqual(ownerHeCount(she), []);
  const they = agentPersonaPrompt("Ada", style, false, { voice: parseProfile("## Voice\n- pronouns: they/them\n").voice });
  assert.match(they, /they're heads-down/);
  assert.match(they, /they don't have it/);
  assert.doesNotMatch(they, /they doesn't|they's/);
});

test("a Voice without a dialect adds no Telugu rules", () => {
  const p = agentPersonaPrompt("Ada", style, false, { voice: parseProfile("## Voice\n- pronouns: he/him\n").voice });
  assert.doesNotMatch(p, /TELANGANA|TELUGU-OR-ENGLISH/);
  assert.match(p, /his calendar/);
});

// ── detectBotTells gating ──

const TE = parseProfile(OWNER_VOICE).voice;

test("Telugu dialect tells are gated on the declared dialect", () => {
  const drafts = [
    "ha cheppandi, repu matladtham", // formal -andi to a peer
    "repu vacchina tarvata matladtham", // textbook long form
    "Not automated ra, just quick on the reply", // vocative in English
    "nudistunnanu 🙂 meeru?", // garbled Telugu
  ];
  for (const d of drafts) {
    assert.equal(detectBotTells(d, "hi").ok, true, `neutral profile must not flag: ${d}`);
    assert.equal(detectBotTells(d, "hi", { voice: { ...TE!, neverUse: [] } }).ok, false, `dialect profile must flag: ${d}`);
  }
});

test("never-use list is enforced for any owner, whole-word only", () => {
  const v = parseProfile("## Voice\n- never: bro, per my last email\n").voice;
  assert.equal(detectBotTells("sure bro, on it", "hi", { voice: v }).ok, false);
  assert.match(detectBotTells("per my last email, yes", "hi", { voice: v }).reason ?? "", /never-use/);
  assert.equal(detectBotTells("the broom is in the closet", "hi", { voice: v }).ok, true);
  assert.equal(detectBotTells("sure bro, on it", "hi").ok, true, "no voice ⇒ no never-list");
});
