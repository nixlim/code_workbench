package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"code_workbench/internal/paths"
	"code_workbench/internal/storage"
)

func (a *App) handleCreateRepository(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name          string `json:"name"`
		SourceType    string `json:"sourceType"`
		SourceURI     string `json:"sourceUri"`
		DefaultBranch string `json:"defaultBranch"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	if req.SourceType != "local_path" && req.SourceType != "git_url" {
		writeErr(w, APIError{Status: 400, Code: "request.invalid_enum", Message: "sourceType must be local_path or git_url"})
		return
	}
	if req.Name == "" {
		req.Name = filepath.Base(req.SourceURI)
	}
	if req.SourceType == "local_path" {
		if len(a.cfg.AllowedRoots) == 0 || !paths.InAllowedRoots(req.SourceURI, a.cfg.AllowedRoots) {
			writeErr(w, APIError{Status: 400, Code: "path.invalid", Message: "local repository is outside allowed roots"})
			return
		}
		info, err := os.Stat(req.SourceURI)
		if err != nil || !info.IsDir() {
			writeErr(w, APIError{Status: 400, Code: "path.invalid", Message: "local repository must be a readable directory"})
			return
		}
		if _, err := os.Stat(filepath.Join(req.SourceURI, ".git")); err != nil {
			writeErr(w, APIError{Status: 400, Code: "path.invalid", Message: "local repository must contain .git"})
			return
		}
	} else if !validGitURL(req.SourceURI) {
		writeErr(w, APIError{Status: 400, Code: "path.invalid", Message: "unsupported git URL"})
		return
	}
	id, ts := newID("repo"), now()
	_, err := a.store.DB.ExecContext(r.Context(), `INSERT INTO repositories(id,name,source_type,source_uri,default_branch,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, id, req.Name, req.SourceType, req.SourceURI, req.DefaultBranch, ts, ts)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		existing, _ := getSingle(a.store.DB, `SELECT * FROM repositories WHERE source_type=? AND source_uri=?`, req.SourceType, req.SourceURI)
		writeErr(w, APIError{Status: 409, Code: "repository.duplicate", Message: "repository already registered", Details: map[string]any{"repository": existing}})
		return
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	repo, err := getSingle(a.store.DB, `SELECT * FROM repositories WHERE id=?`, id)
	one(w, err, 201, repo)
}

func (a *App) handleListRepositories(w http.ResponseWriter, r *http.Request) {
	a.queryRows(w, `SELECT * FROM repositories ORDER BY created_at DESC`)
}

func (a *App) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RepositoryID string `json:"repositoryId"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	var repo struct{ ID, Name, SourceType, SourceURI string }
	err := a.store.DB.QueryRowContext(r.Context(), `SELECT id,name,source_type,source_uri FROM repositories WHERE id=?`, req.RepositoryID).Scan(&repo.ID, &repo.Name, &repo.SourceType, &repo.SourceURI)
	if storage.IsNotFound(err) {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "repository not found"})
		return
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	id := newID("sess")
	sessionRoot := filepath.Join(a.cfg.DataDir, "sessions", id)
	checkout := filepath.Join(sessionRoot, "repo")
	scratch := filepath.Join(sessionRoot, "scratch")
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		writeErr(w, err)
		return
	}
	if repo.SourceType == "local_path" {
		if err := createLocalCheckout(r.Context(), repo.SourceURI, checkout); err != nil {
			_ = os.RemoveAll(sessionRoot)
			writeErr(w, APIError{Status: 502, Code: "repository.clone_failed", Message: err.Error()})
			return
		}
	} else if err := runGitClone(r.Context(), repo.SourceURI, checkout); err != nil {
		_ = os.RemoveAll(sessionRoot)
		writeErr(w, APIError{Status: 502, Code: "repository.clone_failed", Message: err.Error()})
		return
	}
	ts := now()
	_, err = a.store.DB.ExecContext(r.Context(), `INSERT INTO repo_sessions(id,repository_id,repo_name,checkout_path,scratch_path,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, id, repo.ID, repo.Name, checkout, scratch, "awaiting_user_intent", ts, ts)
	if err != nil {
		writeErr(w, err)
		return
	}
	session, err := getSingle(a.store.DB, `SELECT * FROM repo_sessions WHERE id=?`, id)
	one(w, err, 201, session)
}

func (a *App) handleListSessions(w http.ResponseWriter, r *http.Request) {
	a.queryRows(w, `SELECT s.*, (SELECT role FROM agent_jobs j WHERE j.subject_type='session' AND j.subject_id=s.id AND j.status IN ('queued','running') ORDER BY created_at DESC LIMIT 1) AS active_job_role FROM repo_sessions s ORDER BY created_at DESC`)
}

func (a *App) handleGetSession(w http.ResponseWriter, r *http.Request) {
	a.getSessionWithJobs(w, r.PathValue("sessionId"))
}

func (a *App) getSessionWithJobs(w http.ResponseWriter, id string) {
	session, err := getSingle(a.store.DB, `SELECT * FROM repo_sessions WHERE id=?`, id)
	if err != nil {
		writeErr(w, err)
		return
	}
	rows, err := a.store.DB.Query(`SELECT * FROM agent_jobs WHERE subject_id=? ORDER BY created_at DESC`, id)
	if err != nil {
		writeErr(w, err)
		return
	}
	jobs, err := scanJSONRows(rows)
	if err != nil {
		writeErr(w, err)
		return
	}
	session["jobs"] = jobs
	writeJSON(w, 200, session)
}

func (a *App) handleSessionFile(w http.ResponseWriter, r *http.Request) {
	var checkout string
	if err := a.store.DB.QueryRow(`SELECT checkout_path FROM repo_sessions WHERE id=?`, r.PathValue("sessionId")).Scan(&checkout); err != nil {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "session not found"})
		return
	}
	resolved, err := paths.ResolveInside(checkout, r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, APIError{Status: 400, Code: "path.invalid", Message: "unsafe source path"})
		return
	}
	b, err := os.ReadFile(resolved)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"path": r.URL.Query().Get("path"), "content": string(b)})
}

