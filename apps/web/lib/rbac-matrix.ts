// Role x action matrix - the dashboard's RBAC audit, as data.
//
// Every control that changes something is listed once with the capability the
// UI requires and the file that gates it. lib/rbac-matrix.test.mts checks the
// matrix (who may do what) AND that each gating file still names its
// capability, so a page cannot quietly start offering an action to a role that
// can't use it.
//
// The server enforces the same policy: every WithScope route checks the
// session's role through handlers/auth.go roleScopes (kept equal to
// lib/rbac.ts by a Go test), and `serverRole` marks the routes with an extra
// explicit role check. The UI gate only decides what is OFFERED.

import { can, toRole, type Capability, type Role } from "./rbac.ts";

export interface RbacAction {
  id: string;
  label: string;
  /** Where the user meets it. */
  surface: string;
  cap: Capability;
  /** apps/web-relative file whose source must name `cap` in a gate. */
  file: string;
  /** What the control plane really checks for the same call. */
  server: string;
  /** Set when the SERVER itself restricts the call by role (not just by scope). */
  serverRole?: "owner|admin" | "owner";
  /** How many separate gates on `cap` the file must contain (default 1). */
  gates?: number;
}

const A = "app/(dashboard)";

export const ACTIONS: readonly RbacAction[] = [
  // ---- agents -----------------------------------------------------------
  { id: "agent.create", label: "Create an agent", surface: "Agents", cap: "agents:write", file: `${A}/agents/page.tsx`, server: "agents:write scope" },
  { id: "agent.create.page", label: "Open the create-agent flow", surface: "Agents / create", cap: "agents:write", file: `${A}/agents/create/page.tsx`, server: "agents:write scope" },
  { id: "agent.edit", label: "Edit settings, schedule, deploy or delete an agent", surface: "Agent detail", cap: "agents:write", file: `${A}/agents/[name]/page.tsx`, server: "agents:write (PATCH/DELETE agent, schedules, deploy) scope" },
  { id: "agent.run", label: "Chat with an agent, run it, delete a run", surface: "Agent detail", cap: "runs:execute", file: `${A}/agents/[name]/page.tsx`, server: "runs:execute (sessions, runs); spends money scope" },
  { id: "agent.design", label: "Edit the prompt and design", surface: "Agent / Design", cap: "agents:write", file: `${A}/agents/[name]/design-panel.tsx`, server: "agents:write scope" },
  { id: "agent.evals.write", label: "Edit agent evals", surface: "Agent / Eval", cap: "agents:write", file: `${A}/agents/[name]/evals-panel.tsx`, server: "agents:write scope" },
  { id: "agent.evals.run", label: "Run agent evals", surface: "Agent / Eval", cap: "runs:execute", file: `${A}/agents/[name]/evals-panel.tsx`, server: "runs:execute; spends money scope" },
  { id: "agent.security", label: "Rotate/revoke identity, edit policy", surface: "Agent / Security", cap: "settings:write", file: `${A}/agents/[name]/security-tab.tsx`, server: "agents:write + RequireSessionRole(owner|admin) on policy PUT and identity rotate/revoke", serverRole: "owner|admin" },
  { id: "agent.triggers", label: "Create, replace or delete webhook triggers", surface: "Agent / Triggers", cap: "agents:write", file: `${A}/agents/[name]/triggers/page.tsx`, server: "agents:write scope" },
  { id: "agent.editor", label: "Edit the visual workflow", surface: "Agent / Editor", cap: "agents:write", file: `${A}/agents/[name]/editor/page.tsx`, server: "agents:write (PUT workflow) scope" },
  { id: "agent.mcp.attach", label: "Attach or detach an MCP server", surface: "Agent / MCP", cap: "agents:write", file: "components/agent-mcp-section.tsx", server: "agents:write scope" },
  { id: "agent.mcp.connect", label: "Authorize an MCP server", surface: "Agent / MCP", cap: "connectors:write", file: "components/agent-mcp-section.tsx", server: "connectors:write scope" },
  { id: "agent.template", label: "Apply a one-click recipe (agent + budget)", surface: "Agents / create", cap: "budgets:write", file: "components/one-click-templates.tsx", server: "agents:write + budgets:write (recipe creates both) scope" },
  // ---- runs -------------------------------------------------------------
  { id: "run.delete", label: "Delete runs", surface: "Runs", cap: "runs:execute", file: `${A}/runs/page.tsx`, server: "runs:execute scope" },
  { id: "run.rerun", label: "Re-run from run detail", surface: "Run detail", cap: "runs:execute", file: `${A}/runs/[id]/page.tsx`, server: "runs:execute scope" },
  { id: "run.takeover", label: "Grant or release a human takeover", surface: "Run detail", cap: "runs:execute", file: "components/takeover-panel.tsx", server: "runs:write (takeover grant/release) scope" },
  // ---- quality ----------------------------------------------------------
  { id: "evalsuite.edit", label: "Create, edit, delete eval suites; pin baselines", surface: "Eval suites", cap: "agents:write", file: `${A}/eval-suites/page.tsx`, server: "agents:write (suites, baselines) scope" },
  { id: "evalsuite.run", label: "Run a suite, calibrate or generate with the LLM", surface: "Eval suites", cap: "runs:execute", file: `${A}/eval-suites/page.tsx`, server: "runs:execute; spends money scope" },
  { id: "experiment.edit", label: "Create or conclude experiments", surface: "Experiments", cap: "agents:write", file: `${A}/experiments/page.tsx`, server: "agents:write scope" },
  { id: "incident.act", label: "Acknowledge, resolve or roll back an incident", surface: "Incidents", cap: "agents:write", file: `${A}/incidents/[id]/page.tsx`, server: "agents:write (acknowledge/resolve/rollback) scope" },
  // ---- release ----------------------------------------------------------
  { id: "promote.propose", label: "Promote, roll back or evaluate a canary", surface: "Deployments", cap: "promotions:propose", file: `${A}/deployments/agent-environments.tsx`, server: "agents:write scope (member+); kiosk refused" },
  { id: "promote.approve", label: "Approve or reject a promotion", surface: "Deployments", cap: "promotions:approve", file: `${A}/deployments/agent-environments.tsx`, server: "promotion.go: human owner|admin session only; API keys and agents refused", serverRole: "owner|admin" },
  { id: "dataplane.manage", label: "Connect or disconnect a data plane", surface: "Deployments", cap: "settings:write", file: `${A}/deployments/page.tsx`, server: "admin scope: owner|admin sessions only", serverRole: "owner|admin" },
  { id: "marketplace.use", label: "Star or fork a marketplace agent", surface: "Marketplace", cap: "agents:write", file: `${A}/marketplace/page.tsx`, server: "fork + star: agents:write scope" },
  // ---- spend ------------------------------------------------------------
  { id: "budget.edit", label: "Create, edit or delete budgets", surface: "Budgets", cap: "budgets:write", file: `${A}/budgets/page.tsx`, server: "budgets:write scope" },
  // ---- sandboxes --------------------------------------------------------
  { id: "runtime.schedule", label: "Schedule a sandbox workload", surface: "Sandboxes", cap: "runtime:admin", file: `${A}/runtime/page.tsx`, server: "runtime.go authorizeRuntimeScope: Schedule needs runtime:write, held by owner|admin only (member gets read; viewer/kiosk nothing)", serverRole: "owner|admin" },
  { id: "runtime.admin", label: "Terminate, pause, resume, fork a sandbox", surface: "Sandboxes", cap: "runtime:admin", file: `${A}/runtime/[vmId]/page.tsx`, server: "runtime.go authorizeRuntimeScope: owner|admin only; member read-only", serverRole: "owner|admin" },
  { id: "runtime.read", label: "See sandboxes, logs and files", surface: "Sandboxes", cap: "runtime:read", file: `${A}/runtime/page.tsx`, server: "runtime.go authorizeRuntimeScope: read is held by owner|admin|member; viewer and kiosk are denied" },
  // ---- integrations -----------------------------------------------------
  { id: "connector.manage", label: "Install, configure or remove connectors", surface: "Connectors", cap: "connectors:write", file: `${A}/connectors/page.tsx`, server: "connectors:write scope" },
  { id: "mcp.manage", label: "Register MCP servers, set or delete credentials", surface: "Settings / MCP", cap: "connectors:write", file: `${A}/settings/mcp/page.tsx`, server: "connectors:write scope" },
  { id: "surface.manage", label: "Configure channels", surface: "Channels", cap: "settings:write", file: `${A}/surfaces/page.tsx`, server: "settings:write scope" },
  { id: "voice.manage", label: "Link or unlink voice numbers", surface: "Voice", cap: "settings:write", file: `${A}/voice/page.tsx`, server: "settings:write scope" },
  // ---- personal ---------------------------------------------------------
  { id: "brief.act", label: "Approve, edit, discard held replies; dismiss", surface: "Today", cap: "write", file: `${A}/brief/page.tsx`, server: "life-events / held replies: coarse write scope (owner|admin)" },
  { id: "automation.act", label: "Undo or mark done an automation", surface: "Automations", cap: "write", file: `${A}/automations/page.tsx`, server: "life-events undo/dismiss: coarse write scope (owner|admin)" },
  { id: "automation.trust", label: "Change automation trust modes", surface: "Automations", cap: "settings:write", file: `${A}/automations/page.tsx`, server: "life-events prefs: coarse write scope (owner|admin)" },
  // ---- settings ---------------------------------------------------------
  { id: "settings.keys", label: "Create or revoke API keys; save provider keys", surface: "Settings", cap: "settings:write", file: `${A}/settings/page.tsx`, server: "api-keys: admin scope; providers: settings:write scope (owner|admin)", serverRole: "owner|admin" },
  { id: "settings.devices", label: "Pair or revoke devices", surface: "Settings / Devices", cap: "settings:write", file: `${A}/settings/devices.tsx`, server: "settings:write scope (owner|admin); kiosk refused (bridges.go)", serverRole: "owner|admin" },
  { id: "settings.billing", label: "Change plan or open the billing portal", surface: "Settings / Billing", cap: "owner", file: "components/settings/billing-plans.tsx", server: "billing.go canManageBilling: owner session only (S-5)", serverRole: "owner" },
  { id: "settings.dlp", label: "Edit data-protection (DLP) rules", surface: "Settings / Data protection", cap: "settings:write", file: `${A}/settings/dlp/page.tsx`, server: "settings:write scope" },
  { id: "settings.sso", label: "View single sign-on setup", surface: "Settings / SSO", cap: "settings:write", file: "lib/settings-nav.ts", server: "no SSO endpoint yet (slot)" },
  { id: "settings.audit", label: "Read the audit log", surface: "Settings / Audit log", cap: "audit:read", file: "lib/settings-nav.ts", server: "promotions audit: agents:read scope; runtime audit: runtime read (owner/admin/member; not viewer/kiosk); the owner/admin limit is product policy" },
  { id: "settings.danger", label: "Export or erase the workspace", surface: "Settings / General", cap: "owner", file: `${A}/settings/page.tsx`, server: "gdpr.go: owner role check (erase + export)", serverRole: "owner" },
] as const;

export const ROLES: readonly Role[] = ["owner", "admin", "member", "viewer", "kiosk"];

/** Actions a role is offered. */
export function actionsFor(role: string | null | undefined): RbacAction[] {
  return ACTIONS.filter((a) => can(role, a.cap));
}

/** role -> action id -> offered (the full matrix, for tests and the Team reference). */
export function buildMatrix(): Record<Role, Record<string, boolean>> {
  const out = {} as Record<Role, Record<string, boolean>>;
  for (const r of ROLES) out[r] = Object.fromEntries(ACTIONS.map((a) => [a.id, can(r, a.cap)]));
  return out;
}

export const ROLE_BLURB: Record<Role, string> = {
  owner: "Everything, including erasing the workspace.",
  admin: "Everything except erasing or exporting the workspace, billing and the sandbox quota: keys, channels, connections, sandboxes, approvals.",
  member: "Builds and runs agents; cannot touch keys, billing, connections, budgets, channels, agent identity/policy or sandboxes.",
  viewer: "Read-only.",
  kiosk: "Demo visitor: builds and runs in a throwaway workspace; no admin pages.",
};

export { toRole };
