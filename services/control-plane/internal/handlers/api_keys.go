package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/middleware"
	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// ApiKeyHandler provides REST endpoints for managing API keys.
type ApiKeyHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewApiKeyHandler creates a new ApiKeyHandler.
func NewApiKeyHandler(srv *server.Server, auth *AuthHandler) *ApiKeyHandler {
	return &ApiKeyHandler{srv: srv, auth: auth}
}

func (h *ApiKeyHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("api_keys")
}

func (h *ApiKeyHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	return ctx, claims.TenantID, nil
}

// knownScopes is the scope taxonomy accepted on new API keys.
var knownScopes = map[Scope]bool{
	ScopeRead: true, ScopeWrite: true, ScopeAdmin: true,
	ScopeAgentsRead: true, ScopeAgentsWrite: true,
	ScopeRunsRead: true, ScopeRunsWrite: true, ScopeRunsExecute: true,
	ScopeConnectorsRead: true, ScopeConnectorsWrite: true,
	ScopeBudgetsRead: true, ScopeBudgetsWrite: true,
	ScopeSettingsRead: true, ScopeSettingsWrite: true,
	ScopeMCP: true, // ADR 0058: audience binding for the /mcp endpoint
}

// validateGrantableScopes rejects unknown scopes and any request the caller
// could not itself exercise (privilege escalation). JWT owner/admin sessions
// count as admin; other JWT roles may not mint keys. An empty request means an
// unrestricted legacy key, so it is only grantable by an unrestricted caller.
func validateGrantableScopes(c *PalClaims, requested []string) error {
	for _, s := range requested {
		if !knownScopes[Scope(s)] {
			return fmt.Errorf("unknown scope: %q", s)
		}
	}
	if c.Role != "service" {
		if c.Role != "owner" && c.Role != "admin" {
			return fmt.Errorf("only owner or admin may create API keys")
		}
		return nil
	}
	if len(c.Scopes) == 0 {
		return nil // legacy unrestricted key
	}
	if len(requested) == 0 {
		return fmt.Errorf("scopes are required: an unscoped key would exceed the caller's scopes")
	}
	for _, s := range requested {
		if !HasScope(c, Scope(s)) {
			return fmt.Errorf("cannot grant scope %q: not held by caller", s)
		}
	}
	return nil
}

// maxKeyLifetime bounds an explicit expiresAt (E6).
const maxKeyLifetime = 366 * 24 * time.Hour

// validateKeyExpiry accepts nil (no expiry) or a time in (now, now+1y].
func validateKeyExpiry(t *time.Time, now time.Time) error {
	if t == nil {
		return nil
	}
	if !t.After(now) {
		return fmt.Errorf("expiresAt must be in the future")
	}
	if t.After(now.Add(maxKeyLifetime)) {
		return fmt.Errorf("expiresAt must be within one year")
	}
	return nil
}

// apiKeyCreator is the principal recorded in api_keys.created_by: the user id
// for a session, "apikey:<id>" when another key minted this one.
func apiKeyCreator(c *PalClaims) string {
	if c.Subject != "" {
		return c.Subject
	}
	return "apikey:" + c.APIKeyID
}

// newAPIKey mints a pal_live_ key (128 random bits) and its stored prefix/hash.
func newAPIKey() (raw, prefix, hash string, err error) {
	b := make([]byte, 16)
	if _, err = rand.Read(b); err != nil {
		return "", "", "", fmt.Errorf("generate api key: %w", err)
	}
	raw = apiKeyPrefix + hex.EncodeToString(b)
	sum := sha256.Sum256([]byte(raw))
	return raw, raw[:16], hex.EncodeToString(sum[:]), nil
}

// ---------- Create API key ----------

// CreateApiKey handles POST /v1/api-keys.
// It generates a random API key, hashes it with SHA-256, stores the hash and
// prefix, and returns the full key exactly once.
func (h *ApiKeyHandler) CreateApiKey(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		Name      string     `json:"name"`
		Scopes    []string   `json:"scopes"`
		ExpiresAt *time.Time `json:"expiresAt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}

	if body.Scopes == nil {
		body.Scopes = []string{}
	}
	if err := validateGrantableScopes(claims, body.Scopes); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}

	if err := validateKeyExpiry(body.ExpiresAt, time.Now()); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	rawKey, keyPrefix, keyHash, err := newAPIKey()
	if err != nil {
		h.logger().Error("failed to generate random key", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	var id string
	var createdAt time.Time
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes, expires_at, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id, created_at
		`, tenantID, body.Name, keyHash, keyPrefix, body.Scopes, body.ExpiresAt, apiKeyCreator(claims)).Scan(&id, &createdAt)
	})
	if err != nil {
		h.logger().Error("create api key failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create API key"})
		return
	}

	// Return the full key exactly once.
	writeJSON(w, http.StatusCreated, map[string]any{
		"key": map[string]any{
			"id":        id,
			"name":      body.Name,
			"prefix":    keyPrefix,
			"scopes":    body.Scopes,
			"createdAt": createdAt,
		},
		"rawKey": rawKey,
	})
}

// ---------- List API keys ----------

