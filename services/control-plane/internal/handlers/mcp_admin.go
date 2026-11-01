package handlers

// MCP management endpoints (ADR 0058): tenant-registered servers, stored
// credentials (static bearer or OAuth 2.1), the authorization-code flow, and a
// live tools/list for an attachment. Credentials are write-only over the API.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/mcp"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
)

const mcpOAuthPendingTTL = 10 * time.Minute

// RegisterRoutes registers the ADR 0058 MCP routes (client management and the
// PAL MCP server endpoint).
func (h *MCPHandler) RegisterRoutes(mux *http.ServeMux) {
	a := h.auth
	mux.HandleFunc("POST /v1/mcp/tenant-servers", a.WithScope(ScopeConnectorsWrite, h.CreateTenantServer))
	mux.HandleFunc("GET /v1/mcp/tenant-servers", a.WithScope(ScopeConnectorsRead, h.ListTenantServers))
	mux.HandleFunc("DELETE /v1/mcp/tenant-servers/{slug}", a.WithScope(ScopeConnectorsWrite, h.DeleteTenantServer))
	mux.HandleFunc("GET /v1/mcp/credentials", a.WithScope(ScopeConnectorsRead, h.ListCredentials))
	mux.HandleFunc("PUT /v1/mcp/credentials/{slug}", a.WithScope(ScopeConnectorsWrite, h.PutBearerCredential))
	mux.HandleFunc("DELETE /v1/mcp/credentials/{slug}", a.WithScope(ScopeConnectorsWrite, h.DeleteCredential))
	mux.HandleFunc("POST /v1/mcp/oauth/start", a.WithScope(ScopeConnectorsWrite, h.OAuthStart))
	mux.HandleFunc("POST /v1/mcp/oauth/callback", a.WithScope(ScopeConnectorsWrite, h.OAuthCallback))
	mux.HandleFunc("GET /v1/agents/{name}/mcp-servers/{slug}/tools", a.WithScope(ScopeAgentsRead, h.ListAttachmentTools))

	// PAL as an MCP server (Streamable HTTP). Auth is the OAuth 2.1 resource
	// server check inside the handler (explicit "mcp" scope).
	mux.HandleFunc("POST /mcp", h.ServeMCP)
	mux.HandleFunc("GET /mcp", h.ServeMCP)
	mux.HandleFunc("DELETE /mcp", h.ServeMCP)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", h.ProtectedResourceMetadata)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", h.ProtectedResourceMetadata)
}

func badRequest(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
}

// ---------- tenant servers ----------

