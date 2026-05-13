package server

import (
	"bytes"
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"code_workbench/internal/config"
	"code_workbench/internal/logging"
	"code_workbench/internal/storage"
)

//go:embed static/dist/*
var staticFS embed.FS

type App struct {
	cfg       config.Config
	store     *storage.Store
	log       *logging.JSONL
	providers map[string]AgentProvider
	mu        sync.Mutex
	started   map[string]bool
	logPos    map[string]int64
}

type APIError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
	Status  int            `json:"-"`
}

func (e APIError) Error() string { return e.Code }

var (
	portNameRE    = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	portTypeRE    = regexp.MustCompile(`^[A-Z][A-Za-z0-9]*(<([A-Z][A-Za-z0-9]*)(,[A-Z][A-Za-z0-9]*)*>)?$`)
	packageNameRE = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
)

func New(ctx context.Context, cfg config.Config) (*App, error) {
	store, err := storage.Open(ctx, cfg.DataDir)
	if err != nil {
		return nil, err
	}
	logPath := filepath.Join(cfg.DataDir, "server.log")
	logw, err := logging.NewJSONL(logPath, cfg.DebugLogs)
	if err != nil {
		store.Close()
		return nil, err
	}
	logw.Event("server_log_opened", map[string]any{"path": logPath})
	app := &App{cfg: cfg, store: store, log: logw, started: map[string]bool{}, logPos: map[string]int64{}}
	app.providers = map[string]AgentProvider{
		"claude_code_tmux": NewClaudeProvider(cfg.DataDir),
	}
	if cfg.EnableFake {
		app.providers["fake"] = &FakeProvider{}
	}
	if err := app.ReconcileInterrupted(ctx); err != nil {
		app.Close()
		return nil, err
	}
	return app, nil
}

func (a *App) Close() error {
	if a.log != nil {
		_ = a.log.Close()
	}
	if a.store != nil {
		return a.store.Close()
	}
	return nil
}

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	a.routes(mux)
	return a.withLogging(mux)
}