func (a *App) handleSessionIntent(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SpecificFunctionality string   `json:"specificFunctionality"`
		AreasOfInterest       []string `json:"areasOfInterest"`
		SourceHints           []string `json:"sourceHints"`
		AvoidPatterns         []string `json:"avoidPatterns"`
		PreferredTargetLang   string   `json:"preferredTargetLanguage"`
		AllowAgentDiscovery   bool     `json:"allowAgentDiscovery"`
		ExpectedUpdatedAt     string   `json:"expectedUpdatedAt"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	sessionID := r.PathValue("sessionId")
	var scratch string
	if err := a.store.DB.QueryRow(`SELECT scratch_path FROM repo_sessions WHERE id=?`, sessionID).Scan(&scratch); err != nil {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "session not found"})
		return
	}
	path, err := writeDoc(filepath.Join(scratch, "intent.json"), req)
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := a.transitionSession(r.Context(), sessionID, req.ExpectedUpdatedAt, "ready_for_analysis"); err != nil {
		writeErr(w, err)
		return
	}
	_, err = a.store.DB.Exec(`UPDATE repo_sessions SET intent_json_path=?, updated_at=? WHERE id=?`, path, now(), sessionID)
	if err != nil {
		writeErr(w, err)
		return
	}
	a.getSessionWithJobs(w, sessionID)
}

func (a *App) handleAnalysisJob(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	var phase string
	if err := a.store.DB.QueryRow(`SELECT phase FROM repo_sessions WHERE id=?`, r.PathValue("sessionId")).Scan(&phase); err != nil {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "session not found"})
		return
	}
	if phase != "ready_for_analysis" && phase != "queued" && phase != "analysing" {
		writeErr(w, APIError{Status: 409, Code: "session.invalid_transition", Message: "analysis requires recorded intent"})
		return
	}
	status, job, err := a.QueueJob(r.Context(), "repo_analysis", "session", r.PathValue("sessionId"), req.Provider)
	if err == nil && status == 202 {
		_ = a.transitionSession(r.Context(), r.PathValue("sessionId"), "", "queued")
	}
	one(w, err, status, job)
}

func (a *App) handleListCandidates(w http.ResponseWriter, r *http.Request) {
	q := `SELECT * FROM candidates WHERE 1=1`
	args := []any{}
	for _, f := range []string{"session_id", "repository_id", "status", "extraction_risk", "confidence"} {
		camel := toCamel(f)
		if v := r.URL.Query().Get(camel); v != "" {
			q += " AND " + f + "=?"
			args = append(args, v)
		}
	}
	if v := strings.TrimSpace(r.URL.Query().Get("capability")); v != "" {
		q += ` AND (proposed_name LIKE ? OR description LIKE ? OR module_kind LIKE ? OR workbench_node_json LIKE ?)`
		like := "%" + v + "%"
		args = append(args, like, like, like, like)
	}
	q += ` ORDER BY session_id, created_at`
	a.queryRows(w, q, args...)
}

func (a *App) handlePatchCandidate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProposedName string `json:"proposedName"`
		Description  string `json:"description"`
		ModuleKind   string `json:"moduleKind"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	id := r.PathValue("candidateId")
	var status string
	if err := a.store.DB.QueryRow(`SELECT status FROM candidates WHERE id=?`, id).Scan(&status); err != nil {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "candidate not found"})
		return
	}
	if status != "proposed" && status != "deferred" {
		writeErr(w, APIError{Status: 409, Code: "candidate.invalid_transition", Message: "candidate cannot be modified from current status"})
		return
	}
	_, err := a.store.DB.Exec(`UPDATE candidates SET proposed_name=COALESCE(NULLIF(?,''),proposed_name), description=COALESCE(NULLIF(?,''),description), module_kind=COALESCE(NULLIF(?,''),module_kind), status='modified', updated_at=? WHERE id=?`, req.ProposedName, req.Description, req.ModuleKind, now(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	item, err := getSingle(a.store.DB, `SELECT * FROM candidates WHERE id=?`, id)
	one(w, err, 200, item)
}

func (a *App) handleCandidateAction(status string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Reason            string `json:"reason"`
			DuplicateModuleID string `json:"duplicateModuleId"`
		}
		if err := decodeStrict(r, &req); err != nil {
			writeErr(w, err)
			return
		}
		if status != "needs_rescan" {
			if err := requireReason(req.Reason); err != nil {
				writeErr(w, err)
				return
			}
		}
		id := r.PathValue("candidateId")
		var current string
		if err := a.store.DB.QueryRow(`SELECT status FROM candidates WHERE id=?`, id).Scan(&current); err != nil {
			writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "candidate not found"})
			return
		}
		if !validCandidateTransition(current, status) {
			writeErr(w, APIError{Status: 409, Code: "candidate.invalid_transition", Message: "invalid candidate transition"})
			return
		}
		approvedAt := sql.NullString{}
		if status == "approved" {
			approvedAt = sql.NullString{String: now(), Valid: true}
		}
		_, err := a.store.DB.Exec(`UPDATE candidates SET status=?, user_reason=?, approved_at=COALESCE(?,approved_at), updated_at=? WHERE id=?`, status, req.Reason, approvedAt, now(), id)
		if err != nil {
			writeErr(w, err)
			return
		}
		item, err := getSingle(a.store.DB, `SELECT * FROM candidates WHERE id=?`, id)
		one(w, err, 200, item)
	}
}

func validCandidateTransition(from, to string) bool {
	if from == to {
		return true
	}
	allowed := map[string][]string{
		"proposed":           {"modified", "approved", "rejected", "deferred", "needs_rescan", "duplicate_detected"},
		"modified":           {"approved", "rejected", "deferred", "needs_rescan", "duplicate_detected"},
		"approved":           {"extraction_planned", "needs_rescan", "duplicate_detected"},
		"rejected":           {"needs_rescan"},
		"deferred":           {"modified", "approved", "rejected", "needs_rescan"},
		"needs_rescan":       {"proposed", "modified", "rejected"},
		"extraction_planned": {"extracting", "merge_required", "duplicate_detected"},
		"extracting":         {"extracted", "merge_required", "duplicate_detected", "needs_rescan"},
		"extracted":          {"registered", "merge_required", "duplicate_detected"},
		"duplicate_detected": {"merge_required", "rejected", "needs_rescan"},
		"merge_required":     {"registered", "rejected", "needs_rescan"},
		"registered":         {"available_in_workbench"},
	}
	for _, s := range allowed[from] {
		if s == to {
			return true
		}
	}
	return false
}

