// Egress DLP policy (ADR 0030): pure helpers for Settings -> Data protection.
// Enums mirror handlers/dlp_policy.go (validDetectors / validModes), which in
// turn mirror the runtime-manager's compiler. The server stays the authority:
// in particular a custom_regex is NOT validated here, because JS RegExp syntax
// is not the server's RE2 and a client verdict either way would be wrong. We
// only refuse what is certainly invalid (blank pattern) and show the server's
// 400 for the rest.

export const DETECTORS = ["card_number", "secret_key", "email", "phone", "custom_regex"] as const;
export type Detector = (typeof DETECTORS)[number];
export const MODES = ["off", "audit", "block"] as const;
export type DlpMode = (typeof MODES)[number];

export const DETECTOR_LABEL: Record<Detector, string> = {
  card_number: "Card numbers",
  secret_key: "Secret keys",
  email: "Email addresses",
  phone: "Phone numbers",
  custom_regex: "Custom pattern",
};

export const MODE_LABEL: Record<DlpMode, string> = { off: "Off", audit: "Audit only", block: "Block" };

/** email/phone fire only after this many matches in one request; others ignore it. */
export const usesThreshold = (d: Detector): boolean => d === "email" || d === "phone";

export interface DlpRule {
  ruleId: string;
  detector: Detector;
  pattern: string;
  mode: DlpMode;
  threshold: number;
  updatedAt: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const inList = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** GET body is {rules:[...]}; unknown detectors/modes are dropped rather than guessed. */
export function parseDlpRules(raw: unknown): DlpRule[] {
  if (!isRecord(raw) || !Array.isArray(raw.rules)) return [];
  return raw.rules.flatMap((r): DlpRule[] => {
    if (!isRecord(r) || typeof r.ruleId !== "string" || !inList(DETECTORS, r.detector) || !inList(MODES, r.mode)) return [];
    return [{
      ruleId: r.ruleId,
      detector: r.detector,
      pattern: typeof r.pattern === "string" ? r.pattern : "",
      mode: r.mode,
      threshold: typeof r.threshold === "number" && r.threshold >= 1 ? Math.floor(r.threshold) : 1,
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    }];
  });
}

export interface RuleDraft {
  ruleId: string;
  detector: Detector;
  pattern: string;
  mode: DlpMode;
  threshold: string;
}

export const emptyDraft = (): RuleDraft => ({ ruleId: "", detector: "card_number", pattern: "", mode: "audit", threshold: "1" });

/** null = fine to send. Mirrors only the server's certain rules. */
export function validateDraft(d: RuleDraft): string | null {
  if (!d.ruleId.trim()) return "Give the rule a name.";
  if (d.detector === "custom_regex" && !d.pattern.trim()) return "A custom pattern needs a pattern.";
  if (usesThreshold(d.detector)) {
    const n = Number(d.threshold);
    if (!Number.isInteger(n) || n < 1) return "Threshold must be a whole number, 1 or more.";
  }
  return null;
}

/** Wire body for POST /v1/egress/dlp-policy/rules. Pattern only for custom_regex, threshold only where it applies. */
export function toUpsertBody(d: RuleDraft): { ruleId: string; detector: Detector; mode: DlpMode; pattern?: string; threshold?: number } {
  return {
    ruleId: d.ruleId.trim(),
    detector: d.detector,
    mode: d.mode,
    ...(d.detector === "custom_regex" ? { pattern: d.pattern } : {}),
    ...(usesThreshold(d.detector) ? { threshold: Number(d.threshold) } : {}),
  };
}

export const draftFromRule = (r: DlpRule): RuleDraft => ({ ruleId: r.ruleId, detector: r.detector, pattern: r.pattern, mode: r.mode, threshold: String(r.threshold) });

/** Block rules are refused at spawn on nodes without the egress broker. */
export const hasBlockRule = (rules: DlpRule[]): boolean => rules.some((r) => r.mode === "block");
