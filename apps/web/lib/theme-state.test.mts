import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { THEME_INIT_SCRIPT, INIT_PAL_PREFIXES, INIT_RUNTIME_PREFIXES } from "./theme-init-script.ts";
import { PAL_PREFIXES, RUNTIME_PREFIXES, MODE_STORAGE_KEY } from "./workspace-nav.ts";
import { stateDir } from "./state-dir.ts";
import { readPrefs, attrsFor } from "./display-prefs.ts";

function runAll(store: Map<string, string>, osMore = false, pathname = "/brief") {
  const ls = { getItem: (k: string) => store.get(k) ?? null };
  const doc = { documentElement: { dataset: {} as Record<string, string> } };
  const mm = (q: string) => ({ matches: osMore && q.includes("prefers-contrast: more") });
  new Function("localStorage", "document", "matchMedia", "location", THEME_INIT_SCRIPT)(ls, doc, mm, { pathname });
  return doc.documentElement.dataset;
}
const run = (store: Map<string, string>) => runAll(store).theme;

test("theme: persisted pal-theme wins, dark by default", () => {
  assert.equal(run(new Map([["pal-theme", "light"]])), "light");
  assert.equal(run(new Map()), "dark");
});

test("contrast: saved choice wins over the OS; unset follows prefers-contrast", () => {
  assert.equal(runAll(new Map()).contrast, "normal");
  assert.equal(runAll(new Map(), true).contrast, "more");
  assert.equal(runAll(new Map([["pal-contrast", "normal"]]), true).contrast, "normal");
  assert.equal(runAll(new Map([["pal-contrast", "more"]])).contrast, "more");
  assert.equal(runAll(new Map([["pal-contrast", "bogus"]])).contrast, "normal");
});

test("density: compact only when saved, comfortable otherwise", () => {
  assert.equal(runAll(new Map()).density, "comfortable");
  assert.equal(runAll(new Map([["pal-density", "compact"]])).density, "compact");
  assert.equal(runAll(new Map([["pal-density", "tiny"]])).density, "comfortable");
});

test("mode: route decides the accent space pre-paint; /settings remembers; others none", () => {
  assert.equal(runAll(new Map(), false, "/overview").mode, "runtime");
  assert.equal(runAll(new Map(), false, "/agents/x").mode, "runtime");
  assert.equal(runAll(new Map([["pal-mode", "runtime"]]), false, "/brief").mode, "pal");
  assert.equal(runAll(new Map([["pal-mode", "runtime"]]), false, "/settings").mode, "runtime");
  assert.equal(runAll(new Map(), false, "/settings/keys").mode, "pal");
  assert.equal(runAll(new Map([["pal-mode", "runtime"]]), false, "/login").mode, undefined);
  assert.equal(runAll(new Map(), false, "/overviewx").mode, undefined);
});

test("mode: pre-paint prefix lists match workspace-nav", () => {
  assert.deepEqual(INIT_RUNTIME_PREFIXES, RUNTIME_PREFIXES);
  assert.deepEqual(INIT_PAL_PREFIXES, PAL_PREFIXES);
  assert.equal(MODE_STORAGE_KEY, "pal-mode");
});

test("display prefs: read + resolve mirrors the pre-paint script", () => {
  const p = readPrefs((k) => ({ "pal-theme": "light", "pal-contrast": "x", "pal-density": "compact" } as Record<string, string>)[k] ?? null);
  assert.deepEqual(p, { theme: "light", contrast: "system", density: "compact" });
  assert.deepEqual(attrsFor(p, true), { theme: "light", contrast: "more", density: "compact" });
  assert.deepEqual(attrsFor({ ...p, contrast: "normal" }, true).contrast, "normal");
});

test("stateDir: PAL_STATE_DIR, else ~/.pal", () => {
  const saved = process.env.PAL_STATE_DIR;
  try {
    delete process.env.PAL_STATE_DIR;
    assert.equal(stateDir(), join(homedir(), ".pal"));
    process.env.PAL_STATE_DIR = "/x/y";
    assert.equal(stateDir(), "/x/y");
  } finally {
    if (saved === undefined) delete process.env.PAL_STATE_DIR;
    else process.env.PAL_STATE_DIR = saved;
  }
});