func (a *App) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/health", a.handleHealth)
	mux.HandleFunc("GET /api/config", a.handleConfig)
	mux.HandleFunc("POST /api/repositories", a.handleCreateRepository)
	mux.HandleFunc("GET /api/repositories", a.handleListRepositories)
	mux.HandleFunc("POST /api/sessions", a.handleCreateSession)
	mux.HandleFunc("GET /api/sessions", a.handleListSessions)
	mux.HandleFunc("DELETE /api/sessions", a.handleClearSessions)
	mux.HandleFunc("GET /api/sessions/{sessionId}", a.handleGetSession)
	mux.HandleFunc("GET /api/sessions/{sessionId}/files", a.handleSessionFile)
	mux.HandleFunc("POST /api/sessions/{sessionId}/intent", a.handleSessionIntent)
	mux.HandleFunc("POST /api/sessions/{sessionId}/analysis-jobs", a.handleAnalysisJob)
	mux.HandleFunc("GET /api/candidates", a.handleListCandidates)
	mux.HandleFunc("PATCH /api/candidates/{candidateId}", a.handlePatchCandidate)
	mux.HandleFunc("POST /api/candidates/{candidateId}/approve", a.handleCandidateAction("approved"))
	mux.HandleFunc("POST /api/candidates/{candidateId}/reject", a.handleCandidateAction("rejected"))
	mux.HandleFunc("POST /api/candidates/{candidateId}/defer", a.handleCandidateAction("deferred"))
	mux.HandleFunc("POST /api/candidates/{candidateId}/duplicate", a.handleCandidateAction("duplicate_detected"))
	mux.HandleFunc("POST /api/candidates/{candidateId}/rescan", a.handleCandidateAction("needs_rescan"))
	mux.HandleFunc("POST /api/extraction-plans", a.handleCreateExtractionPlan)
	mux.HandleFunc("GET /api/extraction-plans/{planId}", a.handleGetExtractionPlan)
	mux.HandleFunc("POST /api/extraction-plans/{planId}/jobs", a.handleExtractionJob)
	mux.HandleFunc("GET /api/modules", a.handleListModules)
	mux.HandleFunc("POST /api/modules", a.handleRegisterModule)
	mux.HandleFunc("GET /api/modules/{moduleId}", a.handleGetModule)
	mux.HandleFunc("POST /api/modules/{moduleId}/compare", a.handleCompareModule)
	mux.HandleFunc("POST /api/spec-enrichments", a.handleCreateSpecEnrichment)
	mux.HandleFunc("GET /api/spec-enrichments/{enrichmentId}", a.handleGetSpecEnrichment)
	mux.HandleFunc("POST /api/spec-enrichments/{enrichmentId}/jobs", a.handleSpecEnrichmentJob)
	mux.HandleFunc("POST /api/compositions", a.handleCreateComposition)
	mux.HandleFunc("GET /api/compositions/{compositionId}", a.handleGetComposition)
	mux.HandleFunc("PATCH /api/compositions/{compositionId}/layout", a.handlePatchCompositionLayout)
	mux.HandleFunc("POST /api/compositions/{compositionId}/clarification-jobs", a.handleCompositionClarificationJob)
	mux.HandleFunc("POST /api/compositions/{compositionId}/answers", a.handleCompositionAnswers)
	mux.HandleFunc("POST /api/compositions/{compositionId}/compile-jobs", a.handleCompositionCompileJob)
	mux.HandleFunc("GET /api/workbench/palette", a.handlePalette)
	mux.HandleFunc("POST /api/workbench/validate-edge", a.handleValidateWorkbenchEdge)
	mux.HandleFunc("POST /api/blueprints", a.handleCreateBlueprint)
	mux.HandleFunc("GET /api/blueprints", a.handleListBlueprints)
	mux.HandleFunc("GET /api/blueprints/{blueprintId}", a.handleGetBlueprint)
	mux.HandleFunc("PATCH /api/blueprints/{blueprintId}", a.handleUpdateBlueprint)
	mux.HandleFunc("POST /api/blueprints/{blueprintId}/validate", a.handleValidateBlueprint)
	mux.HandleFunc("POST /api/blueprints/{blueprintId}/wiring-jobs", a.handleWiringJob)
	mux.HandleFunc("GET /api/agent-jobs", a.handleListJobs)
	mux.HandleFunc("GET /api/agent-jobs/{jobId}", a.handleGetJob)
	mux.HandleFunc("POST /api/agent-jobs/{jobId}/open", a.handleOpenJob)
	mux.HandleFunc("POST /api/agent-jobs/{jobId}/cancel", a.handleCancelJob)
	mux.HandleFunc("/", a.handleStatic)
}

func (a *App) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(rw, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			attrs := map[string]any{"method": r.Method, "path": r.URL.Path, "status": rw.status, "duration_ms": time.Since(start).Milliseconds()}
			if rw.status >= 400 && rw.body.Len() > 0 {
				attrs["response"] = rw.body.String()
			}
			a.log.Event("api_request", attrs)
		}
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status >= 400 && w.body.Len() < 4096 {
		remaining := 4096 - w.body.Len()
		if len(b) > remaining {
			_, _ = w.body.Write(b[:remaining])
		} else {
			_, _ = w.body.Write(b)
		}
	}
	return w.ResponseWriter.Write(b)
}

func (a *App) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "API route not found"})
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	name := "static/dist/" + path
	if b, err := staticFS.ReadFile(name); err == nil {
		http.ServeContent(w, r, path, time.Now(), strings.NewReader(string(b)))
		return
	}
	b, err := staticFS.ReadFile("static/dist/index.html")
	if err != nil {
		http.Error(w, "frontend not built", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(b)
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	err := a.store.DB.PingContext(r.Context())
	status := "ok"
	if err != nil {
		status = "degraded"
	}
	writeJSON(w, 200, map[string]any{"status": status, "database": err == nil, "storage": true, "workers": map[string]int{"analysis": a.cfg.AnalysisLimit, "extraction": a.cfg.ExtractionLimit, "wiring": a.cfg.WiringLimit}})
}

func (a *App) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"dataDir": a.cfg.DataDir, "allowedRoots": a.cfg.AllowedRoots,
		"concurrency": map[string]int{"analysis": a.cfg.AnalysisLimit, "extraction": a.cfg.ExtractionLimit, "wiring": a.cfg.WiringLimit},
		"providers":   a.cfg.Providers(),
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	api := APIError{Status: 500, Code: "database.operation_failed", Message: "local database operation failed"}
	if errors.As(err, &api) {
		if api.Status == 0 {
			api.Status = 500
		}
	}
	writeJSON(w, api.Status, map[string]any{"error": map[string]any{"code": api.Code, "message": api.Message, "details": api.Details}})
}

