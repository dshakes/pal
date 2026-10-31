// The agent lifecycle as the agent page presents it: design → test → evals →
// gate → promote → observe → debug, then the configuration tabs. Pure data +
// helpers (no React) so the URL contract (?tab=) is unit-tested.

export type LifecycleTab = "design" | "test" | "evals" | "gate" | "promote" | "observe" | "debug";
export type ConfigTab = "schedule" | "security" | "settings";
export type AgentTab = LifecycleTab | ConfigTab;

export interface TabDef<K extends string> {
  key: K;
  label: string;
  /** One line under the label in the rail: what this step answers. */
  hint: string;
}

export const LIFECYCLE: TabDef<LifecycleTab>[] = [
  { key: "design", label: "Design", hint: "Prompt, model, tools" },
  { key: "test", label: "Test", hint: "Talk to it" },
  { key: "evals", label: "Evals", hint: "Suites and scores" },
  { key: "gate", label: "Gate", hint: "Ready to ship?" },
  { key: "promote", label: "Promote", hint: "Sandbox → prod" },
  { key: "observe", label: "Observe", hint: "Runs and cost" },
  { key: "debug", label: "Debug", hint: "Why it failed" },
];

export const CONFIG: TabDef<ConfigTab>[] = [
  { key: "schedule", label: "Schedule", hint: "" },
  { key: "security", label: "Identity & policy", hint: "" },
  { key: "settings", label: "Settings", hint: "" },
];

const ALL = new Set<string>([...LIFECYCLE, ...CONFIG].map((t) => t.key));

/** Pre-v3 tab names still arrive in links (?tab=build, ?tab=runs, …). */
const LEGACY: Record<string, AgentTab> = { build: "design", chat: "test", runs: "observe" };

/** Resolve a ?tab= value to a tab; anything unknown lands on Design. */
export function resolveTab(raw: string | null | undefined): AgentTab {
  if (!raw) return "design";
  if (ALL.has(raw)) return raw as AgentTab;
  return LEGACY[raw] ?? "design";
}
