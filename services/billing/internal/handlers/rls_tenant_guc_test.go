package handlers

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// setRLSTenantID binds the tenant id as a parameter: an injection payload is
// stored as an inert GUC value and no stacked statement runs. Needs
// DATABASE_URL; skipped without it.
func TestSetRLSTenantID_InjectionInert(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("needs DATABASE_URL")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	_, _ = conn.Exec(ctx, `DROP TABLE IF EXISTS guc_injection_pwned`)

	payload := "x'; CREATE TABLE guc_injection_pwned(); --"
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := setRLSTenantID(ctx, tx, payload); err != nil {
		t.Fatalf("setRLSTenantID: %v", err)
	}
	var got string
	if err := tx.QueryRow(ctx, `SELECT current_setting('app.tenant_id')`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Fatalf("GUC = %q, want the literal payload", got)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var exists bool
	if err := conn.QueryRow(ctx, `SELECT to_regclass('guc_injection_pwned') IS NOT NULL`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		_, _ = conn.Exec(ctx, `DROP TABLE guc_injection_pwned`)
		t.Fatal("stacked statement executed: injection")
	}
	// SET LOCAL semantics: gone after the transaction.
	if err := conn.QueryRow(ctx, `SELECT coalesce(current_setting('app.tenant_id', true), '')`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("GUC leaked past the transaction: %q", got)
	}
}