func decodeStrict(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if strings.HasPrefix(err.Error(), "json: unknown field ") {
			field := strings.Trim(err.Error()[len("json: unknown field "):], `"`)
			return APIError{Status: 400, Code: "request.unknown_field", Message: "unknown request field", Details: map[string]any{"field": field}}
		}
		return APIError{Status: 400, Code: "request.invalid_json", Message: err.Error()}
	}
	return nil
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func newID(prefix string) string {
	return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
}

func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func writeDoc(root string, v any) (string, error) {
	if err := os.MkdirAll(filepath.Dir(root), 0o755); err != nil {
		return "", err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(root, b, 0o644); err != nil {
		return "", err
	}
	return root, nil
}

func requireReason(reason string) error {
	if len(strings.TrimSpace(reason)) < 3 {
		return APIError{Status: 400, Code: "request.missing_field", Message: "reason must contain at least 3 non-whitespace characters"}
	}
	return nil
}

func scanJSONRows(rows *sql.Rows) ([]map[string]any, error) {
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		raw := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range raw {
			ptrs[i] = &raw[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := map[string]any{}
		for i, c := range cols {
			m[toCamel(c)] = parseDBValue(raw[i])
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func parseDBValue(v any) any {
	switch value := v.(type) {
	case nil:
		return nil
	case []byte:
		return parseMaybeJSON(string(value))
	case string:
		return parseMaybeJSON(value)
	default:
		return value
	}
}

func parseMaybeJSON(s string) any {
	var v any
	if len(s) > 0 && (s[0] == '{' || s[0] == '[') && json.Unmarshal([]byte(s), &v) == nil {
		return v
	}
	return s
}

func toCamel(s string) string {
	parts := strings.Split(s, "_")
	for i := 1; i < len(parts); i++ {
		if parts[i] != "" {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}

func one(w http.ResponseWriter, err error, status int, v any) {
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, status, v)
}

func (a *App) queryRows(w http.ResponseWriter, query string, args ...any) {
	rows, err := a.store.DB.Query(query, args...)
	if err != nil {
		writeErr(w, err)
		return
	}
	data, err := scanJSONRows(rows)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": data})
}

func getSingle(db *sql.DB, query string, args ...any) (map[string]any, error) {
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanJSONRows(rows)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, APIError{Status: 404, Code: "resource.not_found", Message: "resource not found"}
	}
	return items[0], nil
}

func (a *App) transitionSession(ctx context.Context, id, fromUpdatedAt, to string) error {
	var phase, updated string
	err := a.store.DB.QueryRowContext(ctx, `SELECT phase, updated_at FROM repo_sessions WHERE id=?`, id).Scan(&phase, &updated)
	if storage.IsNotFound(err) {
		return APIError{Status: 404, Code: "resource.not_found", Message: "session not found"}
	}
	if err != nil {
		return err
	}
	if fromUpdatedAt != "" && fromUpdatedAt != updated {
		return APIError{Status: 409, Code: "state.conflict", Message: "session was updated by another request"}
	}
	if !validSessionTransition(phase, to) {
		return APIError{Status: 409, Code: "session.invalid_transition", Message: "invalid session transition", Details: map[string]any{"from": phase, "to": to}}
	}
	_, err = a.store.DB.ExecContext(ctx, `UPDATE repo_sessions SET phase=?, updated_at=? WHERE id=?`, to, now(), id)
	return err
}

func validSessionTransition(from, to string) bool {
	if from == to {
		return true
	}
	allowed := map[string][]string{
		"created":              {"awaiting_user_intent", "cancelled"},
		"awaiting_user_intent": {"ready_for_analysis", "needs_user_input", "cancelled"},
		"ready_for_analysis":   {"queued", "needs_user_input", "cancelled"},
		"queued":               {"analysing", "failed_analysis", "paused", "cancelled"},
		"analysing":            {"candidates_ready", "failed_analysis", "needs_user_input", "cancelled"},
		"candidates_ready":     {"awaiting_approval", "duplicate_detected", "conflict_detected", "cancelled"},
		"awaiting_approval":    {"extraction_planned", "needs_user_input", "cancelled"},
		"extraction_planned":   {"extracting", "paused", "cancelled"},
		"extracting":           {"extracted", "failed_extraction", "needs_user_input", "cancelled"},
		"extracted":            {"registered", "duplicate_detected", "conflict_detected"},
		"registered":           {"available_in_workbench", "conflict_detected"},
		"failed_analysis":      {"ready_for_analysis", "cancelled"},
		"failed_extraction":    {"extraction_planned", "cancelled"},
		"needs_user_input":     {"ready_for_analysis", "awaiting_approval", "extraction_planned", "cancelled"},
		"paused":               {"queued", "extracting", "cancelled"},
		"duplicate_detected":   {"awaiting_approval", "cancelled"},
		"conflict_detected":    {"awaiting_approval", "extraction_planned", "cancelled"},
	}
	for _, candidate := range allowed[from] {
		if candidate == to {
			return true
		}
	}
	return false
}

func validGitURL(uri string) bool {
	return strings.HasPrefix(uri, "https://") || strings.HasPrefix(uri, "ssh://") || regexp.MustCompile(`^git@[^:]+:.+/.+\.git$`).MatchString(uri)
}

func (a *App) sourceRoot() string {
	return filepath.Join(filepath.Dir(a.cfg.DataDir), ".sources")
}

func sourceSlug(sourceType, uri, name string) string {
	base := name
	if base == "" {
		base = strings.TrimSuffix(filepath.Base(uri), ".git")
	}
	base = strings.ToLower(base)
	base = regexp.MustCompile(`[^a-z0-9._-]+`).ReplaceAllString(base, "-")
	base = strings.Trim(base, ".-_")
	if base == "" {
		base = strings.TrimPrefix(sourceType, "source")
	}
	return base
}

func uniqueSourcePath(root, slug string) string {
	candidate := filepath.Join(root, slug)
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		return candidate
	}
	for i := 2; ; i++ {
		candidate = filepath.Join(root, fmt.Sprintf("%s-%d", slug, i))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
}

func runGitClone(ctx context.Context, uri, dest string) error {
	tmp, err := os.MkdirTemp("", "code-workbench-source-clone-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	cmd := exec.CommandContext(ctx, "git", "clone", uri, tmp)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return publishCheckout(tmp, dest)
}

func createLocalCheckout(ctx context.Context, src, dest string) error {
	tmp, err := os.MkdirTemp("", "code-workbench-source-worktree-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	cmd := exec.CommandContext(ctx, "git", "-C", src, "worktree", "add", "--detach", tmp, "HEAD")
	cmd.Env = os.Environ()
	if out, err := cmd.CombinedOutput(); err == nil {
		return publishCheckout(tmp, dest)
	} else {
		_ = out
		_ = os.RemoveAll(tmp)
	}
	if err := copyDir(src, tmp); err != nil {
		return err
	}
	return publishCheckout(tmp, dest)
}

func publishCheckout(src, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	backup, err := moveExistingAside(dest)
	if err != nil {
		return err
	}
	published := false
	defer func() {
		if published && backup != "" {
			_ = os.RemoveAll(backup)
		}
	}()
	if err := os.Rename(src, dest); err == nil {
		published = true
		return nil
	}
	if err := copyDir(src, dest); err != nil {
		_ = os.RemoveAll(dest)
		if backup != "" {
			_ = os.Rename(backup, dest)
		}
		return err
	}
	published = true
	return nil
}

func moveExistingAside(path string) (string, error) {
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return "", nil
	} else if err != nil {
		return "", err
	}
	backup := fmt.Sprintf("%s.replaced-%d", path, time.Now().UnixNano())
	if err := os.Rename(path, backup); err != nil {
		return "", err
	}
	return backup, nil
}

func copyDir(src, dest string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", src)
	}
	if err := os.MkdirAll(dest, info.Mode().Perm()); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == ".git" {
			continue
		}
		from := filepath.Join(src, entry.Name())
		to := filepath.Join(dest, entry.Name())
		info, err := os.Lstat(from)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(from)
			if err != nil {
				return err
			}
			if err := os.Symlink(target, to); err != nil {
				return err
			}
			continue
		}
		if info.IsDir() {
			if err := copyDir(from, to); err != nil {
				return err
			}
			continue
		}
		if err := copyFile(from, to, info.Mode().Perm()); err != nil {
			return err
		}
	}
	return nil
}

func copyFile(src, dest string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
