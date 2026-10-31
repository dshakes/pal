# ADR 0058 — MCP client and server (spec revision 2025-06-18)

- Status: Accepted
- Date: 2026-10-31
- Extends: ADR 0055 (agent identity + policy), invariant #5 (untrusted code in a
  microVM), invariant #7 (tenancy), invariant #10 (secrets)
- Plan: AGENT-LIFECYCLE-PLAN Phase 3
- Migration: 0042 (0040/0041 are reserved by #408 and Phase 2 — see "Merge order")

## Context

Before this ADR PAL had an MCP *registry* (`mcp_servers`, `agent_mcp_attachments`)
but nothing ever spoke MCP: attachments were written and never read, the
catalog listed eight `npx …` stdio commands (six of them archived upstream),
and the dashboard kept a separate, fake per-agent server list in
`localStorage`. `policy.mcpServers` existed (ADR 0055) with nothing to enforce.

## Decision

### 1. Client (`internal/mcp`)

PAL implements MCP 2025-06-18 itself (no new dependency): JSON-RPC lifecycle
(`initialize` → `notifications/initialized`), `tools/list` (cursor paging,
≤256 tools, ≤20 pages) and `tools/call`. PAL declares **no client
capabilities** (no sampling / roots / elicitation), so a remote server can never
make PAL call an LLM or read files on its behalf. A server negotiating a
revision other than 2025-06-18 / 2025-03-26, or lacking the `tools` capability,
is refused.

**Streamable HTTP**: `Accept: application/json, text/event-stream`;
`Mcp-Session-Id` carried and re-initialized once on 404; `MCP-Protocol-Version`
on every post-initialize request; JSON or SSE responses (server notifications on
the stream are skipped, response id must match); `notifications/cancelled` when
the caller's context ends mid-request (never for `initialize`); 1 MiB response
cap; 60 s call / 15 s list timeouts; `DELETE` on close. The legacy HTTP+SSE
transport (2024-11-05) is not supported.

**stdio only inside a microVM (invariant #5)**: there is no host
implementation. A stdio attachment must carry `config.vmId` of a tenant-owned
sandbox VM; each call is one `RuntimeManager.Exec` that pipes
`initialize`/`initialized`/request into the server command (`/bin/sh -c`,
stdin held open, `timeout`-bounded) and stops as soon as the response line
arrives. Server stderr is never forwarded to the model.

**Network guard**: every dial is checked at connect time (DNS-rebinding safe):
link-local / cloud metadata, unspecified and multicast are always refused;
loopback and private ranges are refused in prod (`PAL_MCP_ALLOW_PRIVATE=1`
allows private ranges for customer-VPC servers; loopback never in prod); https
required in prod; no redirects; proxy env vars ignored.

### 2. Authorization (client side)

Static bearer (`PUT /v1/mcp/credentials/{slug}`) or OAuth 2.1:

1. Probe the server; a 401's `WWW-Authenticate: Bearer resource_metadata=…`
   gives the RFC 9728 document (else the well-known location, path-inserted then
   root). The metadata must name the same origin and a resource that prefixes the
   MCP URL; a cross-origin hint is refused.
2. RFC 8414 discovery of the first authorization server (OIDC fallbacks), issuer
   must match, PKCE S256 required when the server lists methods, endpoints pass
   the network guard.
3. RFC 7591 registration of a public client (or a supplied client id).
4. Authorization code + PKCE S256 + `resource` = the canonical server URI
   (RFC 8707) on both the authorization and the token request; refresh keeps the
   `resource`.
5. The redirect lands on the dashboard (`/settings/mcp/callback`), which relays
   `{code, state}` to `POST /v1/mcp/oauth/callback` **authenticated**: the
   pending row (`mcp_oauth_pending`, keyed by `sha256(state)`, 10 min, single
   use) is looked up under the caller's tenant, so a state cannot complete in
   another tenant and the callback needs no pre-auth surface.

Tokens, refresh tokens, client secrets and PKCE verifiers live only in
`internal/secrets` envelopes (`mcp_credentials.secret`,
`mcp_oauth_pending.secret`; AES-256-GCM with `PAL_CREDENTIAL_KEY`), are never
returned by the API, never logged, redacted from GDPR export, and a tenant
server whose URL changes loses its credential.

**No token passthrough**: PAL sends a server only the credential stored for
that server. The PAL caller's JWT / API key / agent token is never forwarded.

### 3. Tool loop integration and policy

Attached servers' tools join the run-executor and session tool loops as
`mcp__<slug>__<tool>` — only for a **registered agent principal** (ADR 0055;
bridge personas and the contact reply path get none). Per call:

1. `policy.mcpServers` must allow `slug` (all tools) or `slug.tool` /
   `slug.list_*` (one tool / glob) — `agentpolicy` gained the tool-level form.
2. A remote server's host must be in `policy.egressHosts`.
3. Both are audited through `AgentPrincipal.Authorize` and count toward
   `budget.maxToolCallsPerRun`.

The tool list offered to the model is pre-filtered by the same policy (no
audit); `Authorize` at dispatch is the gate. Descriptions are prefixed as
untrusted third-party text and capped (1 KiB); schemas must be bounded object
schemas; results come back as
`{untrusted_data:true, source, notice, isError, content}` (64 KiB). Each call
writes a `tool_call` journal event carrying argument **keys** and a SHA-256 of
the arguments — never values — plus status, duration and result size; the run
waterfall's `tool:` step for MCP tools is redacted the same way.

### 4. PAL as an MCP server

`POST /mcp` (Streamable HTTP, stateless: no session id, `GET`/`DELETE` → 405).
PAL is an OAuth 2.1 **resource server**:

- Bearer only. The token must be a PAL API key carrying the explicit scope
  `mcp` (or `admin`). That scope is the audience binding: unrestricted legacy
  keys, REST-only keys and dashboard session JWTs are refused with
  `401 WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
- `GET /.well-known/oauth-protected-resource[/mcp]` serves RFC 9728 metadata.
  `authorization_servers` is listed only when `PAL_MCP_AUTHORIZATION_SERVERS`
  names an external AS that mints PAL-audience tokens; PAL itself issues API
  keys, not OAuth tokens (see Consequences).
- `Origin` is validated (DNS rebinding); unsupported `MCP-Protocol-Version` →
  400; JSON-RPC batches → 400 (removed in 2025-06-18).
- Tools: `list_agents` (`agents:read`), `get_run` (`runs:read`), `run_agent` and
  one `agent_<name>` per agent labelled `mcp=expose` (`runs:execute`).
  `tools/list` shows only what the key's scopes allow and `tools/call` re-checks.
  Runs start through `RESTHandler.CreateRun` with the caller's claims, so
  budgets, spawn limits, identity and policy apply unchanged.

### 5. Registry

Tenant-registered servers (`mcp_tenant_servers`, RLS) sit beside the global
catalog; catalog slugs are reserved. Attachments point at exactly one of the
two. The catalog now says which upstream packages are maintained or archived,
GitHub's entry is GitHub's own remote server
(`https://api.githubcopilot.com/mcp/`, OAuth), and the maintained reference
servers fetch/time/git are added (stdio, VM-only). The dashboard's
`localStorage` server list is removed.

## Consequences

- PAL has no OAuth authorization server, so MCP clients that insist on OAuth
  discovery (e.g. the Inspector's interactive mode) need a configured external AS
  or a manually supplied API key. Building an AS is a separate decision.
- Merge order: golang-migrate applies only versions above the current one. If
  0042 ships before 0040/0041, a database that ran 0042 would skip them;
  merge #408 (0040) first or renumber at merge time.
- `journalDeny` (ADR 0055) never wrote: its insert compared `uuid` to `text` and
  the error was swallowed. Fixed with the shared insert here.

## Rejected

- **Running stdio servers on the host** (`npx …`): violates invariant #5.
- **Forwarding the caller's token** to MCP servers: the spec forbids token
  passthrough and it creates a confused deputy.
- **Accepting any PAL credential at `/mcp`**: a REST key is not a token issued
  for the MCP resource; the explicit `mcp` scope is the audience.
- **An SDK dependency** (Go MCP SDK): the client surface PAL needs is small, and
  the network guard, credential store and policy hooks have to wrap it anyway.
