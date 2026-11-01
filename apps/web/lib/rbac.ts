// Role-aware UI. The dashboard never offers an action the signed-in role
// can't exercise. Roles come from /auth/me (users.role). Pure + unit-tested.
//
// Mirrors the server's scope taxonomy (handlers/auth.go). Note the server is
// coarser today: a JWT session of ANY role passes WithScope; only owner/admin
// endpoints (billing, team, GDPR) check the role. This matrix is the intended
// product policy the UI enforces now; server-side role scoping is a tracked gap.

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
  | "settings:write"   // providers, keys, team, billing
  | "owner";           // destructive workspace actions, promotion approval

const MATRIX: Record<Role, readonly Capability[]> = {
  owner: ["agents:write", "agents:read", "budgets:read", "runs:execute", "runtime:read", "runtime:admin", "promotions:propose", "promotions:approve", "settings:write", "owner"],
  admin: ["agents:write", "agents:read", "budgets:read", "runs:execute", "runtime:read", "runtime:admin", "promotions:propose", "promotions:approve", "settings:write"],
  member: ["agents:write", "agents:read", "budgets:read", "runs:execute", "runtime:read", "promotions:propose"],
  // kioskScopes on the server: read, agents:{read,write}, runs:{read,execute}
  // (no budgets:read).
  kiosk: ["agents:write", "agents:read", "runs:execute"],
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
