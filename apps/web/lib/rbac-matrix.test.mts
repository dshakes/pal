import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ACTIONS, ROLES, actionsFor, buildMatrix } from "./rbac-matrix.ts";

const ids = (role: string) => actionsFor(role).map((a) => a.id);
const web = new URL("../", import.meta.url);

test("action ids are unique", () => {
  assert.equal(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length);
});

test("roles are nested: viewer < member < admin < owner, and kiosk is within member", () => {
  const sub = (a: string, b: string) => ids(a).every((id) => ids(b).includes(id));
  assert.ok(sub("viewer", "member"));
  assert.ok(sub("member", "admin"));
  assert.ok(sub("admin", "owner"));
  assert.ok(sub("kiosk", "member"));
});

test("viewer and unknown roles are offered nothing that changes state", () => {
  assert.deepEqual(ids("viewer"), []);
  assert.deepEqual(ids(undefined), []);
  assert.deepEqual(ids("superuser"), []);
});

test("member builds and runs but is not offered admin surfaces", () => {
  const m = ids("member");
  for (const ok of ["agent.create", "agent.edit", "agent.run", "agent.security", "evalsuite.run", "run.takeover", "brief.act", "marketplace.use"]) {
    assert.ok(m.includes(ok), `member should get ${ok}`);
  }
  for (const no of [
    "settings.keys", "settings.billing", "settings.devices", "settings.dlp", "settings.audit", "settings.danger",
    "budget.edit", "connector.manage", "mcp.manage", "runtime.admin", "runtime.schedule", "promote.approve",
    "dataplane.manage", "surface.manage", "voice.manage", "automation.trust", "agent.mcp.connect", "agent.template",
  ]) {
    assert.ok(!m.includes(no), `member must NOT get ${no}`);
  }
});

test("kiosk (demo visitor) never gets admin, spend-cap, connection or audit actions", () => {
  const k = ids("kiosk");
  for (const no of ["settings.keys", "settings.devices", "settings.billing", "settings.audit", "settings.danger", "budget.edit", "connector.manage", "runtime.admin", "runtime.schedule", "runtime.read", "promote.approve", "agent.template"]) {
    assert.ok(!k.includes(no), `kiosk must NOT get ${no}`);
  }
  assert.ok(k.includes("agent.run"));
});

test("actions the SERVER restricts by role are never offered below that role", () => {
  const restricted = ACTIONS.filter((x) => x.serverRole);
  assert.ok(restricted.length >= 6);
  for (const a of restricted) {
    const allowed = a.serverRole === "owner" ? ["owner"] : ["owner", "admin"];
    for (const r of ROLES) assert.equal(actionsFor(r).includes(a), allowed.includes(r), `${r} / ${a.id}`);
  }
  assert.equal(ids("admin").includes("settings.danger"), false);
  assert.equal(ids("owner").includes("settings.danger"), true);
});

test("sandbox reads follow the server: member yes, viewer/kiosk no; scheduling is owner|admin only", () => {
  assert.ok(ids("member").includes("runtime.read"));
  assert.ok(!ids("viewer").includes("runtime.read"));
  assert.ok(!ids("kiosk").includes("runtime.read"));
  assert.ok(!ids("member").includes("runtime.schedule"));
  assert.ok(ids("admin").includes("runtime.schedule"));
});

test("buildMatrix covers every role x action", () => {
  const m = buildMatrix();
  assert.deepEqual(Object.keys(m).sort(), [...ROLES].sort());
  for (const r of ROLES) assert.equal(Object.keys(m[r]).length, ACTIONS.length);
});

// Drift guard: the file that gates an action must still name its capability in
// a real gate (useCan("x"), <RoleGate cap="x">, can(role, "x"), cap: "x").
test("every gating file exists and names the capability it is supposed to gate on", () => {
  for (const a of ACTIONS) {
    const url = new URL(a.file, web);
    assert.ok(existsSync(url), `${a.id}: missing file ${a.file}`);
    const src = readFileSync(url, "utf8");
    const gate = new RegExp(`(useCan\\(\\s*|cap=|cap:\\s*|can\\([^)]*?,\\s*)["']${a.cap}["']`, "g");
    const found = (src.match(gate) ?? []).length;
    assert.ok(found >= (a.gates ?? 1), `${a.id}: ${a.file} has ${found} gate(s) on "${a.cap}", expected ${a.gates ?? 1}`);
  }
});
