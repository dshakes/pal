// Pure logic for the debug + support agents (ADR 0059). The server proposes;
// this module decides whether the dashboard is allowed to SEND a proposal at
// all (allowlist mirrored from services/testdata/debug_action_allowlist.json,
// pinned by debug.test.mts) and whether its precondition still holds.

export type DebugKind =
  | "rollback"
  | "prompt_patch"
  | "model_change"
  | "eval_case"
  | "budget"
  | "policy"
  | "retry";

export interface DebugAction {
  method: "POST" | "PATCH" | "PUT";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

export interface DebugPrecondition {
  path: string;
  expect: Record<string, unknown>;
}

export interface DebugProposal {
  id: string;
  kind: DebugKind;
  title: string;
  rationale: string;
  citations: string[];
  risk: "low" | "medium" | "high";
  action?: DebugAction;
  precondition?: DebugPrecondition;
  href?: string;
  diff?: { field: string; before: string; after: string; hunk?: DebugHunk };
  /** What a non-diff proposal creates (eval_case: input, rubric, mocks). */
  preview?: string;
  followUp?: string;
}

/** The exact edit a prompt patch makes at byte `offset` of the current prompt. */
export interface DebugHunk {
  offset: number;
  contextBefore: string;
  removed: string;
  added: string;
  contextAfter: string;
}

/** Text that renders as nothing (controls, zero-width, bidi, Unicode TAG
 *  "smuggling", private-use) but a model still reads: never sent in a patch. */
export const HIDDEN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Co}\u{E0000}-\u{E007F}]/u;

/** A prompt patch is sendable only if the hunk shown is the WHOLE change: the
 *  shown hunk applied to the shown prompt must equal the prompt the PATCH
 *  sends. Byte offsets come from Go, so compare on UTF-8 bytes. */
export function promptPatchConsistent(p: Pick<DebugProposal, "diff" | "action">): boolean {
  const d = p.diff;
  const h = d?.hunk;
  const sent = (p.action?.body as { systemPrompt?: unknown } | undefined)?.systemPrompt;
  if (!d || !h || typeof sent !== "string" || h.offset < 0) return false;
  if (HIDDEN_TEXT.test(h.added) || HIDDEN_TEXT.test(h.removed)) return false;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const before = enc.encode(d.before);
  const removed = enc.encode(h.removed);
  if (h.offset + removed.length > before.length) return false;
  if (dec.decode(before.slice(h.offset, h.offset + removed.length)) !== h.removed) return false;
  const rebuilt = dec.decode(before.slice(0, h.offset)) + h.added + dec.decode(before.slice(h.offset + removed.length));
  return rebuilt === sent && sent === d.after;
}

export interface DebugEvidence {
  ref: string;
  label: string;
  detail?: string;
}

export interface DebugReport {
  summary: string;
  rootCause: string;
  confidence: "high" | "medium" | "low";
  grounded: boolean;
  citations: DebugEvidence[];
  proposals: DebugProposal[];
  dropped: { kind: string; reason: string }[];
  subject: { kind: string; runId?: string; incidentId?: string; agentName: string; case?: string };
  evidence: Record<string, number>;
  costUsd: number;
  requiresApproval: true;
  generatedAt: string;
}

export type DebugTarget =
  | { kind: "run"; runId: string }
  | { kind: "incident"; incidentId: string }
  | { kind: "eval_case"; case: string; agentName?: string };

export const ACTION_ALLOWLIST: { kind: DebugKind; method: string; path: RegExp }[] = [
  { kind: "rollback", method: "POST", path: /^\/v1\/agents\/[A-Za-z0-9._%-]+\/environments\/(sandbox|staging|prod)\/rollback$/ },
  { kind: "rollback", method: "POST", path: /^\/v1\/incidents\/[0-9a-fA-F-]{36}\/rollback$/ },
  { kind: "prompt_patch", method: "PATCH", path: /^\/v1\/agents\/[A-Za-z0-9._%-]+$/ },
  { kind: "model_change", method: "PATCH", path: /^\/v1\/agents\/[A-Za-z0-9._%-]+$/ },
  { kind: "eval_case", method: "POST", path: /^\/v1\/eval-suites$/ },
  { kind: "budget", method: "PUT", path: /^\/v1\/agents\/[A-Za-z0-9._%-]+\/budget$/ },
  { kind: "retry", method: "POST", path: /^\/v1\/runs$/ },
];

