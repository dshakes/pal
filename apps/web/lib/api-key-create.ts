// Creating an API key: the key shown to the user is ONLY ever the one the
// control plane returned (it is shown once, never regenerated client-side).
// Failure keeps the user on the form with the server's reason; nothing is faked.

import { parseApiError } from "./mcp.ts";

export interface NewKeyInput {
  name: string;
  scopes: string[];
}

export type CreateKeyOutcome =
  | { kind: "created"; rawKey: string; name: string; scopes: string[]; id: string; prefix: string; createdAt: string }
  | { kind: "failed"; message: string };

/** The server's reason (e.g. the 403 for a scope the caller can't mint), not a generic "unavailable". */
export function keyErrorMessage(err: unknown): string {
  const pe = parseApiError(err);
  if (pe.status === 403) return `Not allowed: ${pe.message}`;
  return pe.message || "Request failed";
}

export async function createApiKey(
  create: (i: NewKeyInput) => Promise<{ key: { id: string; name: string; prefix: string; scopes: string[]; createdAt: string }; rawKey: string }>,
  input: NewKeyInput,
): Promise<CreateKeyOutcome> {
  try {
    const r = await create(input);
    if (!r.rawKey) return { kind: "failed", message: "The control plane returned no key." };
    return { kind: "created", rawKey: r.rawKey, name: r.key.name, scopes: r.key.scopes ?? input.scopes, id: r.key.id, prefix: r.key.prefix, createdAt: r.key.createdAt };
  } catch (err) {
    return { kind: "failed", message: keyErrorMessage(err) };
  }
}
