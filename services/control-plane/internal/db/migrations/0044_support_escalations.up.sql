-- ADR 0059: support escalations. One row per "escalate to a human": the
-- question, the subject, and a server-built context bundle (secrets redacted,
-- run input/output excluded, emails and phone numbers masked) with its SHA-256
-- digest and signature. Append-only (pal_app has no UPDATE or DELETE).

CREATE TABLE IF NOT EXISTS support_escalations (
	id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	subject_kind TEXT NOT NULL CHECK (subject_kind IN ('run','incident','none')),
	subject_id   TEXT NOT NULL DEFAULT '',
	question     TEXT NOT NULL,
	bundle       JSONB NOT NULL,
	-- The exact canonical bytes the signature covers (bundle above is the
	-- queryable copy; jsonb reorders keys, so it cannot be re-verified).
	signed_payload TEXT NOT NULL,
	digest       TEXT NOT NULL,
	signature    TEXT NOT NULL,
	algorithm    TEXT NOT NULL,
	created_by   TEXT NOT NULL,
	created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_escalations_tenant_idx
	ON support_escalations (tenant_id, created_at DESC);

ALTER TABLE support_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_escalations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON support_escalations;
CREATE POLICY tenant_isolation ON support_escalations
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON support_escalations TO pal_app;
