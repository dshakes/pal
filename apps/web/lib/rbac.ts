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
  | "runtime:admin"    // pause / resume / terminate / fork sandboxes
  | "settings:write"   // providers, keys, team, billing
  | "owner";           // destructive workspace actions, promotion approval

const MATRIX: Record<Role, readonly Capability[]> = {
  owner: ["agents:write", "runs:execute", "runtime:admin", "settings:write", "owner"],
  admin: ["agents:write", "runs:execute", "runtime:admin", "settings:write"],
  member: ["agents:write", "runs:execute"],
  // kioskScopes on the server: read, agents:{read,write}, runs:{read,execute}.
  kiosk: ["agents:write", "runs:execute"],
  viewer: [],
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
