// Pure view-model helpers for Sandboxes (microVMs). JSON shapes mirror
// services/control-plane/internal/handlers/runtime*.go; the server stays authoritative.

import type { VmState } from "./runtime-types";

/** GET /v1/runtime/vms defaults to 100 rows (max 1000) with no cursor. */
export const VM_LIST_LIMIT = 100;

export type VmTone = "ok" | "live" | "hold" | "bad" | "neutral";

export function vmTone(state: string): VmTone {
  switch (state as VmState) {
    case "running": return "live";
    case "paused": return "hold";
    case "failed": return "bad";
    case "pending":
    case "spawning":
    case "draining":
    case "terminated": return "neutral";
    default: return "neutral";
  }
}

export interface VmActions { pause: boolean; resume: boolean; fork: boolean; terminate: boolean }

/** Which lifecycle buttons make sense per state (UI affordance only; 409 is the real answer). */
export function vmActions(state: string): VmActions {
  const live = state !== "terminated" && state !== "failed";
  return {
    pause: state === "running",
    resume: state === "paused",
    fork: state === "running" || state === "paused",
    terminate: live,
  };
}

/** Server default ceiling is 100 forks per call (PAL_MAX_FORK_COUNT; the server reports its own limit on 400). */
export const FORK_MAX_DEFAULT = 100;

export function validateForkCount(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= FORK_MAX_DEFAULT ? n : null;
}

export interface ApiFailure { status: number; message: string }

/** runtime-api throws `API <status>: <body>`; the runtime handlers answer {error, reason?}. */
export function runtimeFailure(err: unknown): ApiFailure {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^API (\d+): ([\s\S]*)$/.exec(raw);
  if (!m) return { status: 0, message: raw };
  const status = Number(m[1]);
  try {
    const j = JSON.parse(m[2]) as Record<string, unknown>;
    const parts = [j.error, j.reason].filter((v): v is string => typeof v === "string" && v !== "");
    return { status, message: parts.join(": ") || m[2] };
  } catch {
    return { status, message: m[2] || raw };
  }
}

/** Plain-language copy for the lifecycle failures operators actually hit. */
export function lifecycleMessage(verb: string, err: unknown): string {
  const f = runtimeFailure(err);
  if (f.status === 402) return `${verb} blocked by the runtime quota${f.message ? ` (${f.message})` : ""}`;
  if (f.status === 409) return `${verb} isn't possible in the sandbox's current state${f.message ? ` (${f.message})` : ""}`;
  if (f.status === 403) return `${verb} needs an owner or admin`;
  return `${verb} failed: ${f.message}`;
}

/** Append a log line, keeping the newest `cap`. */
export function pushLog(lines: string[], line: string, cap = 500): string[] {
  const next = [...lines, line];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** A harness log frame → one display line; non-JSON frames pass through. */
export function formatLogFrame(data: string, now = new Date()): string {
  try {
    const j = JSON.parse(data) as { stream?: string; text?: string; at?: string };
    const at = (j.at ?? now.toISOString()).slice(11, 19);
    return `[${at}] [${j.stream || "stdout"}] ${j.text ?? ""}`;
  } catch {
    return data;
  }
}

export interface FileEntry { name: string; type: string; size?: number }

/** Join a workspace-relative path; "." is the root. Never produces "..". */
export function joinPath(dir: string, name: string): string {
  if (dir === "." || dir === "" || dir === "/") return name;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function parentPath(dir: string): string | null {
  if (dir === "." || dir === "" || dir === "/") return null;
  const i = dir.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "." : dir.slice(0, i);
}

export function isDir(e: FileEntry): boolean {
  return e.type === "dir"; // harness list_dir reports file | dir | symlink | other
}

export function fmtBytes(n?: number): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}
