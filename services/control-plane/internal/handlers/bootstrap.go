package handlers

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"go.uber.org/zap"
)

// First-owner bootstrap (E11). A self-host in production has sign-up closed and
// zero users, so nobody can create the first owner. There is deliberately NO new
// HTTP endpoint and NO new table: at startup, if PAL_BOOTSTRAP_OWNER_EMAIL is set
// and the instance has ZERO users, the server creates tenant + owner (password
// unusable) + free-tier defaults in one transaction and mints a purposeResetPassword
// token through the existing machinery (SHA-256 at rest, single-use, 1h TTL,
// rate-limited, constant-time by hash lookup). The owner redeems it via the
// existing POST /auth/reset to set a password. Once any user exists (durable instance_bootstrap marker,
// which survives erasure of every workspace) the path is permanently inert. The raw token goes ONLY to `out` (stderr) — never zap/OTel.

// bootstrapLockKey serialises concurrent replicas; arbitrary constant.
const bootstrapLockKey int64 = 0x50414c424f4f54

// unusablePasswordHash can never match a bcrypt comparison.
const unusablePasswordHash = "!"

// BootstrapOwner runs the one-time first-owner bootstrap. Idempotent: returns
// nil without side effects when the env is unset or any user already exists.
func (h *AuthHandler) BootstrapOwner(ctx context.Context, out io.Writer) error {
	email := strings.TrimSpace(os.Getenv("PAL_BOOTSTRAP_OWNER_EMAIL"))
	if email != "" && !validEmail(email) {
		return fmt.Errorf("PAL_BOOTSTRAP_OWNER_EMAIL %q is not a valid email", email)
	}

	// rls-exempt: bootstrap runs before any tenant exists; the instance-wide
	// user count is the gate.
	tx, err := h.srv.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("bootstrap: begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, bootstrapLockKey); err != nil {
		return fmt.Errorf("bootstrap: lock: %w", err)
	}
	// Durable marker: once set (a user was ever seen/created) bootstrap stays
	// inert even if every workspace is later erased.
	var marked bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM instance_bootstrap)`).Scan(&marked); err != nil {
		return fmt.Errorf("bootstrap: read marker: %w", err)
	}
	if marked {
		return nil
	}
	var users int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&users); err != nil {
		return fmt.Errorf("bootstrap: count users: %w", err)
	}
	if users > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO instance_bootstrap DEFAULT VALUES ON CONFLICT DO NOTHING`); err != nil {
			return fmt.Errorf("bootstrap: write marker: %w", err)
		}
		return tx.Commit(ctx) // inert forever once any user exists
	}
	if email == "" {
		if signupMode() == signupClosed {
			h.logger().Warn("no users exist and sign-up is closed: nobody can log in. " +
				"Set PAL_BOOTSTRAP_OWNER_EMAIL=<you@example.com> and restart once to create the first owner " +
				"(Helm: controlPlane.env.PAL_BOOTSTRAP_OWNER_EMAIL), or set PAL_SIGNUP_MODE=open temporarily")
		}
		return nil
	}

	name := strings.Split(email, "@")[0]
	slugSuffix, err := randomHex(4)
	if err != nil {
		return fmt.Errorf("bootstrap: slug: %w", err)
	}
	slug := name + "-" + slugSuffix
	var tenantID, userID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'personal', $3) RETURNING id
	`, slug, name+"'s Workspace", "pal-t-"+slug).Scan(&tenantID); err != nil {
		return fmt.Errorf("bootstrap: insert tenant: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject, password_hash, role, email_verified_at)
		VALUES ($1, $2, $3, 'local', $4, $5, 'owner', NULL) RETURNING id
	`, tenantID, email, name, email, unusablePasswordHash).Scan(&userID); err != nil {
		return fmt.Errorf("bootstrap: insert owner: %w", err)
	}
	if err := applyFreeTierDefaults(ctx, tx, tenantID); err != nil {
		return fmt.Errorf("bootstrap: free-tier defaults: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO instance_bootstrap DEFAULT VALUES ON CONFLICT DO NOTHING`); err != nil {
		return fmt.Errorf("bootstrap: write marker: %w", err)
	}
	token, err := insertAuthToken(ctx, tx, tenantID, userID, purposeResetPassword, resetTokenTTL)
	if err != nil {
		return fmt.Errorf("bootstrap: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("bootstrap: commit: %w", err)
	}

	h.logger().Info("bootstrap: first owner created; one-time password link written to stderr (not logged)",
		zap.String("user_id", userID), zap.String("tenant_id", tenantID))
	_, werr := fmt.Fprintf(out, "\nPAL first-owner bootstrap for %s\nSet the owner password (single use, expires in 1 hour):\n  %s\n\n",
		email, dashboardLink("/auth/reset", token))
	return werr
}