func (a *App) handleCreateExtractionPlan(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID            string   `json:"sessionId"`
		ApprovedCandidateIDs []string `json:"approvedCandidateIds"`
		RejectedCandidateIDs []string `json:"rejectedCandidateIds"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	var repoID string
	if err := a.store.DB.QueryRow(`SELECT repository_id FROM repo_sessions WHERE id=?`, req.SessionID).Scan(&repoID); err != nil {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "session not found"})
		return
	}
	for _, id := range req.ApprovedCandidateIDs {
		var status string
		if err := a.store.DB.QueryRow(`SELECT status FROM candidates WHERE id=? AND session_id=?`, id, req.SessionID).Scan(&status); err != nil || status != "approved" {
			writeErr(w, APIError{Status: 409, Code: "candidate.not_approved", Message: "all extraction plan candidates must be approved", Details: map[string]any{"candidateId": id}})
			return
		}
	}
	id, ts := newID("plan"), now()
	doc := map[string]any{"planId": id, "sessionId": req.SessionID, "approvedCandidateIds": req.ApprovedCandidateIDs, "rejectedCandidateIds": req.RejectedCandidateIDs}
	path, err := writeDoc(filepath.Join(a.cfg.DataDir, "documents", "extraction-plans", id+".json"), doc)
	if err != nil {
		writeErr(w, err)
		return
	}
	_, err = a.store.DB.Exec(`INSERT INTO extraction_plans(id,session_id,repository_id,status,plan_path,approved_candidate_ids_json,rejected_candidate_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, req.SessionID, repoID, "ready", path, jsonText(req.ApprovedCandidateIDs), jsonText(req.RejectedCandidateIDs), ts, ts)
	if err == nil {
		for _, cid := range req.ApprovedCandidateIDs {
			_, _ = a.store.DB.Exec(`UPDATE candidates SET status='extraction_planned', updated_at=? WHERE id=?`, now(), cid)
		}
	}
	item, err := getSingle(a.store.DB, `SELECT * FROM extraction_plans WHERE id=?`, id)
	one(w, err, 201, item)
}

func (a *App) handleGetExtractionPlan(w http.ResponseWriter, r *http.Request) {
	item, err := getSingle(a.store.DB, `SELECT * FROM extraction_plans WHERE id=?`, r.PathValue("planId"))
	one(w, err, 200, item)
}

func (a *App) handleExtractionJob(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	var planID string
	if err := a.store.DB.QueryRow(`SELECT id FROM extraction_plans WHERE id=?`, r.PathValue("planId")).Scan(&planID); err != nil {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "extraction plan not found"})
		return
	}
	status, job, err := a.QueueJob(r.Context(), "extraction", "extraction_plan", r.PathValue("planId"), req.Provider)
	one(w, err, status, job)
}

func (a *App) handleListModules(w http.ResponseWriter, r *http.Request) {
	a.queryRows(w, `SELECT * FROM modules ORDER BY name, version DESC`)
}

func (a *App) handleGetModule(w http.ResponseWriter, r *http.Request) {
	item, err := getSingle(a.store.DB, `SELECT * FROM modules WHERE id=?`, r.PathValue("moduleId"))
	one(w, err, 200, item)
}

func (a *App) handleRegisterModule(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name               string         `json:"name"`
		SourceRepositoryID string         `json:"sourceRepositoryId"`
		SourceSessionID    string         `json:"sourceSessionId"`
		SourceCandidateID  string         `json:"sourceCandidateId"`
		Language           string         `json:"language"`
		ModuleKind         string         `json:"moduleKind"`
		ImportPath         string         `json:"importPath"`
		Capabilities       []string       `json:"capabilities"`
		Ports              map[string]any `json:"ports"`
		ConfigSchema       map[string]any `json:"configSchema"`
		Docs               string         `json:"docs"`
		TestStatus         string         `json:"testStatus"`
		ExtractionJobID    string         `json:"extractionJobId"`
		SourceFiles        []string       `json:"sourceFiles"`
		TestFiles          []string       `json:"testFiles"`
		Manifest           map[string]any `json:"manifest"`
		Provenance         map[string]any `json:"provenance"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	if req.Language == "" {
		req.Language = "go"
	}
	if req.TestStatus == "" {
		req.TestStatus = "not_run"
	}
	if req.Name == "" || req.SourceRepositoryID == "" || req.SourceSessionID == "" || req.SourceCandidateID == "" || req.ImportPath == "" || req.ModuleKind == "" || len(req.Ports) == 0 || len(req.ConfigSchema) == 0 || req.Docs == "" || req.ExtractionJobID == "" || len(req.SourceFiles) == 0 || len(req.TestFiles) == 0 || len(req.Manifest) == 0 || len(req.Provenance) == 0 {
		writeErr(w, APIError{Status: 422, Code: "module_output.invalid", Message: "module output is incomplete"})
		return
	}
	if req.TestStatus != "not_run" && req.TestStatus != "passing" && req.TestStatus != "failing" {
		writeErr(w, APIError{Status: 422, Code: "module_output.invalid", Message: "invalid test status"})
		return
	}
	if err := validatePorts(req.Ports); err != nil {
		writeErr(w, err)
		return
	}
	if err := a.validateModuleProvenance(req); err != nil {
		writeErr(w, err)
		return
	}
	version, err := a.nextModuleVersion(req.SourceCandidateID, req.Name)
	if err != nil {
		writeErr(w, err)
		return
	}
	id := newID("mod")
	root := filepath.Join(a.cfg.DataDir, "modules", id)
	req.Manifest["name"] = req.Name
	req.Manifest["version"] = version
	req.Manifest["ports"] = req.Ports
	req.Manifest["provenance"] = req.Provenance
	manifestPath, err := writeDoc(filepath.Join(root, "manifest.json"), req.Manifest)
	if err != nil {
		writeErr(w, err)
		return
	}
	configPath, err := writeDoc(filepath.Join(root, "config.schema.json"), req.ConfigSchema)
	if err != nil {
		writeErr(w, err)
		return
	}
	docsPath, err := writeDoc(filepath.Join(root, "README.md.json"), map[string]string{"content": req.Docs})
	if err != nil {
		writeErr(w, err)
		return
	}
	available := 0
	if req.TestStatus == "passing" && len(req.Ports) > 0 && len(req.ConfigSchema) > 0 {
		available = 1
	}
	ts := now()
	_, err = a.store.DB.Exec(`INSERT INTO modules(id,name,version,source_repository_id,source_session_id,source_candidate_id,language,module_kind,import_path,capabilities_json,ports_json,config_schema_path,manifest_path,docs_path,test_status,available_in_workbench,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, req.Name, version, req.SourceRepositoryID, req.SourceSessionID, req.SourceCandidateID, req.Language, req.ModuleKind, req.ImportPath, jsonText(req.Capabilities), jsonText(req.Ports), configPath, manifestPath, docsPath, req.TestStatus, available, ts, ts)
	item, err := getSingle(a.store.DB, `SELECT * FROM modules WHERE id=?`, id)
	one(w, err, 201, item)
}

