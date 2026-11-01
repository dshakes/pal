package handlers

import (
	"testing"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
)

// Every value written to runs.status must map to a non-UNSPECIFIED API status,
// and the PAUSED list filter must cover every DB string that maps to PAUSED.
func TestParseRunStatus_AllDBStatuses(t *testing.T) {
	cases := []struct {
		db   string
		want palv1.RunStatus
	}{
		{"queued", palv1.RunStatus_RUN_STATUS_QUEUED},
		{"running", palv1.RunStatus_RUN_STATUS_RUNNING},
		{"paused", palv1.RunStatus_RUN_STATUS_PAUSED},
		{"waiting", palv1.RunStatus_RUN_STATUS_PAUSED},
		{"resumable", palv1.RunStatus_RUN_STATUS_PAUSED},
		{"succeeded", palv1.RunStatus_RUN_STATUS_SUCCEEDED},
		{"failed", palv1.RunStatus_RUN_STATUS_FAILED},
		{"cancelled", palv1.RunStatus_RUN_STATUS_CANCELLED},
		{"bogus", palv1.RunStatus_RUN_STATUS_UNSPECIFIED},
	}
	for _, c := range cases {
		t.Run(c.db, func(t *testing.T) {
			got := parseRunStatus(c.db)
			if got != c.want {
				t.Fatalf("parseRunStatus(%q) = %v, want %v", c.db, got, c.want)
			}
			if got == palv1.RunStatus_RUN_STATUS_UNSPECIFIED {
				return
			}
			found := false
			for _, v := range runStatusDBValues(got) {
				if v == c.db {
					found = true
				}
			}
			if !found {
				t.Errorf("runStatusDBValues(%v) = %v, missing %q", got, runStatusDBValues(got), c.db)
			}
		})
	}
}
