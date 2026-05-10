package storage

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

var RequiredDirs = []string{"documents", "sessions", "modules", "blueprints", "jobs"}

type Store struct {
	DB      *sql.DB
	DataDir string
}

func Open(ctx context.Context, dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	for _, d := range RequiredDirs {
		if err := os.MkdirAll(filepath.Join(dataDir, d), 0o755); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", filepath.Join(dataDir, "workbench.sqlite"))
	if err != nil {
		return nil, err
	}
	if _, err := db.ExecContext(ctx, `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrate(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{DB: db, DataDir: dataDir}, nil
}

func (s *Store) Close() error {
	if s == nil || s.DB == nil {
		return nil
	}
	return s.DB.Close()
}

func migrate(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stmt := range schemaStatements {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func WithTx(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func IsNotFound(err error) bool { return errors.Is(err, sql.ErrNoRows) }

var schemaStatements = []string{
	`CREATE TABLE IF NOT EXISTS repositories (
	  id TEXT PRIMARY KEY,
	  name TEXT NOT NULL,
	  source_type TEXT NOT NULL CHECK (source_type IN ('local_path', 'git_url')),
	  source_uri TEXT NOT NULL,
	  default_branch TEXT,
	  created_at TEXT NOT NULL,
	  updated_at TEXT NOT NULL,
	  UNIQUE(source_type, source_uri)
	);`,
	`CREATE TABLE IF NOT EXISTS repo_sessions (
	  id TEXT PRIMARY KEY,
	  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	  repo_name TEXT NOT NULL,
	  checkout_path TEXT NOT NULL,
	  scratch_path TEXT NOT NULL,
	  phase TEXT NOT NULL CHECK (phase IN ('created','awaiting_user_intent','ready_for_analysis','queued','analysing','candidates_ready','awaiting_approval','extraction_planned','extracting','extracted','registered','available_in_workbench','failed_analysis','failed_extraction','needs_user_input','paused','cancelled','duplicate_detected','conflict_detected')),
	  intent_json_path TEXT,
	  candidate_report_path TEXT,
	  extraction_plan_path TEXT,
	  created_at TEXT NOT NULL,
	  updated_at TEXT NOT NULL
	);`,
	`CREATE TABLE IF NOT EXISTS candidates (
	  id TEXT PRIMARY KEY,
	  session_id TEXT NOT NULL REFERENCES repo_sessions(id) ON DELETE CASCADE,
	  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	  proposed_name TEXT NOT NULL,
	  description TEXT NOT NULL,
	  module_kind TEXT NOT NULL,
	  target_language TEXT NOT NULL DEFAULT 'go',
	  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
	  extraction_risk TEXT NOT NULL CHECK (extraction_risk IN ('low', 'medium', 'high')),
	  status TEXT NOT NULL CHECK (status IN ('proposed','modified','approved','rejected','deferred','needs_rescan','extraction_planned','extracting','extracted','duplicate_detected','merge_required','registered','available_in_workbench')),
		  source_paths_json TEXT NOT NULL,
		  reusable_rationale TEXT NOT NULL DEFAULT '',
		  coupling_notes TEXT NOT NULL DEFAULT '',
		  dependencies_json TEXT NOT NULL DEFAULT '[]',
		  side_effects_json TEXT NOT NULL DEFAULT '[]',
		  tests_found_json TEXT NOT NULL DEFAULT '[]',
		  missing_tests_json TEXT NOT NULL DEFAULT '[]',
		  ports_json TEXT NOT NULL,
	  workbench_node_json TEXT NOT NULL,
	  report_path TEXT NOT NULL,
	  user_reason TEXT,
	  approved_at TEXT,
	  created_at TEXT NOT NULL,
	  updated_at TEXT NOT NULL
	);`,
	`CREATE TABLE IF NOT EXISTS extraction_plans (
	  id TEXT PRIMARY KEY,
	  session_id TEXT NOT NULL REFERENCES repo_sessions(id) ON DELETE CASCADE,
	  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
	  status TEXT NOT NULL CHECK (status IN ('draft','ready','extracting','extracted','failed','cancelled')),
	  plan_path TEXT NOT NULL,
	  approved_candidate_ids_json TEXT NOT NULL,
	  rejected_candidate_ids_json TEXT NOT NULL,
	  created_at TEXT NOT NULL,
	  updated_at TEXT NOT NULL
	);`,
	`CREATE TABLE IF NOT EXISTS modules (
	  id TEXT PRIMARY KEY,
	  name TEXT NOT NULL,
	  version TEXT NOT NULL,
	  source_repository_id TEXT NOT NULL REFERENCES repositories(id),
	  source_session_id TEXT NOT NULL REFERENCES repo_sessions(id),
	  source_candidate_id TEXT NOT NULL REFERENCES candidates(id),
	  language TEXT NOT NULL,
	  module_kind TEXT NOT NULL,
	  import_path TEXT NOT NULL,
	  capabilities_json TEXT NOT NULL,
	  ports_json TEXT NOT NULL,
	  config_schema_path TEXT NOT NULL,
	  manifest_path TEXT NOT NULL,
	  docs_path TEXT NOT NULL,
	  examples_path TEXT,
	  test_status TEXT NOT NULL CHECK (test_status IN ('not_run','passing','failing')),
	  available_in_workbench INTEGER NOT NULL DEFAULT 0 CHECK (available_in_workbench IN (0, 1)),
	  created_at TEXT NOT NULL,
	  updated_at TEXT NOT NULL,
	  UNIQUE(name, version)
	);`,
	`CREATE TABLE IF NOT EXISTS blueprints (
	  id TEXT PRIMARY KEY,
	  name TEXT NOT NULL,
	  semantic_document_path TEXT NOT NULL,
	  flow_layout_path TEXT NOT NULL,
	  validation_status TEXT NOT NULL CHECK (validation_status IN ('not_run','valid','invalid')),
	  validation_report_path TEXT,
	  target_language TEXT NOT NULL DEFAULT 'go',
	  output_kind TEXT NOT NULL CHECK (output_kind IN ('service','cli','daemon','worker','library')),
	  package_name TEXT NOT NULL,
	  created_at TEXT NOT NULL,
	  updated_at TEXT NOT NULL
	);`,
	`CREATE TABLE IF NOT EXISTS agent_jobs (
	  id TEXT PRIMARY KEY,
	  role TEXT NOT NULL CHECK (role IN ('repo_analysis','extraction','module_test','registry_comparison','documentation','blueprint_validation','wiring')),
	  provider TEXT NOT NULL,
	  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
	  subject_type TEXT NOT NULL CHECK (subject_type IN ('session','candidate','extraction_plan','module','blueprint')),
	  subject_id TEXT NOT NULL,
	  tmux_session_name TEXT,
	  prompt_path TEXT NOT NULL,
	  transcript_path TEXT,
	  output_artifact_path TEXT,
	  timeout_seconds INTEGER NOT NULL,
	  last_heartbeat_at TEXT,
	  exit_code INTEGER,
	  error_code TEXT,
	  created_at TEXT NOT NULL,
	  started_at TEXT,
	  finished_at TEXT
	);`,
	`CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_one_active_role_per_subject ON agent_jobs(role, subject_type, subject_id) WHERE status IN ('queued', 'running');`,
	`CREATE TABLE IF NOT EXISTS settings (
	  key TEXT PRIMARY KEY,
	  value_json TEXT NOT NULL,
	  updated_at TEXT NOT NULL
	);`,
}