func (a *App) validateModuleProvenance(req struct {
	Name               string         `json:"name"`
	SourceRepositoryID string         `json:"sourceRepositoryId"`
	SourceSessionID    string         `json:"sourceSessionId"`
	SourceCandidateID  string         `json:"sourceCandidateId"`
	Language           string         `json:"language"`
	ModuleKind         string         `json:"moduleKind"`
	ImportPath         string         `json:"importPath"`
	Capabilities       []string       `json:"capabilities"`
	Ports              map[string]any `json:"ports"`
	ConfigSchema       map[string]any `json:"configSchema"`
	Docs               string         `json:"docs"`
	TestStatus         string         `json:"testStatus"`
	ExtractionJobID    string         `json:"extractionJobId"`
	SourceFiles        []string       `json:"sourceFiles"`
	TestFiles          []string       `json:"testFiles"`
	Manifest           map[string]any `json:"manifest"`
	Provenance         map[string]any `json:"provenance"`
}) error {
	var candidateStatus string
	err := a.store.DB.QueryRow(`SELECT status FROM candidates WHERE id=? AND session_id=? AND repository_id=?`, req.SourceCandidateID, req.SourceSessionID, req.SourceRepositoryID).Scan(&candidateStatus)
	if err != nil {
		return APIError{Status: 422, Code: "module_output.invalid", Message: "module candidate provenance is invalid"}
	}
	if candidateStatus != "extracted" && candidateStatus != "registered" && candidateStatus != "available_in_workbench" {
		return APIError{Status: 422, Code: "module_output.invalid", Message: "candidate must be extracted before module registration"}
	}
	var outputRoot, planID string
	err = a.store.DB.QueryRow(`SELECT COALESCE(output_artifact_path,''), subject_id FROM agent_jobs WHERE id=? AND role='extraction' AND status='succeeded' AND subject_type='extraction_plan'`, req.ExtractionJobID).Scan(&outputRoot, &planID)
	if err != nil || outputRoot == "" {
		return APIError{Status: 422, Code: "module_output.invalid", Message: "module must reference a succeeded extraction job"}
	}
	var approvedJSON string
	if err := a.store.DB.QueryRow(`SELECT approved_candidate_ids_json FROM extraction_plans WHERE id=?`, planID).Scan(&approvedJSON); err != nil {
		return APIError{Status: 422, Code: "module_output.invalid", Message: "module extraction plan provenance is invalid"}
	}
	var approved []string
	if err := json.Unmarshal([]byte(approvedJSON), &approved); err != nil || !containsString(approved, req.SourceCandidateID) {
		return APIError{Status: 422, Code: "module_output.invalid", Message: "candidate was not approved in the extraction plan"}
	}
	for _, rel := range append(append([]string{}, req.SourceFiles...), req.TestFiles...) {
		if _, err := paths.ResolveInside(outputRoot, rel); err != nil {
			return APIError{Status: 422, Code: "module_output.invalid", Message: "module artifact is missing or escapes extraction output"}
		}
	}
	return nil
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

func (a *App) nextModuleVersion(candidateID, name string) (string, error) {
	rows, err := a.store.DB.Query(`SELECT version FROM modules WHERE source_candidate_id=? OR name=?`, candidateID, name)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	maxMinor := 0
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return "", err
		}
		parts := strings.Split(v, ".")
		if len(parts) == 3 && parts[0] == "0" {
			n, _ := strconv.Atoi(parts[1])
			if n > maxMinor {
				maxMinor = n
			}
		}
	}
	return fmt.Sprintf("0.%d.0", maxMinor+1), rows.Err()
}

