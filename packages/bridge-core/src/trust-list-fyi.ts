// Dedupe for the "people with no number/alias lost trust features" owner FYI: persist a
// hash of the list so it repeats only when the list CHANGES, not on every restart.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const FILE = "trust-list.hash";
const hashOf = (names: readonly string[]) => createHash("sha256").update([...names].sort().join("\n")).digest("hex");

export function trustFyiDue(stateDir: string, names: readonly string[]): boolean {
  if (names.length === 0) return false;
  try {
    const f = join(stateDir, FILE);
    return !existsSync(f) || readFileSync(f, "utf8").trim() !== hashOf(names);
  } catch {
    return true;
  }
}

/** Call after the FYI was delivered. 0600. */
export function markTrustFyi(stateDir: string, names: readonly string[]): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const f = join(stateDir, FILE);
    writeFileSync(f, hashOf(names), { mode: 0o600 });
    chmodSync(f, 0o600);
  } catch {
    /* best-effort: worst case the FYI repeats */
  }
}
