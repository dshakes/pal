-- 0042: MCP client + server (ADR 0058, MCP spec 2025-06-18).
--
--   mcp_tenant_servers  tenant-registered (BYO) remote MCP servers. The global
--                       mcp_servers catalog stays RLS-exempt and tenant-free.
--   mcp_credentials     one credential per (tenant, server slug): a static
--                       bearer or an OAuth 2.1 grant. `secret` holds the token
--                       material as an internal/secrets envelope (encrypted
--                       when PAL_CREDENTIAL_KEY is set) and is never selected
--                       into an API response.
--   mcp_oauth_pending   in-flight authorization requests, keyed by
--                       sha256(state); the PKCE verifier lives in `secret`.
-- Attachments may now point at either a catalog row or a tenant server.

CREATE TABLE IF NOT EXISTS mcp_tenant_servers (
	id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	slug        TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
	name        TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	url         TEXT NOT NULL,
	auth_type   TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'oauth')),
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	UNIQUE (tenant_id, slug)
);

ALTER TABLE agent_mcp_attachments ADD COLUMN IF NOT EXISTS tenant_server_id UUID REFERENCES mcp_tenant_servers(id) ON DELETE CASCADE;
ALTER TABLE agent_mcp_attachments DROP CONSTRAINT IF EXISTS agent_mcp_attachments_pkey;
ALTER TABLE agent_mcp_attachments ALTER COLUMN mcp_server_id DROP NOT NULL;
ALTER TABLE agent_mcp_attachments DROP CONSTRAINT IF EXISTS agent_mcp_attachments_one_server;
ALTER TABLE agent_mcp_attachments ADD CONSTRAINT agent_mcp_attachments_one_server
	CHECK ((mcp_server_id IS NULL) <> (tenant_server_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS agent_mcp_attachments_catalog_uq
	ON agent_mcp_attachments (tenant_id, agent_name, mcp_server_id) WHERE mcp_server_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_mcp_attachments_tenant_uq
	ON agent_mcp_attachments (tenant_id, agent_name, tenant_server_id) WHERE tenant_server_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mcp_credentials (
	tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	server_slug  TEXT NOT NULL,
	kind         TEXT NOT NULL CHECK (kind IN ('bearer', 'oauth')),
	secret       JSONB NOT NULL,
	client_id    TEXT NOT NULL DEFAULT '',
	issuer       TEXT NOT NULL DEFAULT '',
	resource     TEXT NOT NULL DEFAULT '',
	as_metadata  JSONB NOT NULL DEFAULT '{}'::jsonb,
	scope        TEXT NOT NULL DEFAULT '',
	expires_at   TIMESTAMPTZ,
	version      INTEGER NOT NULL DEFAULT 1,
	updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (tenant_id, server_slug)
);

CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
	state_hash   TEXT PRIMARY KEY,
	tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	server_slug  TEXT NOT NULL,
	secret       JSONB NOT NULL,
	client_id    TEXT NOT NULL,
	issuer       TEXT NOT NULL,
	resource     TEXT NOT NULL,
	redirect_uri TEXT NOT NULL,
	as_metadata  JSONB NOT NULL,
	scope        TEXT NOT NULL DEFAULT '',
	created_by   TEXT NOT NULL DEFAULT '',
	expires_at   TIMESTAMPTZ NOT NULL,
	created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_oauth_pending_tenant_idx ON mcp_oauth_pending (tenant_id, expires_at);

-- Catalog: every row describes the real upstream server. Stdio servers run
-- only inside a tenant microVM. Archived upstream packages are marked so the
-- dashboard can say so instead of implying they are maintained.
UPDATE mcp_servers SET manifest = manifest || '{"upstream":"modelcontextprotocol/servers","status":"maintained"}'::jsonb
	WHERE slug IN ('filesystem', 'memory');
UPDATE mcp_servers SET manifest = manifest || '{"upstream":"modelcontextprotocol/servers-archived","status":"archived"}'::jsonb
	WHERE slug IN ('postgres', 'slack', 'brave-search', 'puppeteer', 'sqlite');
-- GitHub's own server replaced the archived reference one: remote Streamable
-- HTTP, OAuth 2.1 (or a PAT as a static bearer).
UPDATE mcp_servers SET transport = 'streamable-http', url = 'https://api.githubcopilot.com/mcp/', command = NULL,
	auth_type = 'oauth', description = 'GitHub''s official remote MCP server: issues, PRs, code search, Actions.',
	manifest = manifest || '{"upstream":"github/github-mcp-server","status":"maintained"}'::jsonb
	WHERE slug = 'github';
INSERT INTO mcp_servers (slug, name, description, category, transport, command, auth_type, official, tags, manifest) VALUES
	('fetch', 'Fetch', 'Fetch a URL and convert it to markdown. Reference server; runs in your sandbox VM.', 'research', 'stdio', 'uvx mcp-server-fetch', 'none', true, ARRAY['web','http'], '{"upstream":"modelcontextprotocol/servers","status":"maintained"}'),
	('time', 'Time', 'Current time and timezone conversion. Reference server; runs in your sandbox VM.', 'core', 'stdio', 'uvx mcp-server-time', 'none', true, ARRAY['time'], '{"upstream":"modelcontextprotocol/servers","status":"maintained"}'),
	('git', 'Git', 'Read and manipulate a git repository. Reference server; runs in your sandbox VM.', 'devtools', 'stdio', 'uvx mcp-server-git', 'none', true, ARRAY['git','code'], '{"upstream":"modelcontextprotocol/servers","status":"maintained"}')
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE mcp_tenant_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tenant_servers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp_tenant_servers;
CREATE POLICY tenant_isolation ON mcp_tenant_servers
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE mcp_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp_credentials;
CREATE POLICY tenant_isolation ON mcp_credentials
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE mcp_oauth_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_pending FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp_oauth_pending;
CREATE POLICY tenant_isolation ON mcp_oauth_pending
	USING (tenant_id::text = current_setting('app.tenant_id', true))
	WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_tenant_servers TO pal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_credentials TO pal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_oauth_pending TO pal_app;