type tenantServerDTO struct {
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`
	URL         string `json:"url"`
	AuthType    string `json:"authType"`
	CreatedAt   string `json:"createdAt,omitempty"`
}

// CreateTenantServer handles POST /v1/mcp/tenant-servers.
func (h *MCPHandler) CreateTenantServer(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var b tenantServerDTO
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&b); err != nil {
		badRequest(w, "invalid body")
		return
	}
	if !mcpSlugRe.MatchString(b.Slug) {
		badRequest(w, "slug must match ^[a-z0-9][a-z0-9-]{0,62}$")
		return
	}
	if b.AuthType == "" {
		b.AuthType = "none"
	}
	if b.AuthType != "none" && b.AuthType != "bearer" && b.AuthType != "oauth" {
		badRequest(w, `authType must be "none", "bearer" or "oauth"`)
		return
	}
	if strings.TrimSpace(b.Name) == "" {
		b.Name = b.Slug
	}
	if _, err := mcpDialPolicyFromEnv().CheckURL(b.URL); err != nil {
		badRequest(w, err.Error())
		return
	}
	var taken bool
	// rls-exempt: catalog slug reservation check on the global mcp_servers table.
	_ = h.srv.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM mcp_servers WHERE slug = $1)`, b.Slug).Scan(&taken)
	if taken {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "slug is reserved by the curated catalog"})
		return
	}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var oldURL string
		_ = tx.QueryRow(ctx, `SELECT url FROM mcp_tenant_servers WHERE tenant_id = $1 AND slug = $2`, tenantID, b.Slug).Scan(&oldURL)
		if _, e := tx.Exec(ctx, `INSERT INTO mcp_tenant_servers (tenant_id, slug, name, description, url, auth_type)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
			  url = EXCLUDED.url, auth_type = EXCLUDED.auth_type`,
			tenantID, b.Slug, clipString(b.Name, 120), clipString(b.Description, 500), b.URL, b.AuthType); e != nil {
			return e
		}
		if oldURL == "" || oldURL == b.URL {
			return nil
		}
		// A moved server must never receive the credential issued for the old URL.
		_, e := tx.Exec(ctx, `DELETE FROM mcp_credentials WHERE tenant_id = $1 AND server_slug = $2`, tenantID, b.Slug)
		return e
	})
	if err != nil {
		h.logger().Error("create tenant mcp server failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	activeMCP.invalidate(tenantID, b.Slug)
	writeJSON(w, http.StatusOK, b)
}

// ListTenantServers handles GET /v1/mcp/tenant-servers.
func (h *MCPHandler) ListTenantServers(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	out := []tenantServerDTO{}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT slug, name, description, url, auth_type, created_at
			FROM mcp_tenant_servers WHERE tenant_id = $1 ORDER BY slug`, tenantID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var d tenantServerDTO
			var at time.Time
			if err := rows.Scan(&d.Slug, &d.Name, &d.Description, &d.URL, &d.AuthType, &at); err != nil {
				return err
			}
			d.CreatedAt = at.UTC().Format(time.RFC3339)
			out = append(out, d)
		}
		return rows.Err()
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteTenantServer handles DELETE /v1/mcp/tenant-servers/{slug}; its
// attachments cascade and its credential is removed.
func (h *MCPHandler) DeleteTenantServer(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	slug := r.PathValue("slug")
	var n int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `DELETE FROM mcp_tenant_servers WHERE tenant_id = $1 AND slug = $2`, tenantID, slug)
		if e != nil {
			return e
		}
		n = tag.RowsAffected()
		_, e = tx.Exec(ctx, `DELETE FROM mcp_credentials WHERE tenant_id = $1 AND server_slug = $2`, tenantID, slug)
		return e
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	if n == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	activeMCP.invalidate(tenantID, slug)
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// ---------- credentials ----------

// resolveServer finds a slug in the catalog or the tenant's servers.
func (h *MCPHandler) resolveServer(ctx context.Context, tenantID, slug string) (mcpServerRef, bool, error) {
	var ref mcpServerRef
	// rls-exempt: mcp_servers is a global curated catalog (no tenant_id).
	err := h.srv.Pool.QueryRow(ctx, `SELECT slug, name, transport, COALESCE(url, ''), COALESCE(command, ''), auth_type
		FROM mcp_servers WHERE slug = $1`, slug).Scan(&ref.Slug, &ref.Name, &ref.Transport, &ref.URL, &ref.Command, &ref.AuthType)
	if err == nil {
		return ref, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ref, false, err
	}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		ref.Transport = "streamable-http"
		return tx.QueryRow(ctx, `SELECT slug, name, url, auth_type FROM mcp_tenant_servers WHERE tenant_id = $1 AND slug = $2`,
			tenantID, slug).Scan(&ref.Slug, &ref.Name, &ref.URL, &ref.AuthType)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ref, false, nil
	}
	return ref, err == nil, err
}

type credentialDTO struct {
	ServerSlug string `json:"serverSlug"`
	Kind       string `json:"kind"`
	Scope      string `json:"scope,omitempty"`
	Issuer     string `json:"issuer,omitempty"`
	ExpiresAt  string `json:"expiresAt,omitempty"`
	UpdatedAt  string `json:"updatedAt"`
}

// ListCredentials handles GET /v1/mcp/credentials — metadata only.
func (h *MCPHandler) ListCredentials(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	out := []credentialDTO{}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT server_slug, kind, scope, issuer, expires_at, updated_at
			FROM mcp_credentials WHERE tenant_id = $1 ORDER BY server_slug`, tenantID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var d credentialDTO
			var exp *time.Time
			var upd time.Time
			if err := rows.Scan(&d.ServerSlug, &d.Kind, &d.Scope, &d.Issuer, &exp, &upd); err != nil {
				return err
			}
			if exp != nil {
				d.ExpiresAt = exp.UTC().Format(time.RFC3339)
			}
			d.UpdatedAt = upd.UTC().Format(time.RFC3339)
			out = append(out, d)
		}
		return rows.Err()
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// PutBearerCredential handles PUT /v1/mcp/credentials/{slug} {token}: a
// static bearer (e.g. a GitHub PAT) issued FOR that server by its owner.
func (h *MCPHandler) PutBearerCredential(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	slug := r.PathValue("slug")
	var b struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&b); err != nil || strings.TrimSpace(b.Token) == "" {
		badRequest(w, "token is required")
		return
	}
	ref, ok, err := h.resolveServer(ctx, tenantID, slug)
	if err != nil || !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mcp server not found"})
		return
	}
	if !ref.remote() {
		badRequest(w, "stdio servers take credentials from the sandbox VM's declared secrets, not here")
		return
	}
	sealed, err := sealMCPSecret(mcpSecret{AccessToken: strings.TrimSpace(b.Token)})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "credential encryption failed"})
		return
	}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `INSERT INTO mcp_credentials (tenant_id, server_slug, kind, secret)
			VALUES ($1, $2, 'bearer', $3::jsonb)
			ON CONFLICT (tenant_id, server_slug) DO UPDATE SET kind = 'bearer', secret = EXCLUDED.secret,
			  client_id = '', issuer = '', resource = '', as_metadata = '{}'::jsonb, scope = '', expires_at = NULL,
			  version = mcp_credentials.version + 1, updated_at = now()`, tenantID, slug, sealed)
		return e
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	activeMCP.invalidate(tenantID, slug)
	writeJSON(w, http.StatusOK, map[string]string{"status": "stored", "kind": "bearer"})
}

