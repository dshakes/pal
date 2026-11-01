// A2A agent card (ADR 0057): pure parsing + failure mapping for the agent page.
// The control plane serves two cards: the v0.3 spec card at
// /v1/agents/{name}/a2a/.well-known/agent-card.json and the older identity card
// at /v1/agents/{name}/card (spiffeId + jwksUri). Both are untrusted JSON:
// parse, don't cast.

export interface A2aSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface A2aCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: string;
  version: string;
  provider?: { organization: string; url: string };
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  /** scheme name -> human description (only the displayable fields). */
  securitySchemes: { name: string; type: string; description: string }[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aSkill[];
  supportsAuthenticatedExtendedCard: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Returns null unless the payload has the fields the spec requires us to show. */
export function parseA2aCard(raw: unknown): A2aCard | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name);
  const url = str(raw.url);
  const protocolVersion = str(raw.protocolVersion);
  if (!name || !url || !protocolVersion) return null;
  const caps = isRecord(raw.capabilities) ? raw.capabilities : {};
  const skills: A2aSkill[] = (Array.isArray(raw.skills) ? raw.skills : []).flatMap((s) => {
    if (!isRecord(s)) return [];
    const id = str(s.id);
    if (!id) return [];
    return [{ id, name: str(s.name) ?? id, description: str(s.description) ?? "", tags: strList(s.tags) }];
  });
  const schemes = isRecord(raw.securitySchemes)
    ? Object.entries(raw.securitySchemes).flatMap(([k, v]) =>
        isRecord(v) ? [{ name: k, type: str(v.type) ?? "unknown", description: str(v.description) ?? "" }] : [],
      )
    : [];
  const prov = isRecord(raw.provider) ? raw.provider : null;
  return {
    protocolVersion,
    name,
    description: str(raw.description) ?? "",
    url,
    preferredTransport: str(raw.preferredTransport) ?? "JSONRPC",
    version: str(raw.version) ?? "",
    provider: prov && str(prov.organization) ? { organization: str(prov.organization) ?? "", url: str(prov.url) ?? "" } : undefined,
    capabilities: {
      streaming: caps.streaming === true,
      pushNotifications: caps.pushNotifications === true,
      stateTransitionHistory: caps.stateTransitionHistory === true,
    },
    securitySchemes: schemes,
    defaultInputModes: strList(raw.defaultInputModes),
    defaultOutputModes: strList(raw.defaultOutputModes),
    skills,
    supportsAuthenticatedExtendedCard: raw.supportsAuthenticatedExtendedCard === true,
  };
}

/** The identity fields of the older /card payload (public ids, never secrets). */
export function parseIdentityCard(raw: unknown): { spiffeId?: string; jwksUri?: string } {
  if (!isRecord(raw)) return {};
  return { spiffeId: str(raw.spiffeId) ?? undefined, jwksUri: str(raw.jwksUri) ?? undefined };
}

export type CardFailure =
  | { kind: "not_visible" } // 404: not yours and not public, or no such agent. Deliberately one case.
  | { kind: "needs_base_url" } // 503 public_base_url_required (prod without PAL_PUBLIC_BASE_URL)
  | { kind: "malformed" }
  | { kind: "error"; message: string };

/** Maps a failed card fetch to what the UI may say. 404 never reveals which of
 *  "missing" / "private to someone else" it was (server contract). */
export function classifyCardFailure(status: number | null, bodyCode?: string, message = "request failed"): CardFailure {
  if (status === 404) return { kind: "not_visible" };
  if (status === 503 && bodyCode === "public_base_url_required") return { kind: "needs_base_url" };
  return { kind: "error", message };
}

/** The base URL an A2A client resolves the card from (strip the well-known suffix). */
export function a2aCardPath(agentName: string): string {
  return `/v1/agents/${encodeURIComponent(agentName)}/a2a/.well-known/agent-card.json`;
}
