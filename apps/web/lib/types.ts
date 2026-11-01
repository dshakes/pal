// Domain types the dashboard renders. Data comes from the API only — there is
// no sample data in apps/web (the old lib/mock-data.ts arrays are gone).

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  currentVersionId: string;
  createdAt: Date;
  labels: Record<string, string>;
  status: "active" | "archived";
  avatarUrl?: string;
  stylePrompt?: string;
  systemPrompt?: string;
  /** Head of the failover chain; empty/"auto" = default chain. */
  model?: string;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  digest: string;
  createdAt: Date;
  promoted: boolean;
}

export interface Run {
  id: string;
  tenantId: string;
  agentId: string;
  agentName: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: { code: string; message: string; stepId?: string };
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  labels: Record<string, string>;
  triggerMeta?: unknown;
  // Session-grouping keys. The runs API returns these camelCase and omits
  // them when empty (standalone run with no parent / not part of a session).
  sessionId?: string;
  parentRunId?: string;
}

export interface StreamEvent {
  runId: string;
  stepId?: string;
  seq: number;
  ts: Date;
  kind:
    | "llm_delta"
    | "llm_complete"
    | "tool_call"
    | "tool_result"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "step_waiting" // an approval pause; rewritten in place to step_completed on resume
    | "log"
    | "approval"
    | "question"
    | "end";
  data: Record<string, unknown>;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  avatarUrl?: string;
}
