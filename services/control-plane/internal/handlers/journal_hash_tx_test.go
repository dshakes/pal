package handlers

import (
	"context"
	"testing"
)

// The escalation path hashes the journal on its own tenant tx (no second pool
// connection); the bytes must equal the receipt's pool-based hash.
func TestHashJournalOnTxMatchesReceiptHash(t *testing.T) {
	s := newDebugScenario(t)
	ctx := context.Background()
	if _, err := s.f.e.superPool.Exec(ctx, `INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload) VALUES ($1,90,'step_failed','h',1,'{"a":"b|c"}')`, s.failedRun); err != nil {
		t.Fatal(err)
	}
	want, err := (&ReceiptHandler{srv: s.f.e.srv}).hashJournal(ctx, s.failedRun)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.f.e.superPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	got, err := hashJournalOn(ctx, tx, s.failedRun)
	if err != nil {
		t.Fatal(err)
	}
	empty, _ := hashJournalOn(ctx, tx, "00000000-0000-0000-0000-0000000000ff")
	if got != want || got == empty {
		t.Fatalf("tx hash %s != receipt hash %s (empty %s)", got, want, empty)
	}
}
