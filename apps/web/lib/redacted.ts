// The control plane masks secrets in config it returns (connectors, channels,
// MCP attachments) with this value; sending it back unchanged keeps the stored
// secret. Mirrors handlers.RedactedValue (config_redact.go).
export const REDACTED = "********";

/** A field still holding the server's mask: the stored secret is kept, so
 *  length/prefix rules for a new secret do not apply. */
export const isRedacted = (v: string | undefined | null): boolean => v === REDACTED;