func (a *App) handleCompareModule(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CompareToModuleID string `json:"compareToModuleId"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	target, err := a.moduleComparisonData(r.PathValue("moduleId"))
	if err != nil {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "module not found"})
		return
	}
	q := `SELECT id FROM modules WHERE id<>?`
	args := []any{target.ID}
	if req.CompareToModuleID != "" {
		q += ` AND id=?`
		args = append(args, req.CompareToModuleID)
	}
	rows, err := a.store.DB.Query(q, args...)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer rows.Close()
	best := registryComparison{ModuleID: target.ID, Classification: "new_module"}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			writeErr(w, err)
			return
		}
		other, err := a.moduleComparisonData(id)
		if err != nil {
			writeErr(w, err)
			return
		}
		cmp := classifyRegistryModules(target, other)
		if cmp.rank() > best.rank() || (cmp.rank() == best.rank() && cmp.CapabilityOverlap > best.CapabilityOverlap) {
			best = cmp
		}
	}
	if err := rows.Err(); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, best)
}

type moduleComparisonData struct {
	ID           string
	Capabilities []string
	Ports        map[string]any
	Config       map[string]any
	Manifest     map[string]any
	SourcePaths  []string
	Dependencies []string
	TestStatus   string
	DocsPath     string
}

type registryComparison struct {
	ModuleID            string  `json:"moduleId"`
	ComparedModuleID    string  `json:"comparedModuleId,omitempty"`
	Classification      string  `json:"classification"`
	CapabilityOverlap   float64 `json:"capabilityOverlap"`
	SourcePathOverlap   float64 `json:"sourcePathOverlap"`
	PortsIdentical      bool    `json:"portsIdentical"`
	ConfigIdentical     bool    `json:"configIdentical"`
	DependenciesOverlap bool    `json:"dependenciesOverlap"`
}

func (c registryComparison) rank() int {
	switch c.Classification {
	case "reject_duplicate":
		return 5
	case "duplicate":
		return 4
	case "adapter_needed":
		return 3
	case "variant":
		return 2
	case "merge_candidate":
		return 1
	default:
		return 0
	}
}

func (a *App) moduleComparisonData(id string) (moduleComparisonData, error) {
	var out moduleComparisonData
	var capabilitiesJSON, portsJSON, configPath, manifestPath, sourcePathsJSON, dependenciesJSON string
	err := a.store.DB.QueryRow(`SELECT m.id,m.capabilities_json,m.ports_json,m.config_schema_path,m.manifest_path,m.docs_path,m.test_status,COALESCE(c.source_paths_json,'[]'),COALESCE(c.dependencies_json,'[]') FROM modules m LEFT JOIN candidates c ON c.id=m.source_candidate_id WHERE m.id=?`, id).Scan(&out.ID, &capabilitiesJSON, &portsJSON, &configPath, &manifestPath, &out.DocsPath, &out.TestStatus, &sourcePathsJSON, &dependenciesJSON)
	if err != nil {
		return out, err
	}
	_ = json.Unmarshal([]byte(capabilitiesJSON), &out.Capabilities)
	_ = json.Unmarshal([]byte(portsJSON), &out.Ports)
	_ = json.Unmarshal([]byte(sourcePathsJSON), &out.SourcePaths)
	_ = json.Unmarshal([]byte(dependenciesJSON), &out.Dependencies)
	if b, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(b, &out.Config)
	}
	if b, err := os.ReadFile(manifestPath); err == nil {
		_ = json.Unmarshal(b, &out.Manifest)
	}
	return out, nil
}

func classifyRegistryModules(target, other moduleComparisonData) registryComparison {
	capOverlap := overlapRatio(target.Capabilities, other.Capabilities)
	sourceOverlap := overlapRatio(target.SourcePaths, other.SourcePaths)
	dependencyOverlap := overlapCount(target.Dependencies, other.Dependencies) > 0
	portsIdentical := canonicalJSON(target.Ports) == canonicalJSON(other.Ports)
	configIdentical := canonicalJSON(target.Config) == canonicalJSON(other.Config)
	targetLowerQuality := moduleQualityScore(target) < moduleQualityScore(other)
	maturityDiffers := moduleQualityScore(target) != moduleQualityScore(other)
	classification := "new_module"
	switch {
	case targetLowerQuality && capOverlap >= 0.90 && portsIdentical && sourceOverlap >= 0.50:
		classification = "reject_duplicate"
	case capOverlap >= 0.90 && portsIdentical && sourceOverlap >= 0.50:
		classification = "duplicate"
	case capOverlap >= 0.70 && adaptersDeclared(target, other) && !portsIdentical:
		classification = "adapter_needed"
	case capOverlap >= 0.70 && (!portsIdentical || !configIdentical):
		classification = "variant"
	case capOverlap >= 0.50 && (dependencyOverlap || sourceOverlap > 0) && maturityDiffers:
		classification = "merge_candidate"
	}
	return registryComparison{ModuleID: target.ID, ComparedModuleID: other.ID, Classification: classification, CapabilityOverlap: capOverlap, SourcePathOverlap: sourceOverlap, PortsIdentical: portsIdentical, ConfigIdentical: configIdentical, DependenciesOverlap: dependencyOverlap}
}

func adaptersDeclared(modules ...moduleComparisonData) bool {
	for _, module := range modules {
		for _, key := range []string{"adapters", "adapterMappings", "portAdapters"} {
			if hasNonEmptyMetadata(module.Manifest[key]) {
				return true
			}
		}
	}
	return false
}

func hasNonEmptyMetadata(v any) bool {
	switch value := v.(type) {
	case []any:
		return len(value) > 0
	case map[string]any:
		return len(value) > 0
	case string:
		return strings.TrimSpace(value) != ""
	default:
		return false
	}
}

func moduleQualityScore(module moduleComparisonData) int {
	score := 0
	if module.TestStatus == "passing" {
		score += 2
	}
	if module.DocsPath != "" {
		score++
	}
	if len(module.Config) > 0 {
		score++
	}
	return score
}

func overlapRatio(a, b []string) float64 {
	union := map[string]bool{}
	for _, item := range a {
		if item = strings.TrimSpace(item); item != "" {
			union[item] = true
		}
	}
	for _, item := range b {
		if item = strings.TrimSpace(item); item != "" {
			union[item] = true
		}
	}
	if len(union) == 0 {
		return 0
	}
	return float64(overlapCount(a, b)) / float64(len(union))
}

func overlapCount(a, b []string) int {
	left := map[string]bool{}
	for _, item := range a {
		if item = strings.TrimSpace(item); item != "" {
			left[item] = true
		}
	}
	count := 0
	seen := map[string]bool{}
	for _, item := range b {
		item = strings.TrimSpace(item)
		if item != "" && left[item] && !seen[item] {
			count++
			seen[item] = true
		}
	}
	return count
}

func canonicalJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func (a *App) handleValidateWorkbenchEdge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SourceModuleID string `json:"sourceModuleId"`
		SourcePort     string `json:"sourcePort"`
		TargetModuleID string `json:"targetModuleId"`
		TargetPort     string `json:"targetPort"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	src, err := getSingle(a.store.DB, `SELECT id,ports_json FROM modules WHERE id=? AND available_in_workbench=1`, req.SourceModuleID)
	if err != nil {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "source module not found"})
		return
	}
	dst, err := getSingle(a.store.DB, `SELECT id,ports_json FROM modules WHERE id=? AND available_in_workbench=1`, req.TargetModuleID)
	if err != nil {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "target module not found"})
		return
	}
	srcType := portType(src["portsJson"], "outputs", req.SourcePort)
	dstType := portType(dst["portsJson"], "inputs", req.TargetPort)
	if srcType == "" || dstType == "" || strings.TrimSpace(srcType) != strings.TrimSpace(dstType) {
		writeErr(w, APIError{Status: 422, Code: "blueprint.port_type_mismatch", Message: "edge connects incompatible port types", Details: map[string]any{"sourceType": srcType, "targetType": dstType}})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "sourceType": srcType, "targetType": dstType})
}

