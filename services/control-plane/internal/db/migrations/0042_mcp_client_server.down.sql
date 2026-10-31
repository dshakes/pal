DROP TABLE IF EXISTS mcp_oauth_pending;
DROP TABLE IF EXISTS mcp_credentials;
DELETE FROM agent_mcp_attachments WHERE mcp_server_id IS NULL;
DROP INDEX IF EXISTS agent_mcp_attachments_tenant_uq;
DROP INDEX IF EXISTS agent_mcp_attachments_catalog_uq;
ALTER TABLE agent_mcp_attachments DROP CONSTRAINT IF EXISTS agent_mcp_attachments_one_server;
ALTER TABLE agent_mcp_attachments DROP COLUMN IF EXISTS tenant_server_id;
ALTER TABLE agent_mcp_attachments ALTER COLUMN mcp_server_id SET NOT NULL;
ALTER TABLE agent_mcp_attachments ADD CONSTRAINT agent_mcp_attachments_pkey PRIMARY KEY (tenant_id, agent_name, mcp_server_id);
DROP TABLE IF EXISTS mcp_tenant_servers;
DELETE FROM mcp_servers WHERE slug IN ('fetch', 'time', 'git');
UPDATE mcp_servers SET transport = 'stdio', url = NULL, command = 'npx -y @modelcontextprotocol/server-github', auth_type = 'bearer',
	description = 'Query issues, PRs, code, and create comments.' WHERE slug = 'github';
UPDATE mcp_servers SET manifest = manifest - 'upstream' - 'status';
