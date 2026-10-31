#!/usr/bin/env node
// No-literal-color check (dashboard v3).
//
// Foreground/chrome colors must come from tokens (text-fg, border-line,
// bg-panel, text-zinc-50 …) so dark / light / high-contrast and the pal /
// Runtime accent flip everywhere. Literals don't flip: `text-white` goes
// invisible in light, a hex never follows the theme. This fails on:
//   text-white · bg-white/[…] · border-white/[…] · raw hex (#rgb, #rrggbb, #rrggbbaa)
// in apps/web/app and apps/web/components.
//
// It is a ratchet: pre-v3 files carry a baseline count in
// literal-colors-baseline.json (rebuilt slice by slice). A file may never go
// above its baseline, a new file starts at zero, and when a file improves the
// baseline must be lowered (run with --update) so the gain can't be lost.
// ALLOW lists components whose job is a literal color (brand mark, colored
// swatches); each entry says why.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "scripts", "literal-colors-baseline.json");

export const ALLOW = {
  "components/pal-mark.tsx": "brand mark: the logo's own fixed colors",
};

const RULES = [
  [/\btext-white\b(?!\/)/g, "text-white"],
  [/\bbg-white\/\[/g, "bg-white/[…]"],
  [/\bborder-white\/\[/g, "border-white/[…]"],
  // Hex colors; a 3-digit all-numeric "#123" is an issue/PR number, not a color.
  [/(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?![0-9]{3}\b)[0-9a-fA-F]{3})\b/g, "hex"],
];

/** Violations in one file's source: [{ line, rule, text }]. */
export function scan(src) {
  const out = [];
  src.split("\n").forEach((line, i) => {
    for (const [re, rule] of RULES) {
      for (const m of line.matchAll(re)) out.push({ line: i + 1, rule, text: m[0] });
    }
  });
  return out;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.m?ts$/.test(name)) acc.push(p);
  }
  return acc;
}

export function scanTree() {
  const found = {};
  for (const base of ["app", "components"]) {
    for (const file of walk(join(ROOT, base))) {
      const rel = relative(ROOT, file);
      if (ALLOW[rel]) continue;
      const v = scan(readFileSync(file, "utf8"));
      if (v.length) found[rel] = v;
    }
  }
  return found;
}

/** Compare against the baseline. Returns human-readable problems (empty = pass). */
export function compare(found, baseline) {
  const problems = [];
  for (const [file, v] of Object.entries(found)) {
    const allowed = baseline[file] ?? 0;
    if (v.length > allowed) {
      const sample = v.slice(0, 3).map((x) => `${file}:${x.line} ${x.text}`).join("\n    ");
      problems.push(`${file}: ${v.length} literal color(s), baseline ${allowed}. Use a token (text-fg, border-line, bg-panel…).\n    ${sample}`);
    }
  }
  for (const [file, n] of Object.entries(baseline)) {
    const now = found[file]?.length ?? 0;
    if (now < n) problems.push(`${file}: improved to ${now} (baseline ${n}). Lower the baseline: node scripts/check-literal-colors.mjs --update`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = scanTree();
  if (process.argv.includes("--update")) {
    const counts = Object.fromEntries(Object.entries(found).map(([f, v]) => [f, v.length]).sort());
    writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + "\n");
    console.log(`baseline written: ${Object.keys(counts).length} files, ${Object.values(counts).reduce((a, b) => a + b, 0)} literals`);
  } else {
    const problems = compare(found, JSON.parse(readFileSync(BASELINE, "utf8")));
    if (problems.length) {
      console.error("no-literal-color check failed:\n  " + problems.join("\n  "));
      process.exit(1);
    }
    console.log("no-literal-color check: ok");
  }
}
