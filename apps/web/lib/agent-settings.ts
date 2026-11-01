// What the Settings tab may PATCH. The server (rest.go validManifestIsolation)
// accepts only "", "shared" or "microvm" for manifest.isolation and 400s
// before any write otherwise, so the UI offers exactly those.
export const ISOLATION_LEVELS = [
  { value: "shared", label: "Shared", desc: "Runs in the shared executor (default)" },
  { value: "microvm", label: "MicroVM", desc: "Full microVM sandbox (Firecracker)" },
] as const;

export type IsolationLevel = (typeof ISOLATION_LEVELS)[number]["value"];

export function isIsolationLevel(v: unknown): v is IsolationLevel {
  return ISOLATION_LEVELS.some((l) => l.value === v);
}

/** Only the fields the user actually changed; an empty patch means nothing to save. */
export function settingsPatch(
  current: { model?: string },
  edit: { model: string; isolation: string },
): { model?: string; manifest?: { isolation: IsolationLevel } } {
  const patch: { model?: string; manifest?: { isolation: IsolationLevel } } = {};
  if (edit.model && edit.model !== (current.model ?? "")) patch.model = edit.model;
  if (isIsolationLevel(edit.isolation)) patch.manifest = { isolation: edit.isolation };
  return patch;
}
