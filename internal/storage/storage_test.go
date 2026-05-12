package storage

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenCreatesDatabaseDirectoriesAndSchema(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := os.Stat(filepath.Join(dir, "workbench.sqlite")); err != nil {
		t.Fatalf("sqlite db missing: %v", err)
	}
	for _, name := range RequiredDirs {
		if info, err := os.Stat(filepath.Join(dir, name)); err != nil || !info.IsDir() {
			t.Fatalf("required dir %s missing: %v", name, err)
		}
	}
	if err := migrate(context.Background(), store.DB); err != nil {
		t.Fatalf("second migrate failed: %v", err)
	}
	for _, table := range []string{"repositories", "repo_sessions", "candidates", "extraction_plans", "modules", "blueprints", "agent_jobs", "spec_enrichments", "compositions", "settings"} {
		var name string
		if err := store.DB.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name); err != nil {
			t.Fatalf("table %s missing: %v", table, err)
		}
	}
	var idx string
	if err := store.DB.QueryRow(`SELECT name FROM sqlite_master WHERE type='index' AND name='agent_jobs_one_active_role_per_subject'`).Scan(&idx); err != nil {
		t.Fatalf("active job index missing: %v", err)
	}
	assertCreateSQLContains(t, store.DB, "repo_sessions", "CHECK")
	assertCreateSQLContains(t, store.DB, "candidates", "CHECK")
	assertCreateSQLContains(t, store.DB, "agent_jobs", "CHECK")
}

func assertCreateSQLContains(t *testing.T, db *sql.DB, name, want string) {
	t.Helper()
	var sqlText string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, name).Scan(&sqlText); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sqlText, want) {
		t.Fatalf("%s schema missing %q: %s", name, want, sqlText)
	}
}
