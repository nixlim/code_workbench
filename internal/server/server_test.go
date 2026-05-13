package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"code_workbench/internal/config"
)

func newTestApp(t *testing.T) (*App, string) {
	t.Helper()
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	app, err := New(context.Background(), config.Config{
		Host:            "127.0.0.1",
		Port:            0,
		DataDir:         filepath.Join(root, "data"),
		AllowedRoots:    []string{root},
		EnableFake:      true,
		AnalysisLimit:   4,
		ExtractionLimit: 2,
		WiringLimit:     1,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	return app, repo
}

func doJSON(t *testing.T, app *App, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var rbody *bytes.Reader
	if body == nil {
		rbody = bytes.NewReader([]byte(`{}`))
	} else {
		b, _ := json.Marshal(body)
		rbody = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rbody)
	res := httptest.NewRecorder()
	app.Handler().ServeHTTP(res, req)
	var out map[string]any
	_ = json.Unmarshal(res.Body.Bytes(), &out)
	return res.Code, out
}

type failingCancelProvider struct {
	FakeProvider
}

func (failingCancelProvider) Cancel(context.Context, Job) error {
	return errors.New("cancel failed")
}

func TestRepositorySessionCandidateExtractionSmoke(t *testing.T) {
	app, repoPath := newTestApp(t)
	code, repo := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath})
	if code != 201 {
		t.Fatalf("create repo status=%d body=%v", code, repo)
	}
	code, dup := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath})
	if code != 409 || dup["error"].(map[string]any)["code"] != "repository.duplicate" {
		t.Fatalf("duplicate repo status=%d body=%v", code, dup)
	}
	code, unknown := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath, "unexpected": true})
	if code != 400 || unknown["error"].(map[string]any)["code"] != "request.unknown_field" {
		t.Fatalf("unknown field status=%d body=%v", code, unknown)
	}
	repoID := repo["id"].(string)
	checkoutPath := repo["sourceCheckoutPath"].(string)
	if filepath.Base(filepath.Dir(checkoutPath)) != ".sources" {
		t.Fatalf("repository checkout not stored under .sources: %s", checkoutPath)
	}
	if _, err := os.Stat(filepath.Join(checkoutPath, "README.md")); err != nil {
		t.Fatalf("source checkout missing README: %v", err)
	}
	stalePath := filepath.Join(checkoutPath, "STALE.txt")
	if err := os.WriteFile(stalePath, []byte("old checkout marker"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, rescanned := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath, "rescan": true})
	if code != 201 {
		t.Fatalf("rescan repo status=%d body=%v", code, rescanned)
	}
	if rescanned["sourceCheckoutPath"] != checkoutPath {
		t.Fatalf("rescan changed canonical checkout path: %v vs %v", rescanned["sourceCheckoutPath"], checkoutPath)
	}
	if _, err := os.Stat(stalePath); !os.IsNotExist(err) {
		t.Fatalf("rescan did not replace stale checkout file: %v", err)
	}
	code, session := doJSON(t, app, http.MethodPost, "/api/sessions", map[string]any{"repositoryId": repoID})
	if code != 201 || session["phase"] != "awaiting_user_intent" {
		t.Fatalf("create session status=%d body=%v", code, session)
	}
	if session["checkoutPath"] != checkoutPath {
		t.Fatalf("session did not use canonical source checkout: %v vs %v", session["checkoutPath"], checkoutPath)
	}
	sessionID := session["id"].(string)
	code, _ = doJSON(t, app, http.MethodPost, "/api/sessions/"+sessionID+"/analysis-jobs", map[string]any{"provider": "fake"})
	if code != 409 {
		t.Fatalf("analysis without intent status=%d", code)
	}
	code, session = doJSON(t, app, http.MethodPost, "/api/sessions/"+sessionID+"/intent", map[string]any{"specificFunctionality": "config", "allowAgentDiscovery": true, "expectedUpdatedAt": session["updatedAt"]})
	if code != 200 || session["phase"] != "ready_for_analysis" {
		t.Fatalf("intent status=%d body=%v", code, session)
	}
	code, job := doJSON(t, app, http.MethodPost, "/api/sessions/"+sessionID+"/analysis-jobs", map[string]any{"provider": "fake"})
	if code != 202 {
		t.Fatalf("queue analysis status=%d body=%v", code, job)
	}
	jobID := job["id"].(string)
	if job["promptPath"] != filepath.Join(app.cfg.DataDir, "jobs", jobID, "prompt.md") {
		t.Fatalf("prompt path=%v", job["promptPath"])
	}
	promptBytes, err := os.ReadFile(job["promptPath"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(promptBytes), "Prioritize reusable candidates") || !strings.Contains(string(promptBytes), "config") {
		t.Fatalf("prompt did not include user intent:\n%s", string(promptBytes))
	}
	code, session = doJSON(t, app, http.MethodGet, "/api/sessions/"+sessionID, nil)
	if code != 200 || session["phase"] != "analysing" {
		t.Fatalf("queued analysis did not enter analysing phase status=%d body=%v", code, session)
	}
	if err := app.CompleteJob(context.Background(), jobID, 0, ""); err != nil {
		t.Fatal(err)
	}
	code, session = doJSON(t, app, http.MethodGet, "/api/sessions/"+sessionID, nil)
	if code != 200 || session["phase"] != "awaiting_approval" {
		t.Fatalf("candidate import did not enter awaiting_approval phase status=%d body=%v", code, session)
	}
	code, candidates := doJSON(t, app, http.MethodGet, "/api/candidates", nil)
	if code != 200 || len(candidates["items"].([]any)) != 1 {
		t.Fatalf("candidates status=%d body=%v", code, candidates)
	}
	candidate := candidates["items"].([]any)[0].(map[string]any)
	if candidate["id"] != sessionID+".cand.001" {
		t.Fatalf("candidate id not namespaced: %v", candidate["id"])
	}
	code, _ = doJSON(t, app, http.MethodPost, "/api/extraction-plans", map[string]any{"sessionId": sessionID, "approvedCandidateIds": []string{candidate["id"].(string)}})
	if code != 409 {
		t.Fatalf("unapproved extraction plan status=%d", code)
	}
	code, approved := doJSON(t, app, http.MethodPost, "/api/candidates/"+candidate["id"].(string)+"/approve", map[string]any{"reason": "useful module"})
	if code != 200 || approved["status"] != "approved" {
		t.Fatalf("approve status=%d body=%v", code, approved)
	}
	code, plan := doJSON(t, app, http.MethodPost, "/api/extraction-plans", map[string]any{"sessionId": sessionID, "approvedCandidateIds": []string{candidate["id"].(string)}, "rejectedCandidateIds": []string{"old"}})
	if code != 201 || plan["status"] != "ready" {
		t.Fatalf("plan status=%d body=%v", code, plan)
	}
	planID := plan["id"].(string)
	code, extractionJob := doJSON(t, app, http.MethodPost, "/api/extraction-plans/"+planID+"/jobs", map[string]any{"provider": "fake"})
	if code != 202 {
		t.Fatalf("extraction job status=%d body=%v", code, extractionJob)
	}
	extractionPrompt, err := os.ReadFile(extractionJob["promptPath"].(string))
	if err != nil {
		t.Fatal(err)
	}
	promptText := string(extractionPrompt)
	if !strings.Contains(promptText, candidate["id"].(string)) {
		t.Fatalf("extraction prompt does not include approved candidate ID:\n%s", promptText)
	}
	if !strings.Contains(promptText, "old") {
		t.Fatalf("extraction prompt does not include rejected candidate ID:\n%s", promptText)
	}
	if !strings.Contains(promptText, "Do not read or write outside") {
		t.Fatalf("extraction prompt does not include denied path rules:\n%s", promptText)
	}
	if !strings.Contains(promptText, "Output contract") {
		t.Fatalf("extraction prompt does not include output contract:\n%s", promptText)
	}
	if !strings.Contains(promptText, "target language: go") {
		t.Fatalf("extraction prompt does not include candidate target language:\n%s", promptText)
	}
	if !strings.Contains(promptText, "For non-Go source candidates") {
		t.Fatalf("extraction prompt does not require non-Go conversion:\n%s", promptText)
	}
	code, inspected := doJSON(t, app, http.MethodGet, "/api/agent-jobs/"+extractionJob["id"].(string), nil)
	if code != 200 {
		t.Fatalf("inspect extraction job status=%d body=%v", code, inspected)
	}
	prompt := inspected["prompt"].(map[string]any)
	if !strings.Contains(prompt["content"].(string), candidate["id"].(string)) {
		t.Fatalf("job inspector prompt missing approved candidate ID: %v", prompt)
	}
	transcript := inspected["transcript"].(map[string]any)
	if !strings.Contains(transcript["content"].(string), "fake provider started") {
		t.Fatalf("job inspector transcript missing provider output: %v", transcript)
	}
	if metrics := inspected["metrics"].(map[string]any); metrics["promptBytes"] == nil || metrics["transcriptBytes"] == nil {
		t.Fatalf("job inspector metrics missing prompt/transcript bytes: %v", metrics)
	}
	readRoot := filepath.Join(app.cfg.DataDir, "jobs", extractionJob["id"].(string), "workspace", "read")
	if _, err := os.Stat(filepath.Join(readRoot, "repo", "README.md")); err != nil {
		t.Fatalf("extraction read root missing source checkout: %v", err)
	}
	candidateMetadata, err := os.ReadFile(filepath.Join(readRoot, "candidates.json"))
	if err != nil {
		t.Fatalf("extraction read root missing candidate metadata: %v", err)
	}
	if !strings.Contains(string(candidateMetadata), candidate["id"].(string)) || !strings.Contains(string(candidateMetadata), `"targetLanguage": "go"`) {
		t.Fatalf("candidate metadata missing approved candidate target language: %s", string(candidateMetadata))
	}
	code, missingPlan := doJSON(t, app, http.MethodPost, "/api/extraction-plans/missing/jobs", map[string]any{"provider": "fake"})
	if code != 404 || missingPlan["error"].(map[string]any)["code"] != "resource.not_found" {
		t.Fatalf("missing extraction plan job status=%d body=%v", code, missingPlan)
	}
	code, source := doJSON(t, app, http.MethodGet, "/api/sessions/"+sessionID+"/files?path=README.md", nil)
	if code != 200 || source["content"] != "hello" {
		t.Fatalf("source status=%d body=%v", code, source)
	}
	code, escaped := doJSON(t, app, http.MethodGet, "/api/sessions/"+sessionID+"/files?path=../README.md", nil)
	if code != 400 || escaped["error"].(map[string]any)["code"] != "path.invalid" {
		t.Fatalf("escape status=%d body=%v", code, escaped)
	}
	code, absolute := doJSON(t, app, http.MethodGet, "/api/sessions/"+sessionID+"/files?path=/etc/passwd", nil)
	if code != 400 || absolute["error"].(map[string]any)["code"] != "path.invalid" {
		t.Fatalf("absolute status=%d body=%v", code, absolute)
	}
	code, backslash := doJSON(t, app, http.MethodGet, "/api/sessions/"+sessionID+"/files?path=dir%5Cfile.go", nil)
	if code != 400 || backslash["error"].(map[string]any)["code"] != "path.invalid" {
		t.Fatalf("backslash status=%d body=%v", code, backslash)
	}
}

