package db

import (
	"fmt"
	"regexp"
	"testing"
)

// migrationName is NNNN_name.(up|down).sql, golang-migrate's convention.
var migrationName = regexp.MustCompile(`^(\d+)_[a-z0-9_]+\.(up|down)\.sql$`)

// migrationProblems reports duplicate version numbers, versions missing an up
// or down file, and malformed names.
func migrationProblems(names []string) []string {
	var problems []string
	files := map[string]map[string]string{} // version -> direction -> file
	for _, name := range names {
		m := migrationName.FindStringSubmatch(name)
		if m == nil {
			problems = append(problems, fmt.Sprintf("%s: not NNNN_name.(up|down).sql", name))
			continue
		}
		version, dir := m[1], m[2]
		if files[version] == nil {
			files[version] = map[string]string{}
		}
		if prev, dup := files[version][dir]; dup {
			problems = append(problems, fmt.Sprintf("migration version %s has two %s files: %s and %s — renumber one", version, dir, prev, name))
			continue
		}
		files[version][dir] = name
	}
	for version, dirs := range files {
		if len(dirs) != 2 {
			problems = append(problems, fmt.Sprintf("migration version %s needs both an up and a down file, has %v", version, dirs))
		}
	}
	return problems
}

// TestMigrationNumbersAreUnique fails when two migrations share a version
// number. Parallel branches each pick the "next free" number, and
// golang-migrate refuses a source with two files for one version, which would
// stop every control-plane start.
func TestMigrationNumbersAreUnique(t *testing.T) {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) < 2 {
		t.Fatalf("found %d migration files — is the embed path right?", len(names))
	}
	for _, p := range migrationProblems(names) {
		t.Error(p)
	}
}

func TestMigrationProblems_Table(t *testing.T) {
	cases := []struct {
		name  string
		files []string
		bad   bool
	}{
		{"clean", []string{"0046_a.up.sql", "0046_a.down.sql", "0047_b.up.sql", "0047_b.down.sql"}, false},
		{"two branches took 0046", []string{"0046_a.up.sql", "0046_a.down.sql", "0046_b.up.sql", "0046_b.down.sql"}, true},
		{"missing down", []string{"0046_a.up.sql"}, true},
		{"bad name", []string{"46-a.sql"}, true},
	}
	for _, tc := range cases {
		if got := len(migrationProblems(tc.files)) > 0; got != tc.bad {
			t.Errorf("%s: problems=%v, want bad=%v", tc.name, migrationProblems(tc.files), tc.bad)
		}
	}
}
