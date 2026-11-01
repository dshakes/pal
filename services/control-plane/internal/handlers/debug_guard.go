package handlers

// debug_guard.go — authorization, spend and hygiene rules shared by the debug
// and support agents (ADR 0059).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dshakes/pal/services/control-plane/internal/obs"
)

const (
	// debugUsageBucket is the agent_usage_daily row the debug and support
	// agents' own model calls accrue to. It counts toward the tenant-wide cap
	// (summed over every row) and is capped on its own by
	// PAL_DEBUG_MAX_USD_PER_DAY, so a tenant with only per-agent budgets is
	// still bounded. Not the debugged agent's row: an agent blocked by its own
	// budget must remain debuggable.
	debugUsageBucket = "__pal_debug__"

	debugEvidenceBudget = 48 << 10 // bytes of evidence sent to the model
	debugJournalBudget  = 24 << 10 // of which the journal may use at most this
	debugMaxOutTokens   = 1500
	// debugUSDPerKToken is a deliberately high blended price for the spend
	// pre-check (capability "auto" may route to any model): over-estimating
	// blocks a little early, under-estimating would let spend through.
	debugUSDPerKToken = 0.02
)

// debugCallerAllowed: the debug/support agents read across scope domains (the
// agent definition, its budget, runs, incidents), so a caller must hold all of
// them. Always enforced, independent of PAL_AUTHZ_ENFORCE: a runs:execute-only
// key (e.g. a public widget key) must never read prompts or budgets this way.
// JWT users pass HasScope; kiosk sessions never do.
func debugCallerAllowed(c *PalClaims, scopes ...Scope) bool {
	if c == nil || c.Role == kioskRole {
		return false
	}
	for _, s := range scopes {
		if !HasScope(c, s) {
			return false
		}
	}
	return true
}

var debugScopes = []Scope{ScopeRunsExecute, ScopeAgentsRead, ScopeBudgetsRead}

func writeInsufficientScope(w http.ResponseWriter, need ...Scope) {
	names := make([]string, len(need))
	for i, s := range need {
		names[i] = string(s)
	}
	writeJSON(w, http.StatusForbidden, map[string]string{"code": "insufficient_scope",
		"error": "this endpoint needs " + strings.Join(names, ", ")})
}

func envInt(k string, def int) int {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	if strings.EqualFold(v, "off") {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return def
	}
	return n
}

func debugMaxUSDPerDay() float64 {
	v := strings.TrimSpace(os.Getenv("PAL_DEBUG_MAX_USD_PER_DAY"))
	if v == "" {
		return 1.0
	}
	if strings.EqualFold(v, "off") {
		return 0
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 {
		return 1.0
	}
	return f
}

// debugEstimateUSD is the pre-call spend estimate for a prompt of n characters.
func debugEstimateUSD(promptChars int) float64 {
	return float64(promptChars/4+debugMaxOutTokens) / 1000 * debugUSDPerKToken
}

// admitDebugCall applies, in order: the per-tenant hourly rate limit (Redis,
// fails open like every auth limiter), the tenant-wide hard cap with a real
// estimate, and the debug agents' own daily cap. It writes the refusal and
// returns false when the call must not happen.
func admitDebugCall(ctx context.Context, w http.ResponseWriter, auth *AuthHandler, pool *pgxpool.Pool, tenantID, route string, promptChars int) bool {
	if limit := envInt("PAL_DEBUG_RATE_PER_HOUR", 30); limit > 0 && auth != nil &&
		auth.authRateLimited(ctx, "debug:"+route+":"+tenantID, limit, time.Hour) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"code": "rate_limited", "error": "too many debug/support requests; try again later"})
		return false
	}
	est := debugEstimateUSD(promptChars)
	if bc := CheckTenantBudget(ctx, pool, tenantID, est); !bc.Allowed && bc.HardFail {
		if bc.Unavailable {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "budget check unavailable; retry shortly"})
			return false
		}
		writeJSON(w, http.StatusPaymentRequired, map[string]string{"error": "budget exceeded: " + bc.Reason, "code": "budget_exceeded"})
		return false
	}
	if capUSD := debugMaxUSDPerDay(); capUSD > 0 {
		var spent float64
		// rls-exempt: self-scoped by the authenticated tenant id (same as CheckTenantBudget).
		err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(cost_usd),0)::float8 FROM agent_usage_daily
			WHERE tenant_id = $1 AND agent_name = $2 AND usage_date = $3`, tenantID, debugUsageBucket, usageDate(time.Now())).Scan(&spent)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "budget check unavailable; retry shortly"})
			return false
		}
		if spent+est > capUSD {
			writeJSON(w, http.StatusPaymentRequired, map[string]string{"code": "debug_budget_exceeded",
				"error": fmt.Sprintf("the debug/support agents' daily spend would reach $%.4f (limit $%.2f, PAL_DEBUG_MAX_USD_PER_DAY)", spent+est, capUSD)})
			return false
		}
	}
	return true
}

// ansiRe matches CSI/OSC escape sequences; ctrlRe the remaining C0/C1 controls
// except tab and newline. Model text and workspace text are shown in terminals.
var (
	ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]`)
	ctrlRe = regexp.MustCompile(`[\x00-\x08\x0b-\x1f\x7f\x{80}-\x{9f}]`)
)

// sanitizeText strips terminal escape sequences and control characters.
func sanitizeText(s string) string {
	return ctrlRe.ReplaceAllString(ansiRe.ReplaceAllString(s, ""), "")
}

// redactText masks secrets in workspace text BEFORE it is clipped: JSON text is
// decoded and redacted structurally, anything else by pattern (incl. secret-named
// "key":"value" pairs inside prose). Unbounded; callers clip after.
func redactText(s string) string {
	t := strings.TrimSpace(s)
	if len(t) > 1 && (t[0] == '{' || t[0] == '[') {
		var v any
		if json.Unmarshal([]byte(t), &v) == nil {
			if b, err := json.Marshal(obs.Redact(v)); err == nil {
				return obs.RedactAll(string(b))
			}
		}
	}
	return obs.RedactAll(redactSecrets(s))
}

// cleanText is the full pipeline for any free text that leaves the server:
// redact, strip controls, then bound.
func cleanText(s string, n int) string {
	return clip(sanitizeText(redactText(s)), n)
}

// fenceData is fenceUntrusted without its 8 KB eval clip: debug evidence is
// already bounded by debugEvidenceBudget, and silently cutting it would hide
// the newest events and the agent-level evidence from the model.
func fenceData(tag, nonce, s string) string {
	s = fenceLike.ReplaceAllString(s, "")
	return fmt.Sprintf("<untrusted_%s_%s>\n%s\n</untrusted_%s_%s>", tag, nonce, s, tag, nonce)
}