func (a *App) handlePalette(w http.ResponseWriter, r *http.Request) {
	rows, err := a.store.DB.Query(`SELECT * FROM modules WHERE available_in_workbench=1 ORDER BY name`)
	if err != nil {
		writeErr(w, err)
		return
	}
	items, err := scanJSONRows(rows)
	if err != nil {
		writeErr(w, err)
		return
	}
	byName := map[string]map[string]any{}
	out := []map[string]any{}
	for _, item := range items {
		name, _ := item["name"].(string)
		current := byName[name]
		if current == nil || compareSemver(asString(item["version"]), asString(current["version"])) > 0 {
			byName[name] = item
		}
	}
	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		out = append(out, byName[name])
	}
	writeJSON(w, 200, map[string]any{"items": out})
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func compareSemver(a, b string) int {
	ap := semverParts(a)
	bp := semverParts(b)
	for i := range ap {
		if ap[i] > bp[i] {
			return 1
		}
		if ap[i] < bp[i] {
			return -1
		}
	}
	return 0
}

func semverParts(v string) [3]int {
	var out [3]int
	parts := strings.Split(v, ".")
	for i := 0; i < len(parts) && i < len(out); i++ {
		out[i], _ = strconv.Atoi(parts[i])
	}
	return out
}

func (a *App) handleCreateBlueprint(w http.ResponseWriter, r *http.Request) {
	var req BlueprintRequest
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	item, err := a.saveBlueprint("", req)
	one(w, err, 201, item)
}

func (a *App) handleListBlueprints(w http.ResponseWriter, r *http.Request) {
	a.queryRows(w, `SELECT * FROM blueprints ORDER BY created_at DESC`)
}

func (a *App) handleGetBlueprint(w http.ResponseWriter, r *http.Request) {
	item, err := getSingle(a.store.DB, `SELECT * FROM blueprints WHERE id=?`, r.PathValue("blueprintId"))
	one(w, err, 200, item)
}

func (a *App) handleUpdateBlueprint(w http.ResponseWriter, r *http.Request) {
	var req BlueprintRequest
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	item, err := a.saveBlueprint(r.PathValue("blueprintId"), req)
	one(w, err, 200, item)
}

type BlueprintRequest struct {
	Name             string         `json:"name"`
	SemanticDocument map[string]any `json:"semanticDocument"`
	FlowLayout       map[string]any `json:"flowLayout"`
	TargetLanguage   string         `json:"targetLanguage"`
	OutputKind       string         `json:"outputKind"`
	PackageName      string         `json:"packageName"`
}

