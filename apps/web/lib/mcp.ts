// Pure helpers for the MCP UI (agent attachments + Settings → MCP).

export interface ParsedApiError {
  status: number | null;
  code?: string;
  message: string;
}

/** PalAPI.request throws `API <status>: <body>`; recover status + {code,error|message}. */
export function parseApiError(err: unknown): ParsedApiError {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^API (\d{3}): ([\s\S]*)$/.exec(raw);
  if (!m) return { status: null, message: raw };
  const status = Number(m[1]);
  try {
    const j = JSON.parse(m[2]) as { code?: string; error?: string; message?: string };
    return { status, code: j.code, message: j.error ?? j.message ?? m[2] };
  } catch {
    return { status, message: m[2] || raw };
  }
}

export const isAuthRequired = (e: ParsedApiError) => e.status === 409 && e.code === "authorization_required";

/** Policy entry that would allow a tool: "slug" (all) or "slug.tool". */
export function policyEntry(slug: string, tool?: string): string {
  return tool ? `${slug}.${tool}` : slug;
}

export const needsVmId = (transport: string) => transport === "stdio";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** PAL's own MCP endpoint, shown to users who want to connect a client. */
export function mcpEndpoint(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}/mcp`;
}