// ListApiKeys handles GET /v1/api-keys.
// Returns only key prefix, never the full key or hash.
func (h *ApiKeyHandler) ListApiKeys(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	result := make([]map[string]any, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id, name, key_prefix, scopes, expires_at, last_used_at, revoked_at, created_by, created_at
			FROM api_keys
			WHERE tenant_id = $1
			ORDER BY created_at DESC
		`, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var (
				id, name, keyPrefix string
				scopes              []string
				expiresAt           *time.Time
				lastUsedAt          *time.Time
				revokedAt           *time.Time
				createdBy           *string
				createdAt           time.Time
			)
			if err := rows.Scan(&id, &name, &keyPrefix, &scopes, &expiresAt, &lastUsedAt, &revokedAt, &createdBy, &createdAt); err != nil {
				h.logger().Error("scan api key row failed", zap.Error(err))
				continue
			}

			status := "active"
			if revokedAt != nil {
				status = "revoked"
			}

			entry := map[string]any{
				"id":        id,
				"name":      name,
				"prefix":    keyPrefix,
				"scopes":    scopes,
				"status":    status,
				"createdAt": createdAt,
			}
			if expiresAt != nil {
				entry["expiresAt"] = *expiresAt
			}
			if lastUsedAt != nil {
				entry["lastUsedAt"] = *lastUsedAt
			}
			if revokedAt != nil {
				entry["revokedAt"] = *revokedAt
			}
			if createdBy != nil {
				entry["createdBy"] = *createdBy
			}
			result = append(result, entry)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list api keys failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list API keys"})
		return
	}

	writeJSON(w, http.StatusOK, result)
}

// ---------- Revoke API key ----------

// RevokeApiKey handles DELETE /v1/api-keys/{id}.
func (h *ApiKeyHandler) RevokeApiKey(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	var rowsAffected int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, execErr := tx.Exec(ctx, `
			UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
		`, id, tenantID)
		if execErr != nil {
			return execErr
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		h.logger().Error("revoke api key failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to revoke API key"})
		return
	}
	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "API key not found or already revoked"})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ---------- Validate API key (internal helper) ----------

// ValidateAPIKey looks up an API key by its raw value, returning the tenant_id
// if valid. This is used by the gateway to authenticate SDK requests.
func (h *ApiKeyHandler) ValidateAPIKey(ctx context.Context, rawKey string) (string, error) {
	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	var tenantID string
	// rls-exempt: gateway auth-resolution path. This RESOLVES the tenant from a
	// raw key hash across ALL tenants (there is no tenant context yet — this call
	// establishes it), so it must run on the privileged pool.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT tenant_id FROM api_keys
		WHERE key_hash = $1 AND revoked_at IS NULL
		AND (expires_at IS NULL OR expires_at > now())
	`, keyHash).Scan(&tenantID)
	if err != nil {
		return "", fmt.Errorf("invalid API key")
	}

	// Update last_used_at.
	// rls-exempt: same auth-resolution path, keyed by hash before tenant context exists.
	_, _ = h.srv.Pool.Exec(ctx, `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1`, keyHash)

	return tenantID, nil
}

// ---------- Rotate API key ----------

var (
	errKeyNotFound   = errors.New("API key not found or already revoked")
	errRotateExpired = errors.New("expiresAt is required: the key being rotated has already expired")
)

// RotateApiKey handles POST /v1/api-keys/{id}/rotate. The old key is revoked and
// the replacement (same name and scopes) inserted in ONE transaction, so there
// is never a window with both live or neither. The subset-scope rule applies to
// the old key's scopes. Optional body {expiresAt}; default keeps the old expiry.
func (h *ApiKeyHandler) RotateApiKey(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	var body struct {
		ExpiresAt *time.Time `json:"expiresAt"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}
	}
	now := time.Now()
	if err := validateKeyExpiry(body.ExpiresAt, now); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	rawKey, keyPrefix, keyHash, err := newAPIKey()
	if err != nil {
		h.logger().Error("rotate: generate key", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	var (
		newID, name string
		scopes      []string
		expiresAt   *time.Time
		createdAt   time.Time
	)
	var scopeErr error
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			UPDATE api_keys SET revoked_at = now()
			WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
			RETURNING name, scopes, expires_at
		`, id, tenantID).Scan(&name, &scopes, &expiresAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errKeyNotFound
			}
			return err
		}
		if scopeErr = validateGrantableScopes(claims, scopes); scopeErr != nil {
			return scopeErr // rolls back the revoke
		}
		if body.ExpiresAt != nil {
			expiresAt = body.ExpiresAt
		} else if expiresAt != nil && !expiresAt.After(now) {
			return errRotateExpired
		}
		return tx.QueryRow(ctx, `
			INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes, expires_at, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id, created_at
		`, tenantID, name, keyHash, keyPrefix, scopes, expiresAt, apiKeyCreator(claims)).Scan(&newID, &createdAt)
	})
	switch {
	case errors.Is(err, errKeyNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	case errors.Is(err, errRotateExpired):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	case scopeErr != nil:
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	case err != nil:
		h.logger().Error("rotate api key failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to rotate API key"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"key": map[string]any{
			"id": newID, "name": name, "prefix": keyPrefix, "scopes": scopes,
			"createdAt": createdAt, "expiresAt": expiresAt, "rotatedFrom": id,
		},
		"rawKey": rawKey,
	})
}