// DeleteCredential handles DELETE /v1/mcp/credentials/{slug}.
func (h *MCPHandler) DeleteCredential(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	slug := r.PathValue("slug")
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `DELETE FROM mcp_credentials WHERE tenant_id = $1 AND server_slug = $2`, tenantID, slug)
		return e
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	activeMCP.invalidate(tenantID, slug)
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// ---------- OAuth 2.1 authorization-code flow ----------

func mcpOAuthRedirectURI() string {
	if v := strings.TrimSpace(os.Getenv("PAL_MCP_OAUTH_REDIRECT_URL")); v != "" {
		return v
	}
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("PAL_DASHBOARD_URL")), "/")
	if base == "" {
		base = "http://localhost:3001"
	}
	return base + "/settings/mcp/callback"
}

func stateHash(state string) string {
	sum := sha256.Sum256([]byte(state))
	return hex.EncodeToString(sum[:])
}

// OAuthStart handles POST /v1/mcp/oauth/start {serverSlug, scope?, clientId?, clientSecret?}.
// It probes the server for its 401 challenge, discovers the protected-resource
// and authorization-server metadata, registers PAL as a client when no client
// id is supplied, and returns the authorization URL (PKCE S256 + resource).
func (h *MCPHandler) OAuthStart(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var b struct {
		ServerSlug   string `json:"serverSlug"`
		Scope        string `json:"scope"`
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&b); err != nil {
		badRequest(w, "invalid body")
		return
	}
	ref, ok, err := h.resolveServer(ctx, tenantID, b.ServerSlug)
	if err != nil || !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mcp server not found"})
		return
	}
	if !ref.remote() {
		badRequest(w, "OAuth applies to remote (Streamable HTTP) servers only")
		return
	}
	policy := mcpDialPolicyFromEnv()
	hc := policy.NewHTTPClient(15 * time.Second)
	fail := func(status int, code, msg string) {
		writeJSON(w, status, map[string]string{"code": code, "error": msg})
	}
	// Probe: an unauthenticated initialize yields the WWW-Authenticate hint.
	hint, scope := "", b.Scope
	probe := &mcp.HTTPTransport{URL: ref.URL, HTTP: hc}
	if _, perr := probe.Call(ctx, "tools/list", nil); perr != nil {
		var ae *mcp.AuthRequiredError
		if errors.As(perr, &ae) {
			hint = ae.ResourceMetadata
			if scope == "" {
				scope = ae.Scope
			}
		}
	} else {
		_ = probe.Close(ctx)
		fail(http.StatusConflict, "no_auth_required", "the server answered without authorization")
		return
	}
	prm, err := mcp.DiscoverResource(ctx, hc, policy, ref.URL, hint)
	if err != nil {
		fail(http.StatusBadGateway, "discovery_failed", err.Error())
		return
	}
	issuer := prm.AuthorizationServers[0]
	as, err := mcp.DiscoverAuthServer(ctx, hc, policy, issuer)
	if err != nil {
		fail(http.StatusBadGateway, "discovery_failed", err.Error())
		return
	}
	redirect := mcpOAuthRedirectURI()
	clientID, clientSecret := strings.TrimSpace(b.ClientID), b.ClientSecret
	if clientID == "" {
		if clientID, clientSecret, err = mcp.RegisterClient(ctx, hc, as, redirect); err != nil {
			fail(http.StatusBadGateway, "registration_failed", err.Error())
			return
		}
	}
	resource, _ := mcp.CanonicalResource(ref.URL)
	verifier, challenge, err := mcp.NewPKCE()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "rng failure"})
		return
	}
	state, err := mcp.RandomState()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "rng failure"})
		return
	}
	sealed, err := sealMCPSecret(mcpSecret{CodeVerifier: verifier, ClientSecret: clientSecret})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "credential encryption failed"})
		return
	}
	asRaw, _ := json.Marshal(as)
	expires := time.Now().Add(mcpOAuthPendingTTL)
	createdBy := callerSubject(r)
	if createdBy == "anonymous" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `DELETE FROM mcp_oauth_pending WHERE tenant_id = $1 AND expires_at < now()`, tenantID); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `INSERT INTO mcp_oauth_pending (state_hash, tenant_id, server_slug, secret, client_id, issuer,
			resource, redirect_uri, as_metadata, scope, created_by, expires_at)
			VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
			stateHash(state), tenantID, ref.Slug, sealed, clientID, issuer, resource, redirect, asRaw, scope, createdBy, expires)
		return e
	})
	if err != nil {
		h.logger().Error("mcp oauth start: persist failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authorizationUrl": mcp.AuthorizeURL(as, clientID, redirect, state, challenge, resource, scope),
		"redirectUri":      redirect,
		"expiresAt":        expires.UTC().Format(time.RFC3339),
	})
}

// OAuthCallback handles POST /v1/mcp/oauth/callback {code, state}. The
// dashboard callback page (or `pal mcp login`) relays the redirect parameters;
// the pending row is looked up under the CALLER's tenant, so a state minted
// for one tenant can never complete in another. Single use.
func (h *MCPHandler) OAuthCallback(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var b struct {
		Code  string `json:"code"`
		State string `json:"state"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&b); err != nil || b.Code == "" || b.State == "" {
		badRequest(w, "code and state are required")
		return
	}
	var (
		slug, clientID, issuer, resource, redirect, scope string
		secRaw, asRaw                                     []byte
	)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `DELETE FROM mcp_oauth_pending
			WHERE state_hash = $1 AND tenant_id = $2 AND expires_at > now() AND created_by = $3
			RETURNING server_slug, secret, client_id, issuer, resource, redirect_uri, as_metadata, scope`,
			stateHash(b.State), tenantID, callerSubject(r)).Scan(&slug, &secRaw, &clientID, &issuer, &resource, &redirect, &asRaw, &scope)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		badRequest(w, "unknown or expired authorization state")
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	sec, err := openMCPSecret(secRaw)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	var as mcp.AuthServerMetadata
	_ = json.Unmarshal(asRaw, &as)
	policy := mcpDialPolicyFromEnv()
	if _, err := policy.CheckURL(as.TokenEndpoint); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	tok, err := mcp.ExchangeCode(ctx, policy.NewHTTPClient(15*time.Second), &as, clientID, sec.ClientSecret, b.Code, sec.CodeVerifier, redirect, resource)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"code": "token_exchange_failed", "error": err.Error()})
		return
	}
	if tok.Scope == "" {
		tok.Scope = scope
	}
	m := activeMCP
	if m == nil {
		m = &MCPRuntime{srv: h.srv}
	}
	if err := m.storeOAuthToken(ctx, tenantID, slug, clientID, sec.ClientSecret, tok, issuer, resource, asRaw); err != nil {
		h.logger().Error("mcp oauth callback: store failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	activeMCP.invalidate(tenantID, slug)
	writeJSON(w, http.StatusOK, map[string]string{"status": "connected", "serverSlug": slug})
}

// ListAttachmentTools handles GET /v1/agents/{name}/mcp-servers/{slug}/tools:
// a live tools/list against the attached server (connection test). Tools the
// agent's policy would not allow are marked, not hidden.
func (h *MCPHandler) ListAttachmentTools(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	m := activeMCP
	if m == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "MCP client not configured"})
		return
	}
	agent, slug := r.PathValue("name"), r.PathValue("slug")
	refs, err := m.loadAttachments(ctx, tenantID, agent)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed"})
		return
	}
	var ref *mcpServerRef
	for i := range refs {
		if refs[i].Slug == slug {
			ref = &refs[i]
		}
	}
	if ref == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not attached"})
		return
	}
	m.invalidate(tenantID, slug)
	tools, err := m.listTools(ctx, tenantID, *ref)
	if err != nil {
		var ae *mcp.AuthRequiredError
		if errors.As(err, &ae) || errors.Is(err, errMCPNotAuthorized) {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "authorization_required", "error": "connect this server first (pal mcp login " + slug + ")"})
			return
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"code": "mcp_error", "error": err.Error()})
		return
	}
	var pol *policyRow
	if z := currentAgentAuthz(); z != nil {
		if a, ok, _ := z.agentByName(ctx, tenantID, agent); ok {
			_ = h.srv.WithTenant(middleware.InjectTenantID(ctx, tenantID), func(tx pgx.Tx) error {
				pr, err := z.loadPolicy(ctx, tx, tenantID, a.ID)
				if err == nil {
					pol = &pr
				}
				return err
			})
		}
	}
	type toolDTO struct {
		Name        string          `json:"name"`
		ToolName    string          `json:"toolName,omitempty"`
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"inputSchema,omitempty"`
		Allowed     *bool           `json:"allowedByPolicy,omitempty"`
	}
	out := make([]toolDTO, 0, len(tools))
	for _, t := range tools {
		d := toolDTO{Name: t.Name, Description: clipString(t.Description, mcpMaxDescChars), InputSchema: t.InputSchema}
		if n, ok := mcpToolName(slug, t.Name); ok {
			d.ToolName = n
		}
		if pol != nil {
			allowed := pol.Policy.Evaluate(mcpAction(slug, t.Name)).Allowed
			d.Allowed = &allowed
		}
		out = append(out, d)
	}
	writeJSON(w, http.StatusOK, map[string]any{"server": slug, "tools": out})
}

// callerSubject is the principal an OAuth flow is bound to: "user:<id>" for a
// session, "key:<api key id>" for an API key. One key (or user) cannot finish
// another's pending flow; the tenant binding is the separate tenant_id predicate.
func callerSubject(r *http.Request) string {
	c := claimsFromCtx(r.Context())
	switch {
	case c == nil:
		return "anonymous"
	case c.APIKeyID != "":
		return "key:" + c.APIKeyID
	case c.Subject != "":
		return "user:" + c.Subject
	}
	return "anonymous"
}
