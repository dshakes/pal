// Telangana-Telugu dialect module: the ONLY place the owner-specific
// Telangana persona rules and Telugu bot-tell detectors live. Everything here
// is gated on the owner declaring `- dialect: te-telangana` in the
// `## Voice` section of their profile (owner-profile.ts); with no such
// declaration none of it reaches the prompt or the bot-tell net.

import type { OwnerPronouns, OwnerVoice } from "./owner-profile.js";

export const DIALECT_TE_TELANGANA = "te-telangana";

/** True only when the profile's `## Voice` declares the Telangana dialect. */
export function isTeluguTelangana(voice?: OwnerVoice | null): boolean {
  return (voice?.dialect ?? "").replace(/[_\s]+/g, "-") === DIALECT_TE_TELANGANA;
}

/** Clause describing the dialect register, for the owner-voice exemplar block. */
export function teluguTelanganaRegisterNote(poss: string): string {
  return `${poss} natural Telangana register — short verbs, casual, NOT textbook/coastal`;
}

/** Persona prompt lines for an owner who declared the Telangana dialect.
 *  Call only when {@link isTeluguTelangana}. `p` supplies the owner's pronouns. */
export function teluguTelanganaPersonaRules(ownerName: string, p: OwnerPronouns): string[] {
  return [
    `- TELANGANA DIALECT RULE (${ownerName} ALWAYS speaks medium-tone Telangana Telugu — this is ${p.poss} native register, not optional): when replying in Telugu, write the way a Telangana person texts in everyday "medium" tone — neither heavy rural slang nor formal/standard "bookish" coastal Telugu. TWO concrete habits: (1) SHORT VERBS, not long compound forms — "vasta" not "vacchina tarvata", "cheptha" not "cheppedanu", "chustha" not "chustanu", "matladtham" not "matladutanu"/"matladkundam". Every extra syllable is a tell. (2) CASUAL IMPERATIVES for friends/peers/family-${p.poss}-age-or-younger — "cheppu" not "cheppandi", "cheyyi" not "cheyyandi", "vinu" not "vinandi", "kurcho" not "kurchondi". The formal "-andi" / "-ండి" ending is RESPECTFUL — use it ONLY for genuine elders or people ${p.subj} addresses with respect (parents, in-laws, uncles/aunts, ${p.poss} boss, much-older contacts). For everyone else "-andi" sounds stiff and standard, NOT Telangana — drop it. Medium tone also means: NEVER use the vocative/address particles "ra"/"ro"/"da"/"rey"/"ayya"/"vora", and NEVER address anyone as "bava"/"baava" — ${ownerName} does NOT address anyone that way, not even close friends or family, and not even contacts who greet ${p.obj.toUpperCase()} as "bava" (never mirror it back). A single "ra" is an instant tell that you're not ${p.obj} (${p.poss} cousin spotted the bot the moment it said "ra"). When in doubt: shortest grammatical form, casual imperative, no "-andi", and no "ra".`,
    `- TELUGU-OR-ENGLISH RULE — DON'T INVENT TELUGU: you are NOT reliable at inventing Telugu word-forms, and a made-up Telugu word ("nudistunnanu", "relax ayipothundi", "vazthani", "anipinchindi" used wrong) instantly outs you as a bot — far worse than plain English. Only write a Telugu word/phrase if it (or its obvious short form) appears in ${ownerName}'s real example messages above, or in the contact's own message you're replying to. If replying in Telugu would force you to GUESS a verb form or stitch one together, reply in plain casual English instead — ${ownerName} answers Telugu messages in English all the time, and clean English NEVER outs you. The rule: short, real, ATTESTED Telugu — or clean English. Never improvised Telugu.`,
    `- TELUGU EXAMPLES FOR THE OTHER RULES: LIVE-STATE — for "thinnava?" → "meeru tinnara? 🙂" or "malli cheptha". WISHES — also "subhakankshalu" and "puttinaroju subhakankshalu" are wishes; if they wrote in Telugu, thank them in Telugu ("dhanyavadalu 🙏", "thanks 😊").`,
  ];
}

