package handlers

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	"github.com/dshakes/pal/services/control-plane/internal/db"
	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// emptyDBPool returns a pool on a brand-new, migrated, user-less database so the
// "zero users" gate can be tested without disturbing the shared test DB.
func emptyDBPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping bootstrap integration test")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	suffix, _ := randomHex(5)
	name := "bootstrap_" + suffix
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+name); err != nil {
		admin.Close()
		t.Fatalf("create database: %v", err)
	}
	cfg := admin.Config().ConnConfig.Copy()
	cfg.Database = name
	pool, err := pgxpool.New(ctx, fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=disable",
		cfg.User, cfg.Password, cfg.Host, cfg.Port, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, pool, false); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+name+` WITH (FORCE)`)
		admin.Close()
	})
	return pool
}

func bootstrapHandler(pool *pgxpool.Pool) (*AuthHandler, *observer.ObservedLogs) {
	core, logs := observer.New(zap.DebugLevel)
	return NewAuthHandler(&server.Server{Pool: pool, Logger: zap.New(core)}, testJWTSecret), logs
}

func countRows(t *testing.T, pool *pgxpool.Pool, q string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), q).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestBootstrapOwner_HappyPathAndOneTimeToken(t *testing.T) {
	setSignupEnv(t, "production", "", "")
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "root@selfhost.test")
	pool := emptyDBPool(t)
	h, logs := bootstrapHandler(pool)

	var out bytes.Buffer
	if err := h.BootstrapOwner(context.Background(), &out); err != nil {
		t.Fatal(err)
	}
	m := tokenInLink.FindStringSubmatch(out.String())
	if m == nil {
		t.Fatalf("no token link in output %q", out.String())
	}
	token := m[1]

	var role, hash string
	if err := pool.QueryRow(context.Background(),
		`SELECT role, password_hash FROM users WHERE email='root@selfhost.test'`).Scan(&role, &hash); err != nil {
		t.Fatal(err)
	}
	if role != "owner" || hash != unusablePasswordHash {
		t.Fatalf("role=%q hash=%q, want owner + unusable", role, hash)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM tenants`); n != 1 {
		t.Fatalf("tenants=%d, want 1", n)
	}
	// Free-tier defaults unchanged: tenant-wide cap + runtime quota rows exist.
	if n := countRows(t, pool, `SELECT count(*) FROM agent_budgets WHERE agent_name='*'`); n != 1 {
		t.Fatalf("free-tier budget rows=%d, want 1", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM runtime_quotas`); n != 1 {
		t.Fatalf("runtime_quotas rows=%d, want 1", n)
	}

	// Hashed at rest.
	if n := countRows(t, pool, fmt.Sprintf(`SELECT count(*) FROM auth_tokens WHERE token_hash='%s'`, token)); n != 0 {
		t.Fatal("raw token stored in auth_tokens")
	}

	// Invariant #10: the token never reaches the structured logger.
	for _, e := range logs.All() {
		blob := e.Message
		for _, f := range e.Context {
			blob += " " + f.String + fmt.Sprint(f.Interface)
		}
		if strings.Contains(blob, token) {
			t.Fatalf("token leaked into log entry %q", e.Message)
		}
	}

	// The unusable password cannot log in, not even with the marker itself.
	for _, pw := range []string{"!", "anything-long-enough"} {
		rr := callJSON(h.Login, "/auth/login", map[string]string{"email": "root@selfhost.test", "password": pw})
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("login with %q before reset: %d %s", pw, rr.Code, rr.Body)
		}
	}

	// Wrong token refused; right token works once; reuse refused.
	if rr := callJSON(h.ResetPassword, "/auth/reset", map[string]string{"token": token + "x", "password": "correct-horse-battery"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("wrong token: %d", rr.Code)
	}
	if rr := callJSON(h.ResetPassword, "/auth/reset", map[string]string{"token": token, "password": "correct-horse-battery"}); rr.Code != http.StatusOK {
		t.Fatalf("redeem: %d %s", rr.Code, rr.Body)
	}
	if rr := callJSON(h.ResetPassword, "/auth/reset", map[string]string{"token": token, "password": "another-long-password"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("second use: %d, want 400", rr.Code)
	}
	if rr := callJSON(h.Login, "/auth/login", map[string]string{"email": "root@selfhost.test", "password": "correct-horse-battery"}); rr.Code != http.StatusOK {
		t.Fatalf("login after reset: %d %s", rr.Code, rr.Body)
	}
}

func TestBootstrapOwner_ExpiredTokenRefused(t *testing.T) {
	setSignupEnv(t, "production", "", "")
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "root@selfhost.test")
	pool := emptyDBPool(t)
	h, _ := bootstrapHandler(pool)
	var out bytes.Buffer
	if err := h.BootstrapOwner(context.Background(), &out); err != nil {
		t.Fatal(err)
	}
	token := tokenInLink.FindStringSubmatch(out.String())[1]
	if _, err := pool.Exec(context.Background(), `UPDATE auth_tokens SET expires_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if rr := callJSON(h.ResetPassword, "/auth/reset", map[string]string{"token": token, "password": "correct-horse-battery"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("expired token: %d, want 400", rr.Code)
	}
}

func TestBootstrapOwner_InertOnceAUserExists(t *testing.T) {
	setSignupEnv(t, "production", "", "")
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "root@selfhost.test")
	pool := emptyDBPool(t)
	h, _ := bootstrapHandler(pool)

	var first bytes.Buffer
	if err := h.BootstrapOwner(context.Background(), &first); err != nil {
		t.Fatal(err)
	}
	// Second run (restart): no-op, no output, nothing new — even with another email.
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "attacker@evil.test")
	var second bytes.Buffer
	if err := h.BootstrapOwner(context.Background(), &second); err != nil {
		t.Fatal(err)
	}
	if second.Len() != 0 {
		t.Fatalf("second run emitted output: %q", second.String())
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users`); n != 1 {
		t.Fatalf("users=%d, want 1", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM tenants`); n != 1 {
		t.Fatalf("tenants=%d, want 1", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM auth_tokens`); n != 1 {
		t.Fatalf("auth_tokens=%d, want 1", n)
	}
}

func TestBootstrapOwner_InertWithPreexistingNonOwnerUser(t *testing.T) {
	setSignupEnv(t, "production", "", "")
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "root@selfhost.test")
	pool := emptyDBPool(t)
	ctx := context.Background()
	var tid string
	if err := pool.QueryRow(ctx, `INSERT INTO tenants (slug,name,tier,k8s_namespace) VALUES ('x','x','personal','pal-t-x') RETURNING id`).Scan(&tid); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users (tenant_id,email,display_name,auth_provider,auth_subject,role) VALUES ($1,'m@x.test','m','local','m@x.test','member')`, tid); err != nil {
		t.Fatal(err)
	}
	h, _ := bootstrapHandler(pool)
	var out bytes.Buffer
	if err := h.BootstrapOwner(ctx, &out); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 || countRows(t, pool, `SELECT count(*) FROM users`) != 1 {
		t.Fatal("bootstrap ran although a user exists")
	}
}

func TestBootstrapOwner_ConcurrentReplicasCreateOneOwner(t *testing.T) {
	setSignupEnv(t, "production", "", "")
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "root@selfhost.test")
	pool := emptyDBPool(t)
	h, _ := bootstrapHandler(pool)
	var wg sync.WaitGroup
	outs := make([]bytes.Buffer, 6)
	for i := range outs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := h.BootstrapOwner(context.Background(), &outs[i]); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	emitted := 0
	for i := range outs {
		if outs[i].Len() > 0 {
			emitted++
		}
	}
	if emitted != 1 || countRows(t, pool, `SELECT count(*) FROM users`) != 1 {
		t.Fatalf("emitted=%d users=%d, want 1/1", emitted, countRows(t, pool, `SELECT count(*) FROM users`))
	}
}

func TestBootstrapOwner_InvalidEmailAndZeroUserWarning(t *testing.T) {
	pool := emptyDBPool(t)
	h, logs := bootstrapHandler(pool)

	setSignupEnv(t, "production", "", "")
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "not-an-email\r\nBcc: x@y.test")
	if err := h.BootstrapOwner(context.Background(), &bytes.Buffer{}); err == nil {
		t.Fatal("invalid email accepted")
	}

	// Prod, sign-up closed, zero users, no bootstrap env: clear instruction.
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "")
	if err := h.BootstrapOwner(context.Background(), &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if logs.FilterMessageSnippet("PAL_BOOTSTRAP_OWNER_EMAIL").Len() != 1 {
		t.Fatalf("expected one instruction warning, got %v", logs.All())
	}

	// Open sign-up: no warning.
	logs.TakeAll()
	setSignupEnv(t, "", "open", "")
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "")
	_ = h.BootstrapOwner(context.Background(), &bytes.Buffer{})
	if logs.Len() != 0 {
		t.Fatalf("unexpected log with open sign-up: %v", logs.All())
	}
}

func TestBootstrapOwner_StaysInertAfterAllWorkspacesErased(t *testing.T) {
	setSignupEnv(t, "production", "", "")
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "root@selfhost.test")
	pool := emptyDBPool(t)
	h, _ := bootstrapHandler(pool)
	ctx := context.Background()
	if err := h.BootstrapOwner(ctx, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	// GDPR-style erasure of the only workspace: users go, instance is empty again.
	if _, err := pool.Exec(ctx, `DELETE FROM tenants`); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM users`); n != 0 {
		t.Fatalf("users=%d after erase", n)
	}
	var out bytes.Buffer
	if err := h.BootstrapOwner(ctx, &out); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 || countRows(t, pool, `SELECT count(*) FROM users`) != 0 {
		t.Fatalf("bootstrap re-fired after erase: %q", out.String())
	}
}

func TestBootstrapOwner_MarksInstancesThatAlreadyHadUsers(t *testing.T) {
	setSignupEnv(t, "production", "", "")
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "")
	pool := emptyDBPool(t)
	ctx := context.Background()
	var tid string
	if err := pool.QueryRow(ctx, `INSERT INTO tenants (slug,name,tier,k8s_namespace) VALUES ('y','y','personal','pal-t-y') RETURNING id`).Scan(&tid); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users (tenant_id,email,display_name,auth_provider,auth_subject,role) VALUES ($1,'o@y.test','o','local','o@y.test','owner')`, tid); err != nil {
		t.Fatal(err)
	}
	h, _ := bootstrapHandler(pool)
	if err := h.BootstrapOwner(ctx, &bytes.Buffer{}); err != nil { // env unset, still marks
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM tenants`); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PAL_BOOTSTRAP_OWNER_EMAIL", "root@selfhost.test")
	var out bytes.Buffer
	if err := h.BootstrapOwner(ctx, &out); err != nil || out.Len() != 0 {
		t.Fatalf("err=%v out=%q: re-armed after erase", err, out.String())
	}
}