func (a *App) saveBlueprint(id string, req BlueprintRequest) (map[string]any, error) {
	if id == "" {
		id = newID("bp")
	}
	if req.TargetLanguage == "" {
		req.TargetLanguage = "go"
	}
	if req.OutputKind == "" {
		req.OutputKind = "service"
	}
	root := filepath.Join(a.cfg.DataDir, "blueprints", id)
	sem, err := writeDoc(filepath.Join(root, "semantic.json"), req.SemanticDocument)
	if err != nil {
		return nil, err
	}
	flow, err := writeDoc(filepath.Join(root, "flow-layout.json"), req.FlowLayout)
	if err != nil {
		return nil, err
	}
	ts := now()
	if req.PackageName == "" {
		req.PackageName = "main"
	}
	if !validOutputKind(req.OutputKind) || !packageNameRE.MatchString(req.PackageName) || req.TargetLanguage == "" || len(req.SemanticDocument) == 0 || len(req.FlowLayout) == 0 {
		return nil, APIError{Status: 422, Code: "blueprint.invalid", Message: "blueprint metadata or documents are invalid"}
	}
	if req.Name == "" {
		req.Name = id
	}
	_, existsErr := getSingle(a.store.DB, `SELECT id FROM blueprints WHERE id=?`, id)
	if existsErr == nil {
		_, err = a.store.DB.Exec(`UPDATE blueprints SET name=?, semantic_document_path=?, flow_layout_path=?, target_language=?, output_kind=?, package_name=?, validation_status='not_run', updated_at=? WHERE id=?`, req.Name, sem, flow, req.TargetLanguage, req.OutputKind, req.PackageName, ts, id)
	} else {
		_, err = a.store.DB.Exec(`INSERT INTO blueprints(id,name,semantic_document_path,flow_layout_path,validation_status,target_language,output_kind,package_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, req.Name, sem, flow, "not_run", req.TargetLanguage, req.OutputKind, req.PackageName, ts, ts)
	}
	if err != nil {
		return nil, err
	}
	return getSingle(a.store.DB, `SELECT * FROM blueprints WHERE id=?`, id)
}

func (a *App) handleValidateBlueprint(w http.ResponseWriter, r *http.Request) {
	item, err := a.validateBlueprint(r.PathValue("blueprintId"))
	one(w, err, 200, item)
}

func (a *App) handleWiringJob(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	var status string
	if err := a.store.DB.QueryRow(`SELECT validation_status FROM blueprints WHERE id=?`, r.PathValue("blueprintId")).Scan(&status); err != nil {
		writeErr(w, APIError{Status: 404, Code: "resource.not_found", Message: "blueprint not found"})
		return
	}
	if status != "valid" {
		writeErr(w, APIError{Status: 409, Code: "blueprint.invalid", Message: "blueprint must be valid before wiring"})
		return
	}
	code, job, err := a.QueueJob(r.Context(), "wiring", "blueprint", r.PathValue("blueprintId"), req.Provider)
	one(w, err, code, job)
}

func (a *App) handleListJobs(w http.ResponseWriter, r *http.Request) {
	a.queryRows(w, `SELECT * FROM agent_jobs ORDER BY created_at DESC`)
}

func (a *App) handleGetJob(w http.ResponseWriter, r *http.Request) {
	job, err := getSingle(a.store.DB, `SELECT * FROM agent_jobs WHERE id=?`, r.PathValue("jobId"))
	one(w, err, 200, job)
}

func (a *App) handleOpenJob(w http.ResponseWriter, r *http.Request) {
	job, err := a.Job(r.PathValue("jobId"))
	if err != nil {
		writeErr(w, err)
		return
	}
	provider := a.providers[job.Provider]
	if provider == nil {
		writeErr(w, APIError{Status: 502, Code: "agent_provider.start_failed", Message: "provider unavailable"})
		return
	}
	resp, err := provider.Open(r.Context(), job)
	one(w, err, 200, resp)
}

func (a *App) handleCancelJob(w http.ResponseWriter, r *http.Request) {
	job, err := a.Job(r.PathValue("jobId"))
	if err != nil {
		writeErr(w, err)
		return
	}
	if job.Status != "queued" && job.Status != "running" {
		writeErr(w, APIError{Status: 409, Code: "agent_job.not_running", Message: "only queued or running jobs can be cancelled"})
		return
	}
	if provider := a.providers[job.Provider]; provider != nil {
		if err := provider.Cancel(r.Context(), job); err != nil {
			writeErr(w, APIError{Status: 502, Code: "agent_provider.start_failed", Message: err.Error()})
			return
		}
	}
	_, err = a.store.DB.Exec(`UPDATE agent_jobs SET status='cancelled', finished_at=? WHERE id=?`, now(), job.ID)
	item, getErr := getSingle(a.store.DB, `SELECT * FROM agent_jobs WHERE id=?`, job.ID)
	if err != nil {
		getErr = err
	}
	one(w, getErr, 200, item)
}

func (a *App) validateBlueprint(id string) (map[string]any, error) {
	var semPath, targetLanguage, outputKind, packageName string
	if err := a.store.DB.QueryRow(`SELECT semantic_document_path,target_language,output_kind,package_name FROM blueprints WHERE id=?`, id).Scan(&semPath, &targetLanguage, &outputKind, &packageName); err != nil {
		return nil, APIError{Status: 404, Code: "resource.not_found", Message: "blueprint not found"}
	}
	b, err := os.ReadFile(semPath)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Nodes []struct {
			ID       string         `json:"id"`
			ModuleID string         `json:"moduleId"`
			Config   map[string]any `json:"config"`
		} `json:"nodes"`
		Edges []struct {
			ID           string `json:"id"`
			SourceNodeID string `json:"sourceNodeId"`
			SourcePort   string `json:"sourcePort"`
			TargetNodeID string `json:"targetNodeId"`
			TargetPort   string `json:"targetPort"`
		} `json:"edges"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, APIError{Status: 422, Code: "blueprint.invalid", Message: "semantic blueprint JSON is malformed"}
	}
	issues := []map[string]string{}
	if targetLanguage == "" {
		issues = append(issues, map[string]string{"code": "target_language_required", "message": "targetLanguage is required"})
	}
	if !validOutputKind(outputKind) {
		issues = append(issues, map[string]string{"code": "output_kind_invalid", "message": outputKind})
	}
	if !packageNameRE.MatchString(packageName) {
		issues = append(issues, map[string]string{"code": "package_name_invalid", "message": packageName})
	}
	nodeModules := map[string]map[string]any{}
	nodeConfigs := map[string]map[string]any{}
	incoming := map[string]bool{}
	for _, e := range doc.Edges {
		incoming[e.TargetNodeID+"."+e.TargetPort] = true
	}
	seen := map[string]bool{}
	for _, n := range doc.Nodes {
		if n.ID == "" || n.ModuleID == "" {
			issues = append(issues, map[string]string{"code": "node_invalid", "message": n.ID})
			continue
		}
		if seen[n.ID] {
			issues = append(issues, map[string]string{"code": "duplicate_node_id", "message": n.ID})
		}
		seen[n.ID] = true
		mod, err := getSingle(a.store.DB, `SELECT id,ports_json,config_schema_path FROM modules WHERE id=?`, n.ModuleID)
		if err != nil {
			issues = append(issues, map[string]string{"code": "module_missing", "message": n.ModuleID})
			continue
		}
		nodeModules[n.ID] = mod
		nodeConfigs[n.ID] = n.Config
		for _, port := range portsFor(mod["portsJson"], "inputs") {
			if required, _ := port["required"].(bool); required {
				name, _ := port["name"].(string)
				if !incoming[n.ID+"."+name] {
					issues = append(issues, map[string]string{"code": "required_input_unconnected", "message": n.ID + "." + name})
				}
			}
		}
		configSchemaPath, _ := mod["configSchemaPath"].(string)
		if missing := missingRequiredConfig(configSchemaPath, n.Config); len(missing) > 0 {
			issues = append(issues, map[string]string{"code": "required_config_missing", "message": n.ID + ": " + strings.Join(missing, ",")})
		}
	}
	for _, e := range doc.Edges {
		src, ok1 := nodeModules[e.SourceNodeID]
		dst, ok2 := nodeModules[e.TargetNodeID]
		if !ok1 || !ok2 {
			issues = append(issues, map[string]string{"code": "edge_node_missing", "message": e.ID})
			continue
		}
		srcType := portType(src["portsJson"], "outputs", e.SourcePort)
		dstType := portType(dst["portsJson"], "inputs", e.TargetPort)
		if srcType == "" || dstType == "" {
			issues = append(issues, map[string]string{"code": "port_missing", "message": e.ID})
			continue
		}
		if strings.TrimSpace(srcType) != strings.TrimSpace(dstType) {
			return nil, APIError{Status: 422, Code: "blueprint.port_type_mismatch", Message: "edge connects incompatible port types", Details: map[string]any{"edgeId": e.ID, "sourceType": srcType, "targetType": dstType}}
		}
		_ = nodeConfigs
	}
	status := "valid"
	if len(issues) > 0 {
		status = "invalid"
	}
	report := map[string]any{"status": status, "issues": issues}
	reportPath, err := writeDoc(filepath.Join(a.cfg.DataDir, "blueprints", id, "validation-report.json"), report)
	if err != nil {
		return nil, err
	}
	_, err = a.store.DB.Exec(`UPDATE blueprints SET validation_status=?, validation_report_path=?, updated_at=? WHERE id=?`, status, reportPath, now(), id)
	if err != nil {
		return nil, err
	}
	item, err := getSingle(a.store.DB, `SELECT * FROM blueprints WHERE id=?`, id)
	if err != nil {
		return nil, err
	}
	item["validationReport"] = report
	return item, nil
}

func portType(portsAny any, direction, name string) string {
	for _, m := range portsFor(portsAny, direction) {
		if m["name"] == name {
			s, _ := m["type"].(string)
			return s
		}
	}
	return ""
}

func portsFor(portsAny any, direction string) []map[string]any {
	ports, ok := portsAny.(map[string]any)
	if !ok {
		return nil
	}
	arr, _ := ports[direction].([]any)
	out := make([]map[string]any, 0, len(arr))
	for _, item := range arr {
		m, _ := item.(map[string]any)
		if m != nil {
			out = append(out, m)
		}
	}
	return out
}

func validatePorts(ports map[string]any) error {
	for _, direction := range []string{"inputs", "outputs"} {
		raw, ok := ports[direction]
		if !ok {
			return APIError{Status: 422, Code: "module_output.invalid", Message: "ports must include inputs and outputs"}
		}
		items, ok := raw.([]any)
		if !ok {
			return APIError{Status: 422, Code: "module_output.invalid", Message: "ports must be arrays"}
		}
		if len(items) == 0 {
			return APIError{Status: 422, Code: "module_output.invalid", Message: "ports must include at least one input and output"}
		}
		for _, item := range items {
			port, ok := item.(map[string]any)
			if !ok {
				return APIError{Status: 422, Code: "module_output.invalid", Message: "port must be an object"}
			}
			name, _ := port["name"].(string)
			typ, _ := port["type"].(string)
			if !portNameRE.MatchString(name) || !portTypeRE.MatchString(typ) {
				return APIError{Status: 422, Code: "module_output.invalid", Message: "port name or type is invalid"}
			}
		}
	}
	return nil
}

func missingRequiredConfig(path string, config map[string]any) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return []string{"config_schema_unreadable"}
	}
	var schema struct {
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(b, &schema); err != nil {
		return []string{"config_schema_invalid"}
	}
	missing := []string{}
	for _, key := range schema.Required {
		if _, ok := config[key]; !ok {
			missing = append(missing, key)
		}
	}
	return missing
}