// Romanized-Telugu bot-tells. The owner is a Telangana-dialect speaker who
// (a) shortens verbs aggressively and (b) NEVER uses the "ra"/"ro"/"ay"/
// "ayya"/"vora" end-particles. The persona prompt states these rules, but
// the profile itself notes the model "keeps failing this" — so this is the
// runtime net. We only flag the CLEARLY-bad long compound forms the
// profile's BAD→GOOD list calls out; the GOOD short forms ("vasta",
// "cheptha", "matladtham", "vacchaka") are deliberately NOT matched.
//
// Gated: these only suppress when the draft actually contains Romanized
// Telugu tokens, so an English reply that happens to contain "ra" inside a
// word (already \b-guarded) or an unrelated phrase never trips them.
const TELUGU_LONG_FORM_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    // "vacchina tarvata" / "vachi tarvata" — textbook "after coming".
    // GOOD: "vasta", "vacchaka", "vacchaka matladtham".
    re: /\bva(?:cchina|chi)\s+tar?vata\b/i,
    reason: "textbook Telugu long form (vacchina tarvata)",
  },
  {
    // First-person verb endings in "-tanu"/"-edanu"/"-thanu" that the
    // owner shortens to "-ta"/"-tha". Covers cheptanu/cheppedanu,
    // matladutanu, chustanu, vasthanu/vachedanu.
    re: /\b(?:cheptanu|cheppedanu|matladutanu|chustanu|vasthanu|vachedanu)\b/i,
    reason: "textbook Telugu -tanu/-edanu verb (use short -ta form)",
  },
  {
    // "-dham"/"-kundam" hortatives ("let's …") the owner avoids:
    // matladudham, matladkundam, chuddam.
    re: /\b(?:matladudham|matladkundam|chuddam)\b/i,
    reason: "textbook Telugu hortative (use short form)",
  },
  {
    // "don't know" long forms — telidanduku / teliyadhu. GOOD: telidu,
    // thelvadu.
    re: /\b(?:telidanduku|teliyadhu)\b/i,
    reason: "textbook Telugu 'don't know' (use telidu/thelvadu)",
  },
  {
    // "should give" long form — ivvalsindi. GOOD: iyyali/ivali.
    re: /\bivvalsindi\b/i,
    reason: "textbook Telugu 'should give' (use iyyali/ivali)",
  },
];

// Vocative / address particles the owner NEVER uses to address ANYONE
// (ra/ro/da/rey/ayya/vora). As STANDALONE whitespace/comma-delimited tokens
// at a clause break these are never English words, so — unlike the gated
// "ay" check below — they are flagged even inside an otherwise-English
// reply. This is the exact failure that outed the bot to the owner's
// cousin: "Not automated ra, just quick on the reply 😊" → "you're a bot".
// The leading (start|space|comma) guard keeps "soda."/"ta-da!"/"Libra"
// from matching (the particle must be its own token).
// "bava"/"baava" is in this list per an explicit owner instruction (a cousin
// greeted "Hi Bava" and the bot mirrored "Hi bava, ..." back — the owner
// never addresses ANYONE as bava, even contacts who call him that).
const TELUGU_ADDRESS_PARTICLE_RE =
  /(?:^|[\s,])(?:ra|ro|da|rey|ayya|vora|bava|baava)\s*(?:[.!?,…]|$)/i;

// "ay" is kept gated (it brushes English "aye"/"ay"): only flagged when the
// reply is actually Telugu. Trailing at a clause break, \b-guarded so
// "okay"/"stay"/"way" never match (preceded by a letter, no word boundary).
const TELUGU_END_PARTICLE_RE =
  /\b(?:ay)\s*(?:[.!?,…]|$)/i;

// Hallucinated romanized-Telugu word-salad. The model is NOT reliable at
// INVENTING Telugu verb forms; when it guesses it emits non-words that
// instantly out it (the cousin replied "Oh my god..nudistunnanu endhi" to
// one of these). High-precision, seeded from real prod failures — append
// new impossible forms here as they're observed. The durable fix is the
// persona's TELUGU-OR-ENGLISH rule (reply in English rather than guess); this
// is the runtime net that forces a regenerate when the model ignores it.
const GARBLED_TELUGU_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    // An English word ("nudist", "dedicat…") fused into one token — a real
    // person never types this; it's always a stitched-together hallucination.
    re: /\bnudist\w*\b/i,
    reason: "garbled Telugu (English word fused into a verb form — hallucinated, never sent)",
  },
];

// Romanized-Telugu presence check — gate the particle detector so it only
// fires inside an actually-Telugu reply. Reuses the vocabulary the
// verb-length rules reference plus the dialect markers from the profile.
const TELUGU_PRESENCE_TOKENS = new Set([
  "vasta","vacchaka","vacchina","cheptha","cheptanu","cheppedanu",
  "matladta","matladtham","matladutanu","matladudham","matladkundam",
  "chustha","chustanu","chuddam","ostha","vasthanu","vachedanu",
  "ela","undi","unnav","unnaru","unnara","ostunnav","ostunnaru",
  "thelvadu","telidu","telidanduku","teliyadhu","ledu","ledhu","leda",
  "iyyali","ivali","ivvalsindi","kavali","emi","enti","emaindi",
  "cheppu","cheppara","sare","tappakunda","koncham","ekkada","epudu",
  "baagunnav","repu","ravali","chesthunnav","em","chestunnav","vacchinaru",
  "anna","akka","vadina","bava","amma","abbayi","ammayi",
]);

