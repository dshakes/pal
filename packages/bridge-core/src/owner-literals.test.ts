// CI literal gate (consumer GA PR-2): bridge source must not hard-code ONE
// owner's identity. Scans non-test, non-fixture source of bridge-core and both
// bridges, comments excluded, against fixtures/owner-literals-denylist.json.
//   cd packages/bridge-core && npx tsx --test src/owner-literals.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

interface Entry { label: string; pattern: string; flags?: string; allowIn?: string[] }
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const DENY: Entry[] = JSON.parse(readFileSync(join(HERE, "fixtures", "owner-literals-denylist.json"), "utf8")).entries;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (["node_modules", "dist", "fixtures"].includes(f)) return [];
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(?:ts|tsx|js|mjs)$/.test(f) && !/\.test\.(?:ts|tsx|js)$/.test(f) ? [p] : [];
  });
}

/** Blank block comments, then drop a `//` tail only when it sits outside a
 *  string (even count of quote chars before it), so "x // Name" stays scanned. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      for (let i = line.indexOf("//"); i >= 0; i = line.indexOf("//", i + 1)) {
        const before = line.slice(0, i).replace(/\\./g, "");
        const quotes = (re: RegExp) => (before.match(re) ?? []).length;
        if (quotes(/"/g) % 2 === 0 && quotes(/'/g) % 2 === 0 && quotes(/`/g) % 2 === 0) return before;
      }
      return line;
    })
    .join("\n");
}

function scan(repo: string, roots: string[]): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(join(repo, root))) {
      const rel = relative(repo, file).split("\\").join("/");
      stripComments(readFileSync(file, "utf8")).split("\n").forEach((line, i) => {
        for (const e of DENY) {
          if (e.allowIn?.includes(rel)) continue;
          if (new RegExp(e.pattern, e.flags).test(line)) hits.push(`${rel}:${i + 1} [${e.label}] ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }
  return hits;
}

const ROOTS = [
  "packages/bridge-core/src",
  ...readdirSync(join(REPO, "services")).filter((s) => s.endsWith("-bridge")).map((s) => `services/${s}/src`),
];

test("bridge source contains no owner-specific literals", () => {
  assert.ok(ROOTS.length >= 3, `expected bridge-core + both bridges, got ${ROOTS.join(",")}`);
  assert.deepEqual(scan(REPO, ROOTS), []);
});

test("gate catches a planted literal (mutation) and honours allowIn + comments", () => {
  const tmp = mkdtempSync(join(tmpdir(), "owner-literals-"));
  try {
    mkdirSync(join(tmp, "packages/bridge-core/src"), { recursive: true });
    const d = join(tmp, "packages/bridge-core/src");
    writeFileSync(join(d, "planted.ts"), 'export const p = "send Manasa my passport";\n');
    writeFileSync(join(d, "path.ts"), 'export const h = "/Users/shakes/Documents";\n');
    writeFileSync(join(d, "dialect-te.ts"), 'export const t = "Telangana";\n');
    writeFileSync(join(d, "other.ts"), 'export const t = "Telangana";\n');
    writeFileSync(join(d, "commented.ts"), '// Manasa was here\n/* Shekhar */\nexport const ok = 1;\n');
    writeFileSync(join(d, "instring.ts"), 'export const s = "x // Shekhar";\n');
    writeFileSync(join(d, "w.tsx"), 'export const w = "Madhu";\n');
    writeFileSync(join(d, "x.test.ts"), 'const t = "Manasa";\n');
    const hits = scan(tmp, ["packages/bridge-core/src"]);
    const files = hits.map((h) => h.split(":")[0]).sort();
    assert.deepEqual(files, [
      "packages/bridge-core/src/instring.ts",
      "packages/bridge-core/src/other.ts",
      "packages/bridge-core/src/path.ts",
      "packages/bridge-core/src/planted.ts",
      "packages/bridge-core/src/w.tsx",
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