export const PRECONDITION_ALLOWLIST: RegExp[] = [
  /^\/v1\/agents\/[A-Za-z0-9._%-]+$/,
  /^\/v1\/agents\/[A-Za-z0-9._%-]+\/budget$/,
];

/** True only for an action of this proposal's kind inside the allowlist.
 *  A policy proposal never has a sendable action. */
export function actionAllowed(p: Pick<DebugProposal, "kind" | "action" | "precondition"> & Partial<Pick<DebugProposal, "diff">>): boolean {
  if (p.kind === "policy" || !p.action) return false;
  const a = p.action;
  const ok = ACTION_ALLOWLIST.some((x) => x.kind === p.kind && x.method === a.method && x.path.test(a.path));
  if (!ok) return false;
  if (p.kind === "prompt_patch" && !promptPatchConsistent(p as DebugProposal)) return false;
  return !p.precondition || PRECONDITION_ALLOWLIST.some((re) => re.test(p.precondition!.path));
}

function sameValue(want: unknown, got: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === null ? "" : v);
  const w = norm(want);
  const g = norm(got);
  if (typeof w === "number" || typeof g === "number") {
    const a = Number(w);
    const b = Number(g);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
  }
  return stableStringify(w) === stableStringify(g);
}

/** JSON with object keys sorted, so key order can never fake a mismatch or a match. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Checks a fresh GET of the precondition path. Missing keys read as "". */
export function preconditionHolds(
  expect: Record<string, unknown>,
  current: Record<string, unknown> | null | undefined,
): { ok: true } | { ok: false; field: string } {
  for (const [k, v] of Object.entries(expect)) {
    if (!sameValue(v, current?.[k])) return { ok: false, field: k };
  }
  return { ok: true };
}

/** Docs links: absolute only when a docs origin is configured. */
export function docsHref(path: string, base: string | undefined): string | null {
  if (!base || !path.startsWith("/docs/")) return null;
  return base.replace(/\/+$/, "") + path;
}

/** Debug target for something the Explain tab already lists. */
export function debugTargetFrom(req: { kind: string; runId?: string; case?: string; agentName?: string }): DebugTarget | null {
  if (req.kind === "run" && req.runId) return { kind: "run", runId: req.runId };
  if (req.kind === "eval_case" && req.case) return { kind: "eval_case", case: req.case, agentName: req.agentName };
  return null;
}

export function confirmLabel(kind: DebugKind): string {
  switch (kind) {
    case "rollback":
      return "Roll back";
    case "prompt_patch":
      return "Save to working copy";
    case "model_change":
      return "Switch model on working copy";
    case "eval_case":
      return "Create regression suite";
    case "budget":
      return "Raise the limit";
    case "retry":
      return "Retry the run";
    default:
      return "Apply";
  }
}

export const KIND_LABEL: Record<DebugKind, string> = {
  rollback: "Rollback",
  prompt_patch: "Prompt",
  model_change: "Model",
  eval_case: "Eval case",
  budget: "Budget",
  policy: "Policy",
  retry: "Retry",
};

/** Display form of a ref: a UUID is cut to its first 8 hex digits. */
export function shortRef(ref: string): string {
  return ref.replace(/([0-9a-fA-F]{8})-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "$1…");
}

/** Splits text on [ref] markers so cited refs can render as chips. */
export function splitRefs(text: string): { text: string; ref?: string }[] {
  const out: { text: string; ref?: string }[] = [];
  const re = /\[([a-z-]+:[^\[\]\s]{1,80})\]/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[1], ref: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export type SupportAction =
  | { kind: "debug_run"; runId: string; label?: string }
  | { kind: "debug_incident"; incidentId: string; label?: string }
  | { kind: "open"; href: string; label?: string };

export interface SupportAnswer {
  answer: string;
  citations: DebugEvidence[];
  docs: { slug: string; title: string; path: string }[];
  actions: SupportAction[];
  suggestEscalation: boolean;
  grounded: boolean;
  costUsd: number;
}

/** Client-side mirror of the server's href allowlist: same-origin dashboard paths only. */
export function safeInternalHref(href: string): boolean {
  return /^\/[a-z][a-z0-9/_-]*(\?tab=[a-z-]+)?$/i.test(href) && !href.startsWith("//") && !href.includes("..");
}