func TestServerLogAppendsAPIErrorDetails(t *testing.T) {
	app, _ := newTestApp(t)
	code, body := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": filepath.Join(t.TempDir(), "outside")})
	if code != 400 || body["error"].(map[string]any)["code"] != "path.invalid" {
		t.Fatalf("outside root status=%d body=%v", code, body)
	}
	logPath := filepath.Join(app.cfg.DataDir, "server.log")
	first, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("server.log was not written: %v", err)
	}
	if !strings.Contains(string(first), `"kind":"api_request"`) || !strings.Contains(string(first), "path.invalid") {
		t.Fatalf("server.log missing API error details: %s", string(first))
	}
	code, _ = doJSON(t, app, http.MethodGet, "/api/config", nil)
	if code != 200 {
		t.Fatalf("config status=%d", code)
	}
	second, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("server.log unreadable after second request: %v", err)
	}
	if len(second) <= len(first) {
		t.Fatalf("server.log did not append; before=%d after=%d", len(first), len(second))
	}
}

func TestClearPreviousSessionsKeepsSelectedSession(t *testing.T) {
	app, repoPath := newTestApp(t)
	_, repo := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath})
	_, oldSession := doJSON(t, app, http.MethodPost, "/api/sessions", map[string]any{"repositoryId": repo["id"]})
	_, currentSession := doJSON(t, app, http.MethodPost, "/api/sessions", map[string]any{"repositoryId": repo["id"]})
	oldID := oldSession["id"].(string)
	currentID := currentSession["id"].(string)
	oldRoot := filepath.Dir(oldSession["scratchPath"].(string))
	if err := os.WriteFile(filepath.Join(oldRoot, "marker.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	ts := now()
	_, err := app.store.DB.Exec(`INSERT INTO agent_jobs(id,role,provider,status,subject_type,subject_id,prompt_path,timeout_seconds,created_at,started_at,finished_at) VALUES('old_session_job','repo_analysis','fake','succeeded','session',?,'prompt',1800,?,?,?)`, oldID, ts, ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	code, result := doJSON(t, app, http.MethodDelete, "/api/sessions?keepSessionId="+currentID, nil)
	if code != 200 || result["deleted"] != float64(1) || result["retained"] != float64(1) {
		t.Fatalf("clear sessions status=%d body=%v", code, result)
	}
	code, oldBody := doJSON(t, app, http.MethodGet, "/api/sessions/"+oldID, nil)
	if code != 404 || oldBody["error"].(map[string]any)["code"] != "resource.not_found" {
		t.Fatalf("old session still visible status=%d body=%v", code, oldBody)
	}
	code, currentBody := doJSON(t, app, http.MethodGet, "/api/sessions/"+currentID, nil)
	if code != 200 || currentBody["id"] != currentID {
		t.Fatalf("current session not retained status=%d body=%v", code, currentBody)
	}
	if _, err := os.Stat(oldRoot); !os.IsNotExist(err) {
		t.Fatalf("old session files not removed: %v", err)
	}
	var jobCount int
	if err := app.store.DB.QueryRow(`SELECT COUNT(*) FROM agent_jobs WHERE subject_id=?`, oldID).Scan(&jobCount); err != nil {
		t.Fatal(err)
	}
	if jobCount != 0 {
		t.Fatalf("old session jobs not removed: %d", jobCount)
	}
}

func TestModuleBlueprintAndWiringFlow(t *testing.T) {
	app, repoPath := newTestApp(t)
	_, repo := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath})
	_, session := doJSON(t, app, http.MethodPost, "/api/sessions", map[string]any{"repositoryId": repo["id"]})
	sessionID := session["id"].(string)
	candID := sessionID + ".cand.001"
	candID2 := sessionID + ".cand.002"
	ts := now()
	_, err := app.store.DB.Exec(`INSERT INTO candidates(id,session_id,repository_id,proposed_name,description,module_kind,target_language,confidence,extraction_risk,status,source_paths_json,ports_json,workbench_node_json,report_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, candID, sessionID, repo["id"], "stream", "stream module", "library", "go", "high", "low", "extracted", `["README.md"]`, `{"inputs":[{"name":"in","type":"Message","required":false}],"outputs":[{"name":"out","type":"Message"}]}`, `{}`, "report.json", ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	_, err = app.store.DB.Exec(`INSERT INTO candidates(id,session_id,repository_id,proposed_name,description,module_kind,target_language,confidence,extraction_risk,status,source_paths_json,ports_json,workbench_node_json,report_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, candID2, sessionID, repo["id"], "stream", "stream module", "library", "go", "high", "low", "extracted", `["README.md"]`, `{"inputs":[{"name":"in","type":"Message","required":false}],"outputs":[{"name":"out","type":"Message"}]}`, `{}`, "report.json", ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	planPath, err := writeDoc(filepath.Join(app.cfg.DataDir, "documents", "test-plan.json"), map[string]any{"approvedCandidateIds": []string{candID}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = app.store.DB.Exec(`INSERT INTO extraction_plans(id,session_id,repository_id,status,plan_path,approved_candidate_ids_json,rejected_candidate_ids_json,created_at,updated_at) VALUES('plan',?,?,?,?,?,?,?,?)`, sessionID, repo["id"], "ready", planPath, jsonText([]string{candID, candID2}), jsonText([]string{}), ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	extractOut := filepath.Join(app.cfg.DataDir, "jobs", "extract_job", "output")
	if err := os.MkdirAll(filepath.Join(extractOut, "module"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"module/source.go", "module/source_test.go"} {
		if err := os.WriteFile(filepath.Join(extractOut, rel), []byte("package module\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_, err = app.store.DB.Exec(`INSERT INTO agent_jobs(id,role,provider,status,subject_type,subject_id,prompt_path,output_artifact_path,timeout_seconds,created_at,started_at,finished_at) VALUES('extract_job','extraction','fake','succeeded','extraction_plan','plan','prompt',?,3600,?,?,?)`, extractOut, ts, ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	moduleReq := map[string]any{
		"name": "stream", "sourceRepositoryId": repo["id"], "sourceSessionId": sessionID, "sourceCandidateId": candID,
		"language": "go", "moduleKind": "library", "importPath": "example.com/stream", "capabilities": []string{"stream"},
		"ports":        map[string]any{"inputs": []map[string]any{{"name": "in", "type": "Message", "required": false}}, "outputs": []map[string]any{{"name": "out", "type": "Message"}}},
		"configSchema": map[string]any{"type": "object"}, "docs": "docs", "testStatus": "passing",
		"extractionJobId": "extract_job", "sourceFiles": []string{"module/source.go"}, "testFiles": []string{"module/source_test.go"},
		"manifest": map[string]any{"moduleKind": "library"}, "provenance": map[string]any{"candidateId": candID, "extractionJobId": "extract_job"},
	}
	code, mod := doJSON(t, app, http.MethodPost, "/api/modules", moduleReq)
	if code != 201 || mod["availableInWorkbench"] != float64(1) {
		t.Fatalf("module status=%d body=%v", code, mod)
	}
	moduleReq["sourceCandidateId"] = candID2
	code, mod2 := doJSON(t, app, http.MethodPost, "/api/modules", moduleReq)
	if code != 201 || mod2["version"] != "0.2.0" {
		t.Fatalf("module v2 status=%d body=%v", code, mod2)
	}
	code, palette := doJSON(t, app, http.MethodGet, "/api/workbench/palette", nil)
	if code != 200 || len(palette["items"].([]any)) != 1 || palette["items"].([]any)[0].(map[string]any)["version"] != "0.2.0" {
		t.Fatalf("palette status=%d body=%v", code, palette)
	}
	code, comparison := doJSON(t, app, http.MethodPost, "/api/modules/"+mod2["id"].(string)+"/compare", map[string]any{})
	if code != 200 || comparison["classification"] != "duplicate" {
		t.Fatalf("compare status=%d body=%v", code, comparison)
	}
	code, badCompare := doJSON(t, app, http.MethodPost, "/api/modules/"+mod2["id"].(string)+"/compare", map[string]any{"lowerQualityDuplicate": true})
	if code != 400 {
		t.Fatalf("caller-controlled compare flag status=%d body=%v", code, badCompare)
	}
	semantic := map[string]any{"nodes": []map[string]any{{"id": "a", "moduleId": mod2["id"]}, {"id": "b", "moduleId": mod2["id"]}}, "edges": []map[string]any{{"id": "e1", "sourceNodeId": "a", "sourcePort": "out", "targetNodeId": "b", "targetPort": "in"}}}
	code, bp := doJSON(t, app, http.MethodPost, "/api/blueprints", map[string]any{"name": "bp", "semanticDocument": semantic, "flowLayout": map[string]any{"nodes": []any{}, "edges": []any{}}, "targetLanguage": "go", "outputKind": "service", "packageName": "main"})
	if code != 201 {
		t.Fatalf("blueprint status=%d body=%v", code, bp)
	}
	code, validated := doJSON(t, app, http.MethodPost, "/api/blueprints/"+bp["id"].(string)+"/validate", nil)
	if code != 200 || validated["validationStatus"] != "valid" {
		t.Fatalf("validate status=%d body=%v", code, validated)
	}
	code, job := doJSON(t, app, http.MethodPost, "/api/blueprints/"+bp["id"].(string)+"/wiring-jobs", map[string]any{"provider": "fake"})
	if code != 202 || job["role"] != "wiring" {
		t.Fatalf("wiring status=%d body=%v", code, job)
	}
	code, opened := doJSON(t, app, http.MethodPost, "/api/agent-jobs/"+job["id"].(string)+"/open", nil)
	if code != 200 || opened["tmuxSessionName"] == "" {
		t.Fatalf("open status=%d body=%v", code, opened)
	}
}

func TestPaletteSelectsHighestSemverVersion(t *testing.T) {
	app, repoPath := newTestApp(t)
	_, repo := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath})
	_, session := doJSON(t, app, http.MethodPost, "/api/sessions", map[string]any{"repositoryId": repo["id"]})
	repoID := repo["id"].(string)
	sessionID := session["id"].(string)
	ts := now()
	_, err := app.store.DB.Exec(`INSERT INTO candidates(id,session_id,repository_id,proposed_name,description,module_kind,target_language,confidence,extraction_risk,status,source_paths_json,ports_json,workbench_node_json,report_path,created_at,updated_at) VALUES('cand',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, sessionID, repoID, "semver", "semver module", "library", "go", "high", "low", "registered", `["README.md"]`, `{"inputs":[],"outputs":[{"name":"out","type":"Message"}]}`, `{}`, "report.json", ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		id      string
		version string
	}{
		{"semver_low", "0.9.0"},
		{"semver_high", "0.10.0"},
	} {
		_, err := app.store.DB.Exec(`INSERT INTO modules(id,name,version,source_repository_id,source_session_id,source_candidate_id,language,module_kind,import_path,capabilities_json,ports_json,config_schema_path,manifest_path,docs_path,test_status,available_in_workbench,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, item.id, "semver", item.version, repoID, sessionID, "cand", "go", "library", "example.com/semver", `["semver"]`, `{"inputs":[],"outputs":[{"name":"out","type":"Message"}]}`, "config.json", "manifest.json", "docs.json", "passing", 1, ts, ts)
		if err != nil {
			t.Fatal(err)
		}
	}
	code, palette := doJSON(t, app, http.MethodGet, "/api/workbench/palette", nil)
	if code != 200 {
		t.Fatalf("palette status=%d body=%v", code, palette)
	}
	items := palette["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["version"] != "0.10.0" {
		t.Fatalf("palette did not select highest semver: %v", palette)
	}
}

func TestSpecEnrichmentAndCompositionWorkflow(t *testing.T) {
	app, repoPath := newTestApp(t)
	_, repo := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath})
	_, session := doJSON(t, app, http.MethodPost, "/api/sessions", map[string]any{"repositoryId": repo["id"]})
	repoID := repo["id"].(string)
	sessionID := session["id"].(string)
	ts := now()
	_, err := app.store.DB.Exec(`INSERT INTO candidates(id,session_id,repository_id,proposed_name,description,module_kind,target_language,confidence,extraction_risk,status,source_paths_json,ports_json,workbench_node_json,report_path,created_at,updated_at) VALUES('cand_enrich',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, sessionID, repoID, "registry-helper", "registry module", "library", "go", "high", "low", "registered", `["README.md"]`, `{"inputs":[{"name":"in","type":"Message"}],"outputs":[{"name":"out","type":"Message"}]}`, `{}`, "report.json", ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	_, err = app.store.DB.Exec(`INSERT INTO modules(id,name,version,source_repository_id,source_session_id,source_candidate_id,language,module_kind,import_path,capabilities_json,ports_json,config_schema_path,manifest_path,docs_path,test_status,available_in_workbench,created_at,updated_at) VALUES('mod_enrich','registry-helper','0.1.0',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, repoID, sessionID, "cand_enrich", "go", "library", "example.com/registry", `["registry"]`, `{"inputs":[{"name":"in","type":"Message"}],"outputs":[{"name":"out","type":"Message"}]}`, "config.json", "manifest.json", "docs.json", "passing", 1, ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	specPath := filepath.Join(filepath.Dir(repoPath), "feature-spec.md")
	if err := os.WriteFile(specPath, []byte("# Feature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, enrichment := doJSON(t, app, http.MethodPost, "/api/spec-enrichments", map[string]any{"specPath": specPath})
	if code != 201 || enrichment["status"] != "created" {
		t.Fatalf("enrichment create status=%d body=%v", code, enrichment)
	}
	code, enrichJob := doJSON(t, app, http.MethodPost, "/api/spec-enrichments/"+enrichment["id"].(string)+"/jobs", map[string]any{"provider": "fake"})
	if code != 202 || enrichJob["role"] != "spec_enrichment" {
		t.Fatalf("enrichment job status=%d body=%v", code, enrichJob)
	}
	if err := app.CompleteJob(context.Background(), enrichJob["id"].(string), 0, ""); err != nil {
		t.Fatal(err)
	}
	code, enrichment = doJSON(t, app, http.MethodGet, "/api/spec-enrichments/"+enrichment["id"].(string), nil)
	if code != 200 || enrichment["status"] != "succeeded" {
		t.Fatalf("enrichment complete status=%d body=%v", code, enrichment)
	}
	enriched, err := os.ReadFile(enrichment["outputPath"].(string))
	if err != nil || !strings.Contains(string(enriched), "## Registry References") || !strings.Contains(string(enriched), "registry-helper@0.1.0") {
		t.Fatalf("enriched spec missing registry references err=%v content=%s", err, string(enriched))
	}
	code, comp := doJSON(t, app, http.MethodPost, "/api/compositions", map[string]any{"intent": "wire registry helper", "selectedModuleIds": []string{"mod_enrich"}, "flowLayout": map[string]any{"nodes": []any{}, "edges": []any{}}})
	if code != 201 || comp["status"] != "draft" {
		t.Fatalf("composition create status=%d body=%v", code, comp)
	}
	code, compileEarly := doJSON(t, app, http.MethodPost, "/api/compositions/"+comp["id"].(string)+"/compile-jobs", map[string]any{"provider": "fake"})
	if code != 409 {
		t.Fatalf("compile before answers status=%d body=%v", code, compileEarly)
	}
	code, clarifyJob := doJSON(t, app, http.MethodPost, "/api/compositions/"+comp["id"].(string)+"/clarification-jobs", map[string]any{"provider": "fake"})
	if code != 202 || clarifyJob["role"] != "composition_clarifier" {
		t.Fatalf("clarify job status=%d body=%v", code, clarifyJob)
	}
	if err := app.CompleteJob(context.Background(), clarifyJob["id"].(string), 0, ""); err != nil {
		t.Fatal(err)
	}
	code, comp = doJSON(t, app, http.MethodPost, "/api/compositions/"+comp["id"].(string)+"/answers", map[string]any{"answers": map[string]string{"goal": "service composition"}})
	if code != 200 || comp["status"] != "ready_to_compile" {
		t.Fatalf("answers status=%d body=%v", code, comp)
	}
	code, compileJob := doJSON(t, app, http.MethodPost, "/api/compositions/"+comp["id"].(string)+"/compile-jobs", map[string]any{"provider": "fake"})
	if code != 202 || compileJob["role"] != "blueprint_compiler" {
		t.Fatalf("compile job status=%d body=%v", code, compileJob)
	}
	if err := app.CompleteJob(context.Background(), compileJob["id"].(string), 0, ""); err != nil {
		t.Fatal(err)
	}
	code, comp = doJSON(t, app, http.MethodGet, "/api/compositions/"+comp["id"].(string), nil)
	if code != 200 || comp["status"] != "compiled" || comp["blueprintPath"] == "" || comp["specPath"] == "" {
		t.Fatalf("compiled composition status=%d body=%v", code, comp)
	}
}

func TestCandidateReportImportFailureMarksJobFailed(t *testing.T) {
	app, repoPath := newTestApp(t)
	_, repo := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath})
	_, session := doJSON(t, app, http.MethodPost, "/api/sessions", map[string]any{"repositoryId": repo["id"]})
	sessionID := session["id"].(string)
	root := filepath.Join(app.cfg.DataDir, "jobs", "bad_report")
	if err := os.MkdirAll(filepath.Join(root, "output"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "candidate-report.json"), []byte(`{"candidates":[{"proposedName":"bad"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	ts := now()
	_, err := app.store.DB.Exec(`INSERT INTO agent_jobs(id,role,provider,status,subject_type,subject_id,prompt_path,output_artifact_path,timeout_seconds,created_at,started_at) VALUES('bad_report','repo_analysis','fake','running','session',?,'prompt',?,1800,?,?)`, sessionID, filepath.Join(root, "output"), ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.store.DB.Exec(`UPDATE repo_sessions SET phase='analysing' WHERE id=?`, sessionID); err != nil {
		t.Fatal(err)
	}
	if err := app.CompleteJob(context.Background(), "bad_report", 0, ""); err != nil {
		t.Fatal(err)
	}
	var status, code, phase string
	if err := app.store.DB.QueryRow(`SELECT status,error_code FROM agent_jobs WHERE id='bad_report'`).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if err := app.store.DB.QueryRow(`SELECT phase FROM repo_sessions WHERE id=?`, sessionID).Scan(&phase); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || code != "candidate_report.invalid" {
		t.Fatalf("status=%s code=%s", status, code)
	}
	if phase != "failed_analysis" {
		t.Fatalf("phase=%s", phase)
	}
}

func TestCandidateReportRequiresInputAndOutputPorts(t *testing.T) {
	app, repoPath := newTestApp(t)
	_, repo := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath})
	_, session := doJSON(t, app, http.MethodPost, "/api/sessions", map[string]any{"repositoryId": repo["id"]})
	sessionID := session["id"].(string)
	root := filepath.Join(app.cfg.DataDir, "jobs", "bad_ports")
	if err := os.MkdirAll(filepath.Join(root, "output"), 0o755); err != nil {
		t.Fatal(err)
	}
	report := `{"candidates":[{"proposedName":"bad","description":"bad","moduleKind":"library","targetLanguage":"go","confidence":"high","extractionRisk":"low","sourcePaths":["README.md"],"reusableRationale":"reuse","couplingNotes":"none","dependencies":[],"sideEffects":[],"testsFound":[],"missingTests":[],"ports":{"inputs":[{"name":"in","type":"Message"}]},"workbenchNode":{"type":"bad"}}]}`
	if err := os.WriteFile(filepath.Join(root, "candidate-report.json"), []byte(report), 0o644); err != nil {
		t.Fatal(err)
	}
	ts := now()
	_, err := app.store.DB.Exec(`INSERT INTO agent_jobs(id,role,provider,status,subject_type,subject_id,prompt_path,output_artifact_path,timeout_seconds,created_at,started_at) VALUES('bad_ports','repo_analysis','fake','running','session',?,'prompt',?,1800,?,?)`, sessionID, filepath.Join(root, "output"), ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.CompleteJob(context.Background(), "bad_ports", 0, ""); err != nil {
		t.Fatal(err)
	}
	var status, code string
	if err := app.store.DB.QueryRow(`SELECT status,error_code FROM agent_jobs WHERE id='bad_ports'`).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || code != "candidate_report.invalid" {
		t.Fatalf("status=%s code=%s", status, code)
	}
}

func TestPathSafetyRejectsEscapingSymlinkAndArtifactPrefix(t *testing.T) {
	app, repoPath := newTestApp(t)
	_, repo := doJSON(t, app, http.MethodPost, "/api/repositories", map[string]any{"sourceType": "local_path", "sourceUri": repoPath})
	_, session := doJSON(t, app, http.MethodPost, "/api/sessions", map[string]any{"repositoryId": repo["id"]})
	sessionID := session["id"].(string)
	outside := filepath.Join(filepath.Dir(repoPath), "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	checkout := session["checkoutPath"].(string)
	if err := os.WriteFile(filepath.Join(checkout, "target.txt"), []byte("in tree"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target.txt", filepath.Join(checkout, "valid-link.txt")); err != nil {
		t.Fatal(err)
	}
	code, linked := doJSON(t, app, http.MethodGet, "/api/sessions/"+sessionID+"/files?path=valid-link.txt", nil)
	if code != 200 || linked["content"] != "in tree" {
		t.Fatalf("valid symlink status=%d body=%v", code, linked)
	}
	if err := os.Symlink(outside, filepath.Join(checkout, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	code, body := doJSON(t, app, http.MethodGet, "/api/sessions/"+sessionID+"/files?path=escape.txt", nil)
	if code != 400 || body["error"].(map[string]any)["code"] != "path.invalid" {
		t.Fatalf("escape source status=%d body=%v", code, body)
	}

	output := filepath.Join(app.cfg.DataDir, "jobs", "prefix_job", "output")
	sibling := filepath.Join(app.cfg.DataDir, "jobs", "prefix_job", "output-escape")
	if err := os.MkdirAll(output, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sibling, "bad.txt"), []byte("bad"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(sibling, "bad.txt"), filepath.Join(output, "bad-link")); err != nil {
		t.Fatal(err)
	}
	ts := now()
	_, err := app.store.DB.Exec(`INSERT INTO agent_jobs(id,role,provider,status,subject_type,subject_id,prompt_path,output_artifact_path,timeout_seconds,created_at,started_at) VALUES('prefix_job','wiring','fake','running','blueprint','bp','prompt',?,3600,?,?)`, output, ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.CompleteJob(context.Background(), "prefix_job", 0, ""); err != nil {
		t.Fatal(err)
	}
	var status, errCode string
	if err := app.store.DB.QueryRow(`SELECT status,error_code FROM agent_jobs WHERE id='prefix_job'`).Scan(&status, &errCode); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || errCode != "artifact.write_failed" {
		t.Fatalf("status=%s code=%s", status, errCode)
	}
}

func TestSchedulerTimeoutAndInterruptedReconcile(t *testing.T) {
	app, _ := newTestApp(t)
	old := time.Now().Add(-2 * time.Second).UTC().Format(time.RFC3339Nano)
	_, err := app.store.DB.Exec(`INSERT INTO agent_jobs(id,role,provider,status,subject_type,subject_id,prompt_path,timeout_seconds,created_at,started_at) VALUES('job_timeout','wiring','fake','running','blueprint','bp','prompt',1,?,?)`, old, old)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	var status, code string
	if err := app.store.DB.QueryRow(`SELECT status,error_code FROM agent_jobs WHERE id='job_timeout'`).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || code != "job.timeout" {
		t.Fatalf("timeout status=%s code=%s", status, code)
	}
	_, err = app.store.DB.Exec(`INSERT INTO agent_jobs(id,role,provider,status,subject_type,subject_id,prompt_path,timeout_seconds,created_at,started_at) VALUES('job_orphan','wiring','claude_code_tmux','running','blueprint','bp','prompt',10,?,?)`, now(), now())
	if err != nil {
		t.Fatal(err)
	}
	if err := app.ReconcileInterrupted(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := app.store.DB.QueryRow(`SELECT status,error_code FROM agent_jobs WHERE id='job_orphan'`).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || code != "job.interrupted" {
		t.Fatalf("orphan status=%s code=%s", status, code)
	}
}

func TestCancelJobPreservesStateOnProviderFailureOrTerminalJob(t *testing.T) {
	app, _ := newTestApp(t)
	app.providers["bad_cancel"] = failingCancelProvider{}
	ts := now()
	_, err := app.store.DB.Exec(`INSERT INTO agent_jobs(id,role,provider,status,subject_type,subject_id,tmux_session_name,prompt_path,timeout_seconds,created_at,started_at) VALUES('cancel_fail','wiring','bad_cancel','running','blueprint','bp_cancel','tmux','prompt',3600,?,?)`, ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	code, body := doJSON(t, app, http.MethodPost, "/api/agent-jobs/cancel_fail/cancel", nil)
	if code != 502 {
		t.Fatalf("cancel failure status=%d body=%v", code, body)
	}
	var status string
	if err := app.store.DB.QueryRow(`SELECT status FROM agent_jobs WHERE id='cancel_fail'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "running" {
		t.Fatalf("cancel failure mutated job status to %s", status)
	}

	_, err = app.store.DB.Exec(`INSERT INTO agent_jobs(id,role,provider,status,subject_type,subject_id,prompt_path,timeout_seconds,created_at,started_at,finished_at) VALUES('done_job','wiring','fake','succeeded','blueprint','bp_done','prompt',3600,?,?,?)`, ts, ts, ts)
	if err != nil {
		t.Fatal(err)
	}
	code, body = doJSON(t, app, http.MethodPost, "/api/agent-jobs/done_job/cancel", nil)
	if code != 409 {
		t.Fatalf("terminal cancel status=%d body=%v", code, body)
	}
	if err := app.store.DB.QueryRow(`SELECT status FROM agent_jobs WHERE id='done_job'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" {
		t.Fatalf("terminal cancel mutated job status to %s", status)
	}
}
