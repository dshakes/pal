package main

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"

	"github.com/dshakes/pal/services/control-plane/internal/handlers"
)

// scopeByName resolves the Scope constant a route registration names.
var scopeByName = map[string]handlers.Scope{
	"ScopeRead": handlers.ScopeRead, "ScopeWrite": handlers.ScopeWrite, "ScopeAdmin": handlers.ScopeAdmin,
	"ScopeAgentsRead": handlers.ScopeAgentsRead, "ScopeAgentsWrite": handlers.ScopeAgentsWrite,
	"ScopeRunsRead": handlers.ScopeRunsRead, "ScopeRunsWrite": handlers.ScopeRunsWrite, "ScopeRunsExecute": handlers.ScopeRunsExecute,
	"ScopeConnectorsRead": handlers.ScopeConnectorsRead, "ScopeConnectorsWrite": handlers.ScopeConnectorsWrite,
	"ScopeBudgetsRead": handlers.ScopeBudgetsRead, "ScopeBudgetsWrite": handlers.ScopeBudgetsWrite,
	"ScopeSettingsRead": handlers.ScopeSettingsRead, "ScopeSettingsWrite": handlers.ScopeSettingsWrite,
}

var (
	ownerAdmin = []string{"owner", "admin"}
	members    = []string{"owner", "admin", "member"}
	everyone   = []string{"owner", "admin", "member", "viewer"}
)

// roleSpec is the S-5 route list (GA-GAPS S-5 / E4): which session roles may
// reach each route. Owner-only routes that the handler itself narrows are
// listed with the admin-level scope here and pinned in TestOwnerOnlyHandlers.
var roleSpec = map[string][]string{
	// owner (route lets owner|admin through; handler narrows to owner)
	"DELETE /v1/tenants/{id}":     ownerAdmin,
	"GET /v1/tenants/{id}/export": ownerAdmin,
	"POST /v1/billing/checkout":   ownerAdmin,
	"POST /v1/billing/portal":     ownerAdmin,
	// owner|admin
	"POST /v1/api-keys":                           ownerAdmin,
	"GET /v1/api-keys":                            ownerAdmin,
	"DELETE /v1/api-keys/{id}":                    ownerAdmin,
	"POST /v1/data-planes":                        ownerAdmin,
	"GET /v1/data-planes":                         ownerAdmin,
	"DELETE /v1/data-planes/{id}":                 ownerAdmin,
	"POST /v1/agents/{name}/identity/token":       ownerAdmin,
	"POST /v1/agents/{name}/identity/rotate":      ownerAdmin,
	"POST /v1/agents/{name}/identity/revoke":      ownerAdmin,
	"POST /v1/settings/llm-providers":             ownerAdmin,
	"PUT /v1/egress/dlp-policy":                   ownerAdmin,
	"POST /v1/egress/dlp-policy/rules":            ownerAdmin,
	"DELETE /v1/egress/dlp-policy/rules/{ruleId}": ownerAdmin,
	"POST /v1/surfaces":                           ownerAdmin,
	"PUT /v1/surfaces/{id}":                       ownerAdmin,
	"DELETE /v1/surfaces/{id}":                    ownerAdmin,
	"POST /v1/voice/numbers":                      ownerAdmin,
	"DELETE /v1/voice/numbers/{id}":               ownerAdmin,
	"POST /v1/bridges/enroll":                     ownerAdmin,
	"DELETE /v1/bridges/{id}":                     ownerAdmin,
	"PUT /v1/budgets/tenant":                      ownerAdmin,
	"DELETE /v1/budgets/tenant":                   ownerAdmin,
	"PUT /v1/agents/{name}/budget":                ownerAdmin,
	"PUT /v1/agents/{name}/policy":                ownerAdmin,
	"POST /v1/connectors/{connectorId}/execute":   ownerAdmin,
	"GET /v1/connectors/{connectorId}/execute":    ownerAdmin,
	"POST /v1/connectors/install":                 ownerAdmin, // tenant-wide credentials
	"DELETE /v1/connectors/{id}":                  ownerAdmin,
	"PUT /v1/mcp/credentials/{slug}":              ownerAdmin,
	"POST /v1/life-events":                        ownerAdmin, // the owner's personal data
	"POST /v1/sessions/{id}/operator-messages":    ownerAdmin,
	// member
	"POST /v1/agents":                  members,
	"DELETE /v1/agents/{name}":         members,
	"POST /v1/runs":                    members,
	"POST /v1/sessions":                members,
	"POST /v1/marketplace/{slug}/star": members,
	// viewer (and every session may revoke its own sessions)
	"POST /auth/logout":         everyone,
	"GET /v1/agents":            everyone,
	"GET /v1/runs":              everyone,
	"GET /v1/budgets":           everyone,
	"GET /v1/connectors":        everyone,
	"GET /v1/egress/dlp-policy": everyone,
}

var regLine = regexp.MustCompile(`HandleFunc\("([A-Z]+ [^"]+)",\s*[\w.]+\.WithScope(?:OrAgent)?\((?:handlers\.)?(Scope\w+),(.*)$`)

// TestRouteRolesMatchSpec resolves each S-5 route's registered scope (and any
// RequireSessionRole narrowing) and checks the roles that pass it against the
// spec, so a route can't quietly be re-scoped below its tier.
func TestRouteRolesMatchSpec(t *testing.T) {
	files := []string{"main.go"}
	more, _ := filepath.Glob("../../internal/handlers/*.go")
	files = append(files, more...)
	type reg struct {
		scope     handlers.Scope
		adminOnly bool
	}
	regs := map[string]reg{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(src), "\n") {
			m := regLine.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			s, ok := scopeByName[m[2]]
			if !ok {
				continue
			}
			regs[m[1]] = reg{scope: s, adminOnly: strings.Contains(m[3], "RequireSessionRole(handlers.AdminRoles") || strings.Contains(m[3], "RequireSessionRole(AdminRoles")}
		}
	}
	for route, want := range roleSpec {
		r, ok := regs[route]
		if !ok {
			t.Errorf("%s: no WithScope registration found", route)
			continue
		}
		var got []string
		for _, role := range everyone {
			pass := handlers.HasScope(&handlers.PalClaims{RegisteredClaims: jwt.RegisteredClaims{Subject: "u"}, Role: role}, r.scope)
			if r.adminOnly {
				pass = pass && slices.Contains(handlers.AdminRoles, role)
			}
			if pass {
				got = append(got, role)
			}
		}
		if !slices.Equal(got, want) {
			t.Errorf("%s (scope %s, adminOnly=%v): roles %v, spec %v", route, r.scope, r.adminOnly, got, want)
		}
	}
}

// TestOwnerOnlyHandlers pins the in-handler owner checks S-5 relies on.
func TestOwnerOnlyHandlers(t *testing.T) {
	want := map[string]string{
		"../../internal/handlers/gdpr.go":    `if claims.Role != "owner" {`,
		"../../internal/handlers/billing.go": "func canManageBilling(c *PalClaims) bool {\n\tswitch c.Role {\n\tcase \"owner\":\n\t\treturn true\n\tcase \"service\":",
		"../../internal/handlers/runtime.go": `if claims.Role != "service" && claims.Role != "owner" {`,
	}
	for file, needle := range want {
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), needle) {
			t.Errorf("%s: owner-only check missing: %q", file, needle)
		}
	}
	// gdpr.go guards both erase and export.
	b, _ := os.ReadFile("../../internal/handlers/gdpr.go")
	if n := strings.Count(string(b), `claims.Role != "owner"`); n < 2 {
		t.Errorf("gdpr.go: %d owner checks, want erase + export", n)
	}
}
