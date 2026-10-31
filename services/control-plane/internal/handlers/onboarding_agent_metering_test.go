package handlers

import (
	"context"
	"errors"
	"testing"
)

func onbUsage(t *testing.T, ctx context.Context) (tokens int64, cost float64) {
	t.Helper()
	pool := openTestPool(t)
	if err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(tokens_in+tokens_out),0), COALESCE(SUM(cost_usd),0)::float8
		FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`, recoveryTestDevTenantID, onbUsageAgent).Scan(&tokens, &cost); err != nil {
		t.Fatal(err)
	}
	return
}

// The onboarding agent's own model calls must be metered (RecordUsageSpend) and gated
// (CheckBudget) like every other internal LLM call.
func TestOnboardingAgent_ModelCallsAreMeteredAndBudgetGated(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	cleanup := func() {
		_, _ = pool.Exec(ctx, `DELETE FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = $2`, recoveryTestDevTenantID, onbUsageAgent)
		_, _ = pool.Exec(ctx, `DELETE FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`, recoveryTestDevTenantID, TenantBudgetAgent)
	}
	cleanup()
	t.Cleanup(cleanup)

	calls := 0
	raw := func(context.Context, string, string, string) (string, int64, int64, float64, error) {
		calls++
		return "hi", 1000, 500, 0.25, nil
	}
	complete := meteredOnbComplete(pool, raw)

	if text, err := complete(ctx, recoveryTestDevTenantID, "s", "u"); err != nil || text != "hi" {
		t.Fatalf("metered call: %q %v", text, err)
	}
	tok, cost := onbUsage(t, ctx)
	if tok != 1500 || cost < 0.249 || cost > 0.251 {
		t.Fatalf("usage not recorded: tokens=%d cost=%v", tok, cost)
	}

	// A hard-fail tenant cap already exceeded blocks the call before the model is reached.
	if _, err := pool.Exec(ctx, `INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail)
		VALUES ($1, $2, 0.10, true) ON CONFLICT (tenant_id, agent_name) DO UPDATE SET max_cost_usd_per_day = 0.10, hard_fail = true`,
		recoveryTestDevTenantID, TenantBudgetAgent); err != nil {
		t.Fatal(err)
	}
	before := calls
	if _, err := complete(ctx, recoveryTestDevTenantID, "s", "u"); !errors.Is(err, errOnbBudget) {
		t.Fatalf("want errOnbBudget, got %v", err)
	}
	if calls != before {
		t.Fatal("model was called despite a hard-fail budget")
	}
}
