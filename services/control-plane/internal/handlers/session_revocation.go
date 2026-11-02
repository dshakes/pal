package handlers

// Revocable sessions (S-2/E5). A session JWT carries the user's
// users.token_version as its `tv` claim; validateRequest refuses a token whose
// tv is stale or whose user is gone. POST /auth/logout bumps the version, and a
// trigger (migration 0046) bumps it on any password or role change, so every
// one of those kills the user's existing tokens.
//
// Revocation window: the (user → token_version) lookup is cached in process
// for sessionCacheTTL. The replica that handled the logout drops its entry at
// once; every other replica sees the bump within sessionCacheTTL.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

const (
	// sessionCacheTTL bounds how long another replica may still honor a
	// revoked token.
	sessionCacheTTL = 60 * time.Second
	// sessionCacheMax caps the cache; past it, expired entries are swept.
	// ponytail: sweep-on-insert, an LRU only if this ever shows up in a profile.
	sessionCacheMax = 10_000

	defaultJWTTTL = 12 * time.Hour
	minJWTTTL     = 5 * time.Minute
	maxJWTTTL     = 24 * time.Hour
	// jwtTTLSlack tolerates clock jitter between mint and check.
	jwtTTLSlack = time.Minute
)

var errSessionRevoked = errors.New("session revoked")

// jwtTTL is the session lifetime: PAL_JWT_TTL (Go duration, 5m..24h), default
// 12h. An invalid value is refused at startup by CheckJWTTTL; this falls back
// to the default so a test that skips the guard still gets a sane TTL.
func jwtTTL() time.Duration {
	d, err := parseJWTTTL(os.Getenv("PAL_JWT_TTL"))
	if err != nil {
		return defaultJWTTTL
	}
	return d
}

func parseJWTTTL(v string) (time.Duration, error) {
	if v == "" {
		return defaultJWTTTL, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("PAL_JWT_TTL=%q is not a duration (e.g. 12h): %w", v, err)
	}
	if d < minJWTTTL || d > maxJWTTTL {
		return 0, fmt.Errorf("PAL_JWT_TTL=%s is outside %s..%s", d, minJWTTTL, maxJWTTTL)
	}
	return d, nil
}

// CheckJWTTTL is the startup guard for PAL_JWT_TTL.
func CheckJWTTTL() error {
	_, err := parseJWTTTL(os.Getenv("PAL_JWT_TTL"))
	return err
}

type sessionEntry struct {
	tv int
	at time.Time
}

// sessionCache maps user id → token_version. Lives on the AuthHandler (not a
// package var) so two handlers over two databases never share entries.
type sessionCache struct {
	mu sync.Mutex
	m  map[string]sessionEntry
}

func (c *sessionCache) get(userID string, now time.Time) (int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[userID]
	if !ok || now.Sub(e.at) >= sessionCacheTTL {
		return 0, false
	}
	return e.tv, true
}

func (c *sessionCache) put(userID string, tv int, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]sessionEntry{}
	}
	if len(c.m) >= sessionCacheMax {
		for k, e := range c.m {
			if now.Sub(e.at) >= sessionCacheTTL {
				delete(c.m, k)
			}
		}
	}
	c.m[userID] = sessionEntry{tv: tv, at: now}
}

func (c *sessionCache) drop(userIDs ...string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, id := range userIDs {
		delete(c.m, id)
	}
}

// checkSession enforces revocation for a user-session token. API-key claims
// (no Subject) are governed by api_keys.revoked_at instead.
func (h *AuthHandler) checkSession(ctx context.Context, c *PalClaims) error {
	if c.Subject == "" {
		return fmt.Errorf("session token has no subject")
	}
	now := time.Now()
	tv, ok := h.sessions.get(c.Subject, now)
	// A token newer than the cached version means the cache is stale (a bump
	// on another replica or in SQL, then a fresh login): re-read rather than
	// refuse a valid session. An OLDER token is refused straight from the
	// cache, so replaying a revoked token costs no query.
	if !ok || c.TokenVersion > tv {
		var err error
		if tv, err = tokenVersionLookup(ctx, h, c.Subject); err != nil {
			return err
		}
		h.sessions.put(c.Subject, tv, now)
	}
	if tv != c.TokenVersion {
		return errSessionRevoked
	}
	return nil
}

// tokenVersionLookup reads users.token_version. A missing row (user or
// workspace deleted) is errSessionRevoked. It is a var only so this package's
// tests, which mint tokens for users that do not exist, can stub it
// (TestMain); production never reassigns it.
var tokenVersionLookup = dbTokenVersion

func dbTokenVersion(ctx context.Context, h *AuthHandler, userID string) (int, error) {
	var tv int
	// rls-exempt: authentication / minting — the caller's own user row by the
	// id in a signature-verified token, before any tenant context exists.
	err := h.srv.Pool.QueryRow(ctx, `SELECT token_version FROM users WHERE id = $1`, userID).Scan(&tv)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, errSessionRevoked
	}
	if err != nil {
		return 0, fmt.Errorf("read token_version for user %s: %w", userID, err)
	}
	return tv, nil
}

// currentTokenVersion is read when minting, so a new token outlives the
// revocations that came before it.
func (h *AuthHandler) currentTokenVersion(ctx context.Context, userID string) (int, error) {
	return tokenVersionLookup(ctx, h, userID)
}

// ForgetSessions drops cached session state so this replica refuses the
// users' tokens immediately (used after deleting users or a workspace).
func (h *AuthHandler) ForgetSessions(userIDs ...string) { h.sessions.drop(userIDs...) }

// Logout handles POST /auth/logout: it revokes every session the caller holds
// (all devices), not just the presented token. API keys are revoked through
// DELETE /v1/api-keys/{id}; they cannot log out.
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	claims := claimsFromCtx(r.Context())
	if claims == nil || claims.Subject == "" || claims.Role == "service" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "logout needs a user session; revoke API keys instead"})
		return
	}
	// rls-exempt: the caller revokes its OWN sessions; the id comes from the
	// verified token, never from the request.
	if _, err := h.srv.Pool.Exec(r.Context(),
		`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, claims.Subject); err != nil {
		h.logger().Error("logout: bump token_version failed", zap.String("user_id", claims.Subject), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	h.sessions.drop(claims.Subject)
	h.logger().Info("sessions revoked by logout", zap.String("user_id", claims.Subject), zap.String("tenant_id", claims.TenantID))
	w.WriteHeader(http.StatusNoContent)
}