func validOutputKind(kind string) bool {
	switch kind {
	case "service", "cli", "daemon", "worker", "library":
		return true
	default:
		return false
	}
}

func (a *App) importCandidateReport(ctx context.Context, job Job) error {
	path := filepath.Join(a.cfg.DataDir, "jobs", job.ID, "candidate-report.json")
	b, err := os.ReadFile(path)
	if err != nil {
		return APIError{Status: 422, Code: "candidate_report.invalid", Message: "candidate report is missing"}
	}
	var report struct {
		Candidates []struct {
			ProposedName      string         `json:"proposedName"`
			Description       string         `json:"description"`
			ModuleKind        string         `json:"moduleKind"`
			TargetLanguage    string         `json:"targetLanguage"`
			Confidence        string         `json:"confidence"`
			ExtractionRisk    string         `json:"extractionRisk"`
			SourcePaths       []string       `json:"sourcePaths"`
			ReusableRationale string         `json:"reusableRationale"`
			CouplingNotes     string         `json:"couplingNotes"`
			Dependencies      []string       `json:"dependencies"`
			SideEffects       []string       `json:"sideEffects"`
			TestsFound        []string       `json:"testsFound"`
			MissingTests      []string       `json:"missingTests"`
			Ports             map[string]any `json:"ports"`
			WorkbenchNode     map[string]any `json:"workbenchNode"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(b, &report); err != nil {
		return APIError{Status: 422, Code: "candidate_report.invalid", Message: "candidate report JSON is invalid"}
	}
	if len(report.Candidates) == 0 {
		return APIError{Status: 422, Code: "candidate_report.invalid", Message: "candidate report has no candidates"}
	}
	return storage.WithTx(ctx, a.store.DB, func(tx *sql.Tx) error {
		for i, c := range report.Candidates {
			if c.ProposedName == "" || c.Description == "" || c.ModuleKind == "" || c.TargetLanguage == "" || c.Confidence == "" || c.ExtractionRisk == "" || len(c.SourcePaths) == 0 || c.ReusableRationale == "" || c.CouplingNotes == "" || c.Dependencies == nil || c.SideEffects == nil || c.TestsFound == nil || c.MissingTests == nil || len(c.Ports) == 0 || len(c.WorkbenchNode) == 0 {
				return APIError{Status: 422, Code: "candidate_report.invalid", Message: "candidate report missing required fields"}
			}
			if c.Confidence != "low" && c.Confidence != "medium" && c.Confidence != "high" {
				return APIError{Status: 422, Code: "candidate_report.invalid", Message: "candidate confidence is invalid"}
			}
			if c.ExtractionRisk != "low" && c.ExtractionRisk != "medium" && c.ExtractionRisk != "high" {
				return APIError{Status: 422, Code: "candidate_report.invalid", Message: "candidate extraction risk is invalid"}
			}
			if err := validatePorts(c.Ports); err != nil {
				return APIError{Status: 422, Code: "candidate_report.invalid", Message: "candidate port contract is invalid"}
			}
			var repoID string
			if err := tx.QueryRow(`SELECT repository_id FROM repo_sessions WHERE id=?`, job.SubjectID).Scan(&repoID); err != nil {
				return err
			}
			id := fmt.Sprintf("%s.cand.%03d", job.SubjectID, i+1)
			ts := now()
			_, err := tx.Exec(`INSERT OR REPLACE INTO candidates(id,session_id,repository_id,proposed_name,description,module_kind,target_language,confidence,extraction_risk,status,source_paths_json,reusable_rationale,coupling_notes,dependencies_json,side_effects_json,tests_found_json,missing_tests_json,ports_json,workbench_node_json,report_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, job.SubjectID, repoID, c.ProposedName, c.Description, c.ModuleKind, c.TargetLanguage, c.Confidence, c.ExtractionRisk, "proposed", jsonText(c.SourcePaths), c.ReusableRationale, c.CouplingNotes, jsonText(c.Dependencies), jsonText(c.SideEffects), jsonText(c.TestsFound), jsonText(c.MissingTests), jsonText(c.Ports), jsonText(c.WorkbenchNode), path, ts, ts)
			if err != nil {
				return err
			}
		}
		_, err := tx.Exec(`UPDATE repo_sessions SET phase='candidates_ready', candidate_report_path=?, updated_at=? WHERE id=?`, path, now(), job.SubjectID)
		return err
	})
}

