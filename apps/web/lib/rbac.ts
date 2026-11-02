// Role-aware UI. The dashboard never offers an action the signed-in role
// can't exercise. Roles come from /auth/me (users.role). Pure + unit-tested.
//
// This MATRIX is the single source for roles. The server enforces the same
// policy (S-4): handlers/auth.go roleScopes maps each role to scopes for every
// WithScope route, and TestRoleScopesMatchDashboardMatrix (Go) parses this
// file and fails when a capability that is also a server scope disagrees.
// The other capabilities are role checks in handlers (runtime.go
// authorizeRuntimeScope, promotion.go, gdpr.go/billing.go owner-only). The
// per-action table (with where each gate lives) is lib/rbac-matrix.ts.

export type Role = "owner" | "admin" | "member" | "viewer" | "kiosk";

export type Capability =
  | "agents:write"     // create / edit / delete agents
  | "runs:execute"     // start runs, ask the LLM (spends money)
  | "agents:read"
  | "budgets:read"
  | "runtime:read"     // list / inspect sandboxes, logs, files (server denies viewer + kiosk)
  | "runtime:admin"    // pause / resume / terminate / fork sandboxes
  | "promotions:propose" // propose a promotion / roll back (server refuses kiosk only)
  | "promotions:approve" // approve / reject: human owner or admin session only
  | "settings:write"   // providers, API keys, devices, DLP, billing, channels
  | "connectors:write" // install connectors, MCP servers + credentials
  | "budgets:write"    // spend caps
  | "write"            // the owner's personal data: held replies, automations, people, memory (server: coarse write)
  | "audit:read"       // the workspace audit log (actors + principals are visible)
  | "owner";           // workspace erase/export, billing, sandbox quota (server: owner-only checks)

const MATRIX: Record<Role, readonly Capability[]> = {
  owner: ["agents:write", "agents:read", "budgets:read", "runs:execute", "runtime:read", "runtime:admin", "promotions:propose", "promotions:approve", "settings:write", "connectors:write", "budgets:write", "write", "audit:read", "owner"],
  admin: ["agents:write", "agents:read", "budgets:read", "runs:execute", "runtime:read", "runtime:admin", "promotions:propose", "promotions:approve", "settings:write", "connectors:write", "budgets:write", "write", "audit:read"],
  member: ["agents:write", "agents:read", "budgets:read", "runs:execute", "runtime:read", "promotions:propose"],
  // kioskScopes on the server: read, agents:{read,write}, runs:{read,execute};
  // coarse read covers budgets:read.
  kiosk: ["agents:write", "agents:read", "budgets:read", "runs:execute"],
  viewer: ["agents:read", "budgets:read"],
};

/** Unknown / missing roles get the least privilege (viewer). */
export function toRole(raw: string | null | undefined): Role {
  return raw === "owner" || raw === "admin" || raw === "member" || raw === "kiosk" ? raw : "viewer";
}

export function can(role: string | null | undefined, cap: Capability): boolean {
  return MATRIX[toRole(role)].includes(cap);
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
  kiosk: "Demo visitor",
};

/** Debug/Support need runs:execute + agents:read + budgets:read and refuse kiosk
 *  (server: handlers/debug_agent.go). UI-only mirror; the server stays authoritative. */
export function canDebug(role: string | null | undefined): boolean {
  return toRole(role) !== "kiosk" && can(role, "runs:execute") && can(role, "agents:read") && can(role, "budgets:read");
}