function hasTeluguTokens(text: string): boolean {
  if (/[ఀ-౿]/.test(text)) return true; // native Telugu script
  const tokens = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const t of tokens) if (TELUGU_PRESENCE_TOKENS.has(t)) return true;
  return false;
}

// Formal/standard Telugu polite imperatives ending in "-andi" / "ండి". A
// medium-tone Telangana speaker uses the casual stem for peers ("cheppu",
// "raa", "cheyyi", "vinu") and reserves "-andi" for elders / respected
// people. Explicit romanized list of the common ones, a generic catch
// (gated by hasTeluguTokens so English "Brandi"/"Sandy" never trips it), and
// the native ండి ending.
const TELUGU_FORMAL_IMPERATIVE_ROMANIZED =
  /\b(?:cheppandi|chepandi|cheppandhi|raandi|randi|vellandi|vellaandi|cheyyandi|cheyandi|vinandi|vinnandi|chudandi|chusandi|tinandi|tinnandi| taagandi|tagandi|ivvandi|ivandi|kurchondi|kurchandi|undandi|adagandi|adugandi|cheskondi|matladandi|matlaadandi|raanandi|poandi|vellipoandi)\b/i;
const TELUGU_FORMAL_IMPERATIVE_GENERIC = /\b[a-z]{3,}andi\b/i;
const TELUGU_FORMAL_IMPERATIVE_NATIVE = /ండి/;

// Relationship strings that warrant respectful "-andi" forms — elders and
// authority. For these the formal imperative is CORRECT, not a tell.
const RESPECT_RELATIONSHIP_RE =
  /\b(?:mother|father|parent|parents|mom|mum|dad|nanna|naanna|amma|grand(?:mother|father|ma|pa)?|uncle|aunt|aunty|maama|mama|mamayya|attha|atthamma|pinni|babai|peddamma|peddanna|peddnanna|in-?law|boss|manager|sir|madam|ma'?am|elder|senior|guru|teacher|professor|principal|doctor|officer)\b/i;

/** True when the relationship label marks an elder / respected person, for
 *  whom the formal Telugu "-andi" imperative is the correct register. */
export function isRespectRelationship(relationship?: string): boolean {
  return !!relationship && RESPECT_RELATIONSHIP_RE.test(relationship);
}

/** Detect a formal/standard Telugu "-andi" imperative used where the owner
 *  (medium-tone Telangana) would use the casual stem. Returns a suppress
 *  reason or null. Spared for elder/respect relationships, where "-andi" is
 *  correct. Exported for focused tests. */
export function detectTeluguFormalImperative(
  draft: string,
  relationship?: string,
): string | null {
  const text = (draft || "").trim();
  if (!text) return null;
  if (isRespectRelationship(relationship)) return null; // "-andi" is correct here
  const romanized =
    TELUGU_FORMAL_IMPERATIVE_ROMANIZED.test(text) ||
    (hasTeluguTokens(text) && TELUGU_FORMAL_IMPERATIVE_GENERIC.test(text));
  if (romanized || TELUGU_FORMAL_IMPERATIVE_NATIVE.test(text)) {
    return "formal Telugu -andi imperative (medium-tone Telangana uses casual cheppu/raa/cheyyi; reserve -andi for elders)";
  }
  return null;
}

/** Scan a draft for Telangana-dialect bot-tells. Returns a reason string
 *  when the draft should be suppressed, or null when clean. Exported for
 *  focused tests. */
export function detectTeluguBotTell(draft: string): string | null {
  const text = (draft || "").trim();
  if (!text) return null;
  // Long compound forms are unambiguous regardless of surrounding language
  // — they're textbook Telugu words a human Telangana texter wouldn't type.
  for (const { re, reason } of TELUGU_LONG_FORM_PATTERNS) {
    if (re.test(text)) return reason;
  }
  // Hallucinated word-salad — fires regardless of surrounding language.
  for (const { re, reason } of GARBLED_TELUGU_PATTERNS) {
    if (re.test(text)) return reason;
  }
  // Vocative/address particles (ra/ro/da/rey/ayya/vora) are flagged
  // UNCONDITIONALLY — as standalone tokens they're never English, and the
  // owner never addresses anyone this way even in an English sentence.
  if (TELUGU_ADDRESS_PARTICLE_RE.test(text)) {
    return "Telugu vocative particle (ra/ro/da/rey/ayya/vora/bava — owner never addresses anyone this way)";
  }
  // "ay" only counts inside an actually-Telugu reply (otherwise an English
  // "aye"/"ay" could brush the \b-guarded particle).
  if (hasTeluguTokens(text) && TELUGU_END_PARTICLE_RE.test(text)) {
    return "Telugu end-particle (ay — owner never uses these)";
  }
  return null;
}
