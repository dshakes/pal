// Validation for the channel (surface) config form. A field still holding the
// server's mask (lib/redacted.ts) is an unchanged stored secret: the control
// plane keeps the stored value, so the rules for a NEW secret do not apply.
import { isRedacted } from "./redacted.ts";

export interface FieldRule {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  prefix?: string;
  minLength?: number;
}

export function validateFields(fields: Record<string, string>, definitions: readonly FieldRule[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const def of definitions) {
    if (def.type === "readonly") continue;
    const val = (fields[def.key] ?? "").trim();
    if (def.required && !val) { errors[def.key] = `${def.label} is required`; continue; }
    if (isRedacted(val)) continue;
    if (val && def.minLength && val.length < def.minLength) { errors[def.key] = `Must be at least ${def.minLength} characters`; continue; }
    if (val && def.prefix && !val.startsWith(def.prefix)) { errors[def.key] = `Should start with "${def.prefix}"`; }
  }
  return errors;
}
