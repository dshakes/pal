// Pure helpers for the agent Design tab: what the saved workflow does, and
// what of it an enforcing agent policy will refuse. Unit-tested.
import type { AgentPolicy } from "./agent-policy";

export interface WorkflowSummary {
  nodes: number;
  byType: Record<string, number>;
  /** Tool names the workflow's `tool` nodes call. */
  tools: string[];
  /** Connector ids the workflow's `connector` nodes call, with their actions. */
  connectors: Record<string, string[]>;
}

type Node = { type?: unknown; data?: Record<string, unknown> };

/** Reads the editor's saved graph ({nodes, edges}); anything else is "no workflow". */
export function summarizeWorkflow(wf: unknown): WorkflowSummary | null {
  const nodes = (wf as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const byType: Record<string, number> = {};
  const tools = new Set<string>();
  const connectors: Record<string, Set<string>> = {};
  for (const n of nodes as Node[]) {
    const type = typeof n.type === "string" ? n.type : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    const d = n.data ?? {};
    if (type === "tool" && typeof d.tool === "string" && d.tool) tools.add(d.tool);
    if (type === "connector" && typeof d.connector === "string" && d.connector) {
      (connectors[d.connector] ??= new Set()).add(typeof d.action === "string" ? d.action : "");
    }
  }
  return {
    nodes: nodes.length,
    byType,
    tools: [...tools].sort(),
    connectors: Object.fromEntries(
      Object.entries(connectors).map(([k, v]) => [k, [...v].filter(Boolean).sort()]),
    ),
  };
}

/** Port of packages/agentpolicy MatchGlob: '*' matches any run of characters. */
export function matchGlob(pattern: string, s: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === s;
  const parts = pattern.split("*");
  if (!s.startsWith(parts[0])) return false;
  s = s.slice(parts[0].length);
  const last = parts[parts.length - 1];
  for (const mid of parts.slice(1, -1)) {
    const i = s.indexOf(mid);
    if (i < 0) return false;
    s = s.slice(i + mid.length);
  }
  return s.endsWith(last);
}

export interface PolicyGap {
  kind: "tool" | "connector";
  target: string;
}

/**
 * What the workflow uses that an enforcing policy does not allow — each one is
 * a step that will fail with "agent policy denied". Legacy-permissive policies
 * allow everything, so they have no gaps.
 */
export function policyGaps(s: WorkflowSummary | null, p: AgentPolicy | null): PolicyGap[] {
  if (!s || !p || p.mode !== "enforce") return [];
  const gaps: PolicyGap[] = [];
  for (const t of s.tools) if (!p.tools.some((pat) => matchGlob(pat, t))) gaps.push({ kind: "tool", target: t });
  // Mirrors the server: a connector action is allowed when some connector
  // pattern matches the id AND one of its action patterns matches the action.
  const allows = (c: string, a: string) =>
    Object.entries(p.connectors ?? {}).some(([pc, acts]) => matchGlob(pc, c) && acts.some((pa) => matchGlob(pa, a)));
  for (const [c, actions] of Object.entries(s.connectors)) {
    for (const a of actions.length ? actions : [""]) if (!allows(c, a)) gaps.push({ kind: "connector", target: a ? `${c}.${a}` : c });
  }
  return gaps;
}
