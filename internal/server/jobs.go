package server

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"text/template"
	"time"

	"code_workbench/internal/paths"
)

type Job struct {
	ID              string
	Role            string
	Provider        string
	Status          string
	SubjectType     string
	SubjectID       string
	TmuxSessionName string
	PromptPath      string
	TranscriptPath  string
	OutputPath      string
	TimeoutSeconds  int
}

type AgentProvider interface {
	Start(context.Context, Job) (ProviderStart, error)
	Open(context.Context, Job) (map[string]any, error)
	Cancel(context.Context, Job) error
	Status(context.Context, Job) (string, error)
}

type ProviderStart struct {
	TmuxSessionName string
	TranscriptPath  string
	OutputPath      string
}

type promptCandidate struct {
	ID             string
	ProposedName   string
	TargetLanguage string
	SourcePaths    []string
}

type FakeProvider struct{}

func (FakeProvider) Start(ctx context.Context, job Job) (ProviderStart, error) {
	root := filepath.Dir(job.PromptPath)
	out := job.OutputPath
	if out == "" {
		out = filepath.Join(root, "output")
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return ProviderStart{}, err
	}
	transcript := filepath.Join(out, "transcript.txt")
	_ = os.WriteFile(transcript, []byte("fake provider started\n"), 0o644)
	if job.Role == "repo_analysis" {
		report := filepath.Join(root, "candidate-report.json")
		_ = os.WriteFile(report, []byte(`{"candidates":[{"proposedName":"config-loader","description":"Reusable configuration loader","moduleKind":"library","targetLanguage":"go","confidence":"high","extractionRisk":"low","sourcePaths":["README.md"],"reusableRationale":"Centralized config loading is reusable across local services.","couplingNotes":"No runtime coupling identified.","dependencies":["os"],"sideEffects":["reads filesystem"],"testsFound":["README example"],"missingTests":["error path tests"],"ports":{"inputs":[{"name":"config_path","type":"String","required":true}],"outputs":[{"name":"config","type":"Config"}]},"workbenchNode":{"type":"configLoader"}}]}`), 0o644)
	}
	if job.Role == "spec_enrichment" {
		_ = os.WriteFile(filepath.Join(out, "selected-modules.json"), []byte(`[]`), 0o644)
		_ = os.WriteFile(filepath.Join(out, "enriched.md"), []byte("## Registry References\n\nNo registry modules were selected.\n"), 0o644)
	}
	if job.Role == "composition_clarifier" {
		_ = os.WriteFile(filepath.Join(out, "questions.json"), []byte(`[{"id":"goal","question":"What outcome should this composition optimize for?"}]`), 0o644)
	}
	if job.Role == "blueprint_compiler" {
		_ = os.WriteFile(filepath.Join(out, "blueprint.json"), []byte(`{"nodes":[],"edges":[]}`), 0o644)
		_ = os.WriteFile(filepath.Join(out, "implementation-spec.md"), []byte("# Composition Implementation Spec\n\n## Registry References\n\nGenerated from selected registry modules.\n"), 0o644)
	}
	return ProviderStart{TmuxSessionName: "fake-" + job.ID, TranscriptPath: transcript, OutputPath: out}, nil
}

func (FakeProvider) Open(ctx context.Context, job Job) (map[string]any, error) {
	if job.Status != "running" || job.TmuxSessionName == "" {
		return nil, APIError{Status: 409, Code: "agent_job.not_running", Message: "job has no active tmux session"}
	}
	return map[string]any{"tmuxSessionName": job.TmuxSessionName, "attachCommand": "tmux attach -t " + job.TmuxSessionName}, nil
}
func (FakeProvider) Cancel(context.Context, Job) error           { return nil }
func (FakeProvider) Status(context.Context, Job) (string, error) { return "running", nil }

type ClaudeProvider struct {
	dataDir string
	runner  func(context.Context, string, string, string, []string, string) error
}

func NewClaudeProvider(dataDir string) *ClaudeProvider {
	return &ClaudeProvider{dataDir: dataDir, runner: func(ctx context.Context, name, socket, command string, env []string, cwd string) error {
		cmd := exec.CommandContext(ctx, "tmux", "-S", socket, "new-session", "-d", "-s", name, command)
		cmd.Env = env
		cmd.Dir = cwd
		return cmd.Run()
	}}
}

func (p *ClaudeProvider) Start(ctx context.Context, job Job) (ProviderStart, error) {
	root := filepath.Join(p.dataDir, "jobs", job.ID)
	workspace := filepath.Join(root, "workspace")
	home := filepath.Join(root, "home")
	output := job.OutputPath
	if output == "" {
		output = filepath.Join(root, "output")
	}
	for _, d := range []string{workspace, filepath.Join(workspace, "read"), home, output} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return ProviderStart{}, err
		}
	}
	transcript := filepath.Join(output, "transcript.txt")
	exitCodePath := filepath.Join(output, "exit_code")
	profilePath := filepath.Join(root, "sandbox.profile")
	tmuxName := "code-workbench-" + job.ID
	socketPath := filepath.Join(root, "tmux.sock")
	claudeBin, err := exec.LookPath("claude")
	if err != nil {
		return ProviderStart{}, APIError{Status: 502, Code: "agent_provider.start_failed", Message: "claude executable not found"}
	}
	claudeArgs := []string{
		claudeBin, "--bare",
		"--permission-mode", "acceptEdits",
		"--allowedTools", "Read,Grep,Glob,Edit,Write,MultiEdit,Bash(git *),Bash(go test *),Bash(go list *)",
		"--disallowedTools", "WebFetch,WebSearch",
		job.PromptPath,
	}
	command, err := sandboxedCommand(runtime.GOOS, profilePath, output, workspace, claudeBin, claudeArgs)
	if err != nil {
		return ProviderStart{}, APIError{Status: 502, Code: "agent_provider.start_failed", Message: err.Error()}
	}
	sessionCommand := "cd " + shellQuote(workspace) + "; " + command + " > " + shellQuote(transcript) + " 2>&1; code=$?; printf '%s\\n' \"$code\" > " + shellQuote(exitCodePath) + "; exit \"$code\""
	env := filteredEnv(home, map[string]string{
		"CODE_WORKBENCH_JOB_ID":       job.ID,
		"CODE_WORKBENCH_ROLE":         job.Role,
		"CODE_WORKBENCH_OUTPUT_ROOT":  output,
		"CODE_WORKBENCH_DENIED_PATHS": strings.Join(deniedPaths(p.dataDir, home), string(os.PathListSeparator)),
	})
	if err := p.runner(ctx, tmuxName, socketPath, sessionCommand, env, workspace); err != nil {
		return ProviderStart{}, APIError{Status: 502, Code: "agent_provider.start_failed", Message: err.Error()}
	}
	return ProviderStart{TmuxSessionName: tmuxName, TranscriptPath: transcript, OutputPath: output}, nil
}

func sandboxedCommand(goos, profilePath, outputRoot, workspace, claudeBin string, args []string) (string, error) {
	readRoots := sandboxReadRoots(claudeBin)
	switch goos {
	case "darwin":
		if _, err := exec.LookPath("sandbox-exec"); err != nil {
			return "", errors.New("sandbox-exec is required for claude_code_tmux on darwin")
		}
		readRules := `(subpath "` + workspace + `") (subpath "` + outputRoot + `")`
		for _, root := range readRoots {
			readRules += ` (subpath "` + root + `")`
		}
		profile := `(version 1)
		(deny default)
		(allow process*)
		(allow sysctl-read)
		(allow file-read* ` + readRules + `)
		(allow file-write* (subpath "` + outputRoot + `"))
		`
		if err := os.WriteFile(profilePath, []byte(profile), 0o600); err != nil {
			return "", err
		}
		return "sandbox-exec -f " + shellQuote(profilePath) + " " + shellJoin(args), nil
	case "linux":
		if _, err := exec.LookPath("bwrap"); err != nil {
			return "", errors.New("bwrap is required for claude_code_tmux on linux")
		}
		wrapped := []string{"bwrap", "--die-with-parent", "--unshare-all", "--tmpfs", "/", "--ro-bind", workspace, workspace, "--bind", outputRoot, outputRoot}
		for _, root := range readRoots {
			wrapped = append(wrapped, "--ro-bind", root, root)
		}
		wrapped = append(wrapped, "--chdir", workspace)
		wrapped = append(wrapped, args...)
		return shellJoin(wrapped), nil
	default:
		return "", errors.New("no filesystem sandbox implementation for " + goos)
	}
}

func sandboxReadRoots(claudeBin string) []string {
	realClaude := claudeBin
	if resolved, err := filepath.EvalSymlinks(claudeBin); err == nil {
		realClaude = resolved
	}
	realClaudeRoot := realClaude
	if info, err := os.Stat(realClaude); err == nil && !info.IsDir() {
		realClaudeRoot = filepath.Dir(realClaude)
	}
	candidates := []string{
		filepath.Dir(claudeBin), realClaudeRoot,
		"/bin", "/usr/bin", "/usr/lib", "/usr/libexec", "/System/Library", "/Library", "/opt/homebrew/bin", "/opt/homebrew/lib", "/private/tmp",
		"/lib", "/lib64", "/usr/local/bin", "/usr/local/lib", "/etc/ssl",
	}
	out := []string{}
	seen := map[string]bool{}
	for _, root := range candidates {
		if root == "" || seen[root] {
			continue
		}
		if _, err := os.Stat(root); err == nil {
			seen[root] = true
			out = append(out, root)
		}
	}
	return out
}

func shellJoin(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		quoted = append(quoted, shellQuote(arg))
	}
	return strings.Join(quoted, " ")
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

func filteredEnv(home string, extra map[string]string) []string {
	keep := map[string]bool{"PATH": true, "TMPDIR": true, "SHELL": true, "TERM": true}
	out := []string{"HOME=" + home}
	for _, kv := range os.Environ() {
		name := strings.SplitN(kv, "=", 2)[0]
		if keep[name] {
			out = append(out, kv)
		}
	}
	for k, v := range extra {
		out = append(out, k+"="+v)
	}
	return out
}

func deniedPaths(dataDir, jobHome string) []string {
	paths := []string{filepath.Clean(filepath.Join(dataDir, "..")), filepath.Join(jobHome, ".ssh"), filepath.Join(jobHome, ".config")}
	if realHome, err := os.UserHomeDir(); err == nil && realHome != "" {
		paths = append(paths, realHome, filepath.Join(realHome, ".ssh"), filepath.Join(realHome, ".config"))
	}
	return paths
}

func (p *ClaudeProvider) Open(ctx context.Context, job Job) (map[string]any, error) {
	if job.Status != "running" || job.TmuxSessionName == "" {
		return nil, APIError{Status: 409, Code: "agent_job.not_running", Message: "job has no active tmux session"}
	}
	return map[string]any{"tmuxSessionName": job.TmuxSessionName, "attachCommand": "tmux -S " + shellQuote(filepath.Join(p.dataDir, "jobs", job.ID, "tmux.sock")) + " attach -t " + shellQuote(job.TmuxSessionName)}, nil
}

func (p *ClaudeProvider) Cancel(ctx context.Context, job Job) error {
	if job.TmuxSessionName == "" {
		return nil
	}
	return exec.CommandContext(ctx, "tmux", "-S", filepath.Join(p.dataDir, "jobs", job.ID, "tmux.sock"), "kill-session", "-t", job.TmuxSessionName).Run()
}

func (p *ClaudeProvider) Status(ctx context.Context, job Job) (string, error) {
	if job.TmuxSessionName == "" {
		return "failed", nil
	}
	err := exec.CommandContext(ctx, "tmux", "-S", filepath.Join(p.dataDir, "jobs", job.ID, "tmux.sock"), "has-session", "-t", job.TmuxSessionName).Run()
	if err == nil {
		return "running", nil
	}
	code, codeErr := readExitCode(job.OutputPath)
	if codeErr == nil && code == 0 {
		return "succeeded", nil
	}
	return "failed", nil
}

func (a *App) QueueJob(ctx context.Context, role, subjectType, subjectID, provider string) (int, map[string]any, error) {
	if provider == "" {
		provider = "claude_code_tmux"
	}
	if _, ok := a.providers[provider]; !ok {
		return 0, nil, APIError{Status: 502, Code: "agent_provider.start_failed", Message: "unknown provider"}
	}
	if existing, err := getSingle(a.store.DB, `SELECT * FROM agent_jobs WHERE role=? AND subject_type=? AND subject_id=? AND status IN ('queued','running')`, role, subjectType, subjectID); err == nil {
		return 200, existing, nil
	}
	id := newID("job")
	root := filepath.Join(a.cfg.DataDir, "jobs", id)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return 0, nil, err
	}
	outputRoot := a.outputRootForJob(role, subjectType, subjectID, id)
	readRoot := filepath.Join(root, "workspace", "read")
	if err := a.materializeReadRoots(ctx, role, subjectType, subjectID, readRoot); err != nil {
		return 0, nil, err
	}
	promptPath := filepath.Join(root, "prompt.md")
	promptData := map[string]any{
		"JobID": id, "Role": role, "SubjectType": subjectType, "SubjectID": subjectID,
		"JobRoot": root, "OutputRoot": outputRoot, "WorkspaceReadRoot": readRoot,
		"DeniedPathRules": "Do not read or write outside the OutputRoot. Do not access the user home directory, .ssh, .config, or any path outside the job workspace.",
	}
	a.enrichPromptData(ctx, promptData, role, subjectType, subjectID)
	if err := renderPrompt(promptPath, role, promptData); err != nil {
		return 0, nil, err
	}
	a.logPrompt(id, role, promptPath)
	ts := now()
	_, err := a.store.DB.ExecContext(ctx, `INSERT INTO agent_jobs(id,role,provider,status,subject_type,subject_id,prompt_path,output_artifact_path,timeout_seconds,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, role, provider, "queued", subjectType, subjectID, promptPath, outputRoot, a.cfg.TimeoutSeconds(role), ts)
	if err != nil && strings.Contains(err.Error(), "agent_jobs_one_active") {
		existing, getErr := getSingle(a.store.DB, `SELECT * FROM agent_jobs WHERE role=? AND subject_type=? AND subject_id=? AND status IN ('queued','running')`, role, subjectType, subjectID)
		return 200, existing, getErr
	}
	if err != nil {
		return 0, nil, err
	}
	a.log.Event("job_queued", map[string]any{"jobId": id, "role": role, "provider": provider, "subjectType": subjectType, "subjectId": subjectID, "promptPath": promptPath, "outputPath": outputRoot})
	a.tryStartQueued(ctx)
	job, err := getSingle(a.store.DB, `SELECT * FROM agent_jobs WHERE id=?`, id)
	return 202, job, err
}

func (a *App) outputRootForJob(role, subjectType, subjectID, jobID string) string {
	if role == "wiring" && subjectType == "blueprint" {
		return filepath.Join(a.cfg.DataDir, "blueprints", subjectID, "generated", jobID)
	}
	return filepath.Join(a.cfg.DataDir, "jobs", jobID, "output")
}

func (a *App) enrichPromptData(ctx context.Context, data map[string]any, role, subjectType, subjectID string) {
	switch {
	case role == "repo_analysis", role == "candidate_scan":
		data["OutputContract"] = "Emit candidate-report.json with the CandidateReport schema: {candidates: [{proposedName, description, moduleKind, targetLanguage, confidence, extractionRisk, sourcePaths, reusableRationale, couplingNotes, dependencies, sideEffects, testsFound, missingTests, ports: {inputs, outputs}, workbenchNode}]}."
	case role == "extraction", role == "module_extraction":
		data["OutputContract"] = "For each approved candidate, read its sourcePaths from the repo checkout, convert or rewrite the module into the candidate targetLanguage (default go), and emit production source files, unit tests, manifest.json, config.schema.json, docs, and provenance metadata under the OutputRoot."
		var approvedJSON, rejectedJSON string
		if err := a.store.DB.QueryRowContext(ctx, `SELECT approved_candidate_ids_json, rejected_candidate_ids_json FROM extraction_plans WHERE id=?`, subjectID).Scan(&approvedJSON, &rejectedJSON); err == nil {
			var approved, rejected []string
			_ = json.Unmarshal([]byte(approvedJSON), &approved)
			_ = json.Unmarshal([]byte(rejectedJSON), &rejected)
			data["ApprovedCandidateIDs"] = approved
			data["RejectedCandidateIDs"] = rejected
			data["ApprovedCandidates"] = a.promptCandidates(ctx, approved)
		}
	case role == "spec_enrichment" && subjectType == "spec_enrichment":
		data["OutputContract"] = "Review the input spec and registry module summaries. Emit selected-modules.json and enriched.md containing a ## Registry References section with module name/version, why it applies, ports/capabilities, expected integration point, and replacement or variant notes."
	case role == "composition_clarifier" && subjectType == "composition":
		data["OutputContract"] = "Emit questions.json as an array of {id, question} clarification questions needed before composing the selected registry modules."
	case role == "blueprint_compiler" && subjectType == "composition":
		data["OutputContract"] = "Emit blueprint.json for the semantic composition and implementation-spec.md as the companion implementation spec. Keep the spec separate from the blueprint JSON."
	case role == "composition_spec_writer" && subjectType == "composition":
		data["OutputContract"] = "Emit implementation-spec.md for the compiled composition using the selected modules, answers, and blueprint."
	case role == "wiring" && subjectType == "blueprint":
		data["OutputContract"] = "Generate runnable code, wiring manifest, and validation notes under the OutputRoot based on the semantic blueprint document."
	default:
		data["OutputContract"] = "Write outputs under the OutputRoot and emit the required JSON contract for this role."
	}
}

func (a *App) materializeReadRoots(ctx context.Context, role, subjectType, subjectID, readRoot string) error {
	if err := os.MkdirAll(readRoot, 0o755); err != nil {
		return err
	}
	switch {
	case (role == "repo_analysis" || role == "candidate_scan" || role == "candidate_registry_compare") && subjectType == "session":
		var checkout string
		if err := a.store.DB.QueryRowContext(ctx, `SELECT checkout_path FROM repo_sessions WHERE id=?`, subjectID).Scan(&checkout); err != nil {
			return err
		}
		return copyDir(checkout, filepath.Join(readRoot, "repo"))
	case (role == "extraction" || role == "module_extraction" || role == "registry_update") && subjectType == "extraction_plan":
		return a.materializeExtractionReadRoot(ctx, subjectID, readRoot)
	case role == "spec_enrichment" && subjectType == "spec_enrichment":
		var specPath string
		if err := a.store.DB.QueryRowContext(ctx, `SELECT spec_path FROM spec_enrichments WHERE id=?`, subjectID).Scan(&specPath); err != nil {
			return err
		}
		if err := copyFile(specPath, filepath.Join(readRoot, filepath.Base(specPath)), 0o644); err != nil {
			return err
		}
		return a.writeRegistrySnapshot(filepath.Join(readRoot, "registry-modules.json"))
	case (role == "composition_clarifier" || role == "blueprint_compiler" || role == "composition_spec_writer") && subjectType == "composition":
		var flowPath string
		if err := a.store.DB.QueryRowContext(ctx, `SELECT flow_layout_path FROM compositions WHERE id=?`, subjectID).Scan(&flowPath); err != nil {
			return err
		}
		if err := copyFile(flowPath, filepath.Join(readRoot, "flow-layout.json"), 0o644); err != nil {
			return err
		}
		return a.writeCompositionSnapshot(subjectID, filepath.Join(readRoot, "composition.json"))
	case role == "wiring" && subjectType == "blueprint":
		var semanticPath string
		if err := a.store.DB.QueryRowContext(ctx, `SELECT semantic_document_path FROM blueprints WHERE id=?`, subjectID).Scan(&semanticPath); err != nil {
			return err
		}
		return copyFile(semanticPath, filepath.Join(readRoot, "semantic-blueprint.json"), 0o644)
	default:
		return nil
	}
}

func (a *App) materializeExtractionReadRoot(ctx context.Context, planID, readRoot string) error {
	var planPath, sessionID, approvedJSON, rejectedJSON string
	if err := a.store.DB.QueryRowContext(ctx, `SELECT plan_path,session_id,approved_candidate_ids_json,rejected_candidate_ids_json FROM extraction_plans WHERE id=?`, planID).Scan(&planPath, &sessionID, &approvedJSON, &rejectedJSON); err != nil {
		return err
	}
	if err := copyFile(planPath, filepath.Join(readRoot, "extraction-plan.json"), 0o644); err != nil {
		return err
	}
	var checkout string
	if err := a.store.DB.QueryRowContext(ctx, `SELECT checkout_path FROM repo_sessions WHERE id=?`, sessionID).Scan(&checkout); err != nil {
		return err
	}
	if err := copyDir(checkout, filepath.Join(readRoot, "repo")); err != nil {
		return err
	}
	var approvedIDs, rejectedIDs []string
	_ = json.Unmarshal([]byte(approvedJSON), &approvedIDs)
	_ = json.Unmarshal([]byte(rejectedJSON), &rejectedIDs)
	candidates := map[string]any{
		"approved": a.candidateRecords(approvedIDs),
		"rejected": a.candidateRecords(rejectedIDs),
	}
	return writeJSONFile(filepath.Join(readRoot, "candidates.json"), candidates)
}

func (a *App) candidateRecords(ids []string) []map[string]any {
	out := []map[string]any{}
	for _, id := range ids {
		item, err := getSingle(a.store.DB, `SELECT * FROM candidates WHERE id=?`, id)
		if err == nil {
			out = append(out, item)
		}
	}
	return out
}

func (a *App) promptCandidates(ctx context.Context, ids []string) []promptCandidate {
	out := []promptCandidate{}
	for _, id := range ids {
		var name, targetLanguage, sourcePathsJSON string
		if err := a.store.DB.QueryRowContext(ctx, `SELECT proposed_name,target_language,source_paths_json FROM candidates WHERE id=?`, id).Scan(&name, &targetLanguage, &sourcePathsJSON); err != nil {
			continue
		}
		var sourcePaths []string
		_ = json.Unmarshal([]byte(sourcePathsJSON), &sourcePaths)
		if targetLanguage == "" {
			targetLanguage = "go"
		}
		out = append(out, promptCandidate{ID: id, ProposedName: name, TargetLanguage: targetLanguage, SourcePaths: sourcePaths})
	}
	return out
}

func (a *App) writeRegistrySnapshot(path string) error {
	rows, err := a.store.DB.Query(`SELECT id,name,version,capabilities_json,ports_json,registry_decision,supersedes_module_id,superseded_by_module_id FROM modules WHERE superseded_by_module_id IS NULL ORDER BY name,version DESC`)
	if err != nil {
		return err
	}
	items, err := scanJSONRows(rows)
	if err != nil {
		return err
	}
	return writeJSONFile(path, map[string]any{"modules": items})
}

func (a *App) writeCompositionSnapshot(id, path string) error {
	item, err := getSingle(a.store.DB, `SELECT * FROM compositions WHERE id=?`, id)
	if err != nil {
		return err
	}
	var selected []string
	if raw, _ := item["selectedModulesJson"].([]any); raw != nil {
		for _, v := range raw {
			if s, ok := v.(string); ok {
				selected = append(selected, s)
			}
		}
	}
	modules := []map[string]any{}
	for _, moduleID := range selected {
		module, err := getSingle(a.store.DB, `SELECT * FROM modules WHERE id=?`, moduleID)
		if err == nil {
			modules = append(modules, module)
		}
	}
	item["selectedModules"] = modules
	return writeJSONFile(path, item)
}

func writeJSONFile(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

func (a *App) completeSpecEnrichment(ctx context.Context, job Job) error {
	var specPath, outputPath, artifactRoot string
	if err := a.store.DB.QueryRowContext(ctx, `SELECT spec_path,output_path,artifact_root FROM spec_enrichments WHERE id=?`, job.SubjectID).Scan(&specPath, &outputPath, &artifactRoot); err != nil {
		return err
	}
	selectedPath := filepath.Join(job.OutputPath, "selected-modules.json")
	selectedBytes, err := os.ReadFile(selectedPath)
	if err != nil || !json.Valid(selectedBytes) {
		selectedBytes = []byte(`[]`)
	}
	var selectedIDs []string
	_ = json.Unmarshal(selectedBytes, &selectedIDs)
	if len(selectedIDs) == 0 {
		rows, qerr := a.store.DB.QueryContext(ctx, `SELECT id FROM modules WHERE available_in_workbench=1 AND superseded_by_module_id IS NULL ORDER BY name,version DESC`)
		if qerr == nil {
			for rows.Next() {
				var id string
				if rows.Scan(&id) == nil {
					selectedIDs = append(selectedIDs, id)
				}
			}
			_ = rows.Close()
		}
		if len(selectedIDs) > 0 {
			selectedBytes, _ = json.Marshal(selectedIDs)
		}
	}
	registryRefsPath := filepath.Join(artifactRoot, "registry-references.json")
	if err := os.MkdirAll(artifactRoot, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(registryRefsPath, selectedBytes, 0o644); err != nil {
		return err
	}
	enrichedBytes, err := os.ReadFile(filepath.Join(job.OutputPath, "enriched.md"))
	if err != nil || !strings.Contains(string(enrichedBytes), "## Registry References") || len(selectedIDs) > 0 {
		original, readErr := os.ReadFile(specPath)
		if readErr != nil {
			return readErr
		}
		enrichedBytes = []byte(strings.TrimRight(string(original), "\n") + "\n\n" + a.registryReferencesMarkdown(selectedBytes))
	}
	if err := os.WriteFile(outputPath, enrichedBytes, 0o644); err != nil {
		return err
	}
	_, err = a.store.DB.ExecContext(ctx, `UPDATE spec_enrichments SET status='succeeded', selected_modules_json=?, registry_references_path=?, updated_at=? WHERE id=?`, string(selectedBytes), registryRefsPath, now(), job.SubjectID)
	return err
}

func (a *App) registryReferencesMarkdown(selected []byte) string {
	var ids []string
	_ = json.Unmarshal(selected, &ids)
	if len(ids) == 0 {
		return "## Registry References\n\nNo registry modules were selected.\n"
	}
	lines := []string{"## Registry References", ""}
	for _, id := range ids {
		mod, err := getSingle(a.store.DB, `SELECT name,version,capabilities_json,ports_json,registry_decision,supersedes_module_id FROM modules WHERE id=?`, id)
		if err != nil {
			continue
		}
		lines = append(lines,
			fmt.Sprintf("- **%s@%s**", asString(mod["name"]), asString(mod["version"])),
			fmt.Sprintf("  - Why it applies: registry module selected for matching capability `%s`.", compactJSON(mod["capabilitiesJson"])),
			fmt.Sprintf("  - Ports/capabilities: `%s`", compactJSON(mod["portsJson"])),
			"  - Expected integration point: wire through the composition or implementation layer that owns the matching capability.",
			fmt.Sprintf("  - Replacement/variant notes: decision `%s`, supersedes `%s`.", asString(mod["registryDecision"]), asString(mod["supersedesModuleId"])),
		)
	}
	return strings.Join(lines, "\n") + "\n"
}

func compactJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func (a *App) completeCompositionClarifier(ctx context.Context, job Job) error {
	b, err := os.ReadFile(filepath.Join(job.OutputPath, "questions.json"))
	if err != nil || !json.Valid(b) {
		b = []byte(`[{"id":"goal","question":"What outcome should this composition optimize for?"}]`)
	}
	_, err = a.store.DB.ExecContext(ctx, `UPDATE compositions SET status='awaiting_answers', questions_json=?, updated_at=? WHERE id=?`, string(b), now(), job.SubjectID)
	return err
}

func (a *App) completeCompositionCompile(ctx context.Context, job Job) error {
	root := filepath.Join(a.cfg.DataDir, "compositions", job.SubjectID)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	blueprintBytes, err := os.ReadFile(filepath.Join(job.OutputPath, "blueprint.json"))
	if err != nil || !json.Valid(blueprintBytes) {
		blueprintBytes = []byte(`{"nodes":[],"edges":[]}`)
	}
	specBytes, err := os.ReadFile(filepath.Join(job.OutputPath, "implementation-spec.md"))
	if err != nil {
		specBytes = []byte("# Composition Implementation Spec\n\n## Registry References\n\nGenerated from selected registry modules.\n")
	}
	blueprintPath := filepath.Join(root, "blueprint.json")
	specPath := filepath.Join(root, "implementation-spec.md")
	if err := os.WriteFile(blueprintPath, blueprintBytes, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(specPath, specBytes, 0o644); err != nil {
		return err
	}
	_, err = a.store.DB.ExecContext(ctx, `UPDATE compositions SET status='compiled', blueprint_path=?, spec_path=?, updated_at=? WHERE id=?`, blueprintPath, specPath, now(), job.SubjectID)
	return err
}

//go:embed templates/prompts/*.tmpl
var promptTemplates embed.FS

func renderPrompt(path, role string, data map[string]any) error {
	const fallback = `# {{.Role}} job

Job: {{.JobID}}
Subject: {{.SubjectType}} {{.SubjectID}}
Write outputs under {{.OutputRoot}} and emit the required JSON contract for this role.
`
	text, err := promptTemplates.ReadFile("templates/prompts/" + role + ".md.tmpl")
	if err != nil {
		text = []byte(fallback)
	}
	t, err := template.New(role).Parse(string(text))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return t.Execute(f, data)
}

func (a *App) tryStartQueued(ctx context.Context) {
	rows, err := a.store.DB.QueryContext(ctx, `SELECT id,role,provider,status,subject_type,subject_id,prompt_path,COALESCE(output_artifact_path,''),timeout_seconds FROM agent_jobs WHERE status='queued' ORDER BY created_at`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		job := Job{}
		if err := rows.Scan(&job.ID, &job.Role, &job.Provider, &job.Status, &job.SubjectType, &job.SubjectID, &job.PromptPath, &job.OutputPath, &job.TimeoutSeconds); err != nil {
			continue
		}
		var running int
		_ = a.store.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_jobs WHERE role=? AND status='running'`, job.Role).Scan(&running)
		if running >= a.cfg.LimitForRole(job.Role) {
			continue
		}
		provider := a.providers[job.Provider]
		if provider == nil {
			continue
		}
		start, err := provider.Start(ctx, job)
		if err != nil {
			_, _ = a.store.DB.ExecContext(ctx, `UPDATE agent_jobs SET status='failed', error_code='agent_provider.start_failed', finished_at=? WHERE id=?`, now(), job.ID)
			a.log.Event("job_start_failed", map[string]any{"jobId": job.ID, "role": job.Role, "provider": job.Provider, "error": err.Error()})
			continue
		}
		_, _ = a.store.DB.ExecContext(ctx, `UPDATE agent_jobs SET status='running', tmux_session_name=?, transcript_path=?, output_artifact_path=?, started_at=?, last_heartbeat_at=? WHERE id=?`, start.TmuxSessionName, start.TranscriptPath, start.OutputPath, now(), now(), job.ID)
		a.log.Event("job_started", map[string]any{"jobId": job.ID, "role": job.Role, "provider": job.Provider, "tmuxSessionName": start.TmuxSessionName, "transcriptPath": start.TranscriptPath, "outputPath": start.OutputPath})
	}
}

func (a *App) ReconcileInterrupted(ctx context.Context) error {
	rows, err := a.store.DB.QueryContext(ctx, `SELECT id,role,provider,status,subject_type,subject_id,COALESCE(tmux_session_name,''),prompt_path,COALESCE(transcript_path,''),COALESCE(output_artifact_path,''),timeout_seconds FROM agent_jobs WHERE status='running'`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		job := Job{}
		if err := rows.Scan(&job.ID, &job.Role, &job.Provider, &job.Status, &job.SubjectType, &job.SubjectID, &job.TmuxSessionName, &job.PromptPath, &job.TranscriptPath, &job.OutputPath, &job.TimeoutSeconds); err != nil {
			return err
		}
		a.emitTranscriptDelta(job)
		provider := a.providers[job.Provider]
		active := false
		if provider != nil {
			st, _ := provider.Status(ctx, job)
			active = st == "running"
		}
		if !active {
			_, err := a.store.DB.ExecContext(ctx, `UPDATE agent_jobs SET status='failed', error_code='job.interrupted', finished_at=? WHERE id=?`, now(), job.ID)
			if err != nil {
				return err
			}
			a.log.Event("job_interrupted", map[string]any{"jobId": job.ID})
		}
	}
	return rows.Err()
}

func (a *App) PollOnce(ctx context.Context) error {
	rows, err := a.store.DB.QueryContext(ctx, `SELECT id,role,provider,status,subject_type,subject_id,COALESCE(tmux_session_name,''),prompt_path,COALESCE(transcript_path,''),COALESCE(output_artifact_path,''),timeout_seconds,COALESCE(started_at,'') FROM agent_jobs WHERE status='running'`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var started string
		job := Job{}
		if err := rows.Scan(&job.ID, &job.Role, &job.Provider, &job.Status, &job.SubjectType, &job.SubjectID, &job.TmuxSessionName, &job.PromptPath, &job.TranscriptPath, &job.OutputPath, &job.TimeoutSeconds, &started); err != nil {
			return err
		}
		if started != "" {
			if t, err := time.Parse(time.RFC3339Nano, started); err == nil && time.Since(t) > time.Duration(job.TimeoutSeconds)*time.Second {
				_, _ = a.store.DB.ExecContext(ctx, `UPDATE agent_jobs SET status='failed', error_code='job.timeout', finished_at=? WHERE id=?`, now(), job.ID)
				a.log.Event("job_timeout", map[string]any{"jobId": job.ID})
				if provider := a.providers[job.Provider]; provider != nil {
					_ = provider.Cancel(ctx, job)
				}
				continue
			}
		}
		provider := a.providers[job.Provider]
		if provider == nil {
			continue
		}
		status, _ := provider.Status(ctx, job)
		switch status {
		case "succeeded":
			if err := a.CompleteJob(ctx, job.ID, 0, ""); err != nil {
				return err
			}
		case "failed":
			exitCode, err := readExitCode(job.OutputPath)
			if err != nil {
				exitCode = 1
			}
			if err := a.CompleteJob(ctx, job.ID, exitCode, "job.interrupted"); err != nil {
				return err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	a.tryStartQueued(ctx)
	return nil
}

func (a *App) logPrompt(jobID, role, path string) {
	if !a.cfg.DebugLogs {
		return
	}
	content, info, err := readTextArtifact(path, 64*1024)
	if err != nil {
		a.log.Event("job_prompt_unreadable", map[string]any{"jobId": jobID, "role": role, "path": path, "error": err.Error()})
		return
	}
	a.log.Event("job_prompt", map[string]any{"jobId": jobID, "role": role, "path": path, "bytes": info.Size, "truncated": info.Truncated, "content": content})
}

func (a *App) emitTranscriptDelta(job Job) {
	if !a.cfg.DebugLogs || job.TranscriptPath == "" {
		return
	}
	f, err := os.Open(job.TranscriptPath)
	if err != nil {
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return
	}
	a.mu.Lock()
	offset := a.logPos[job.ID]
	if offset > info.Size() {
		offset = 0
	}
	if offset == info.Size() {
		a.mu.Unlock()
		return
	}
	readOffset := offset
	if info.Size()-readOffset > 64*1024 {
		readOffset = info.Size() - 64*1024
	}
	a.logPos[job.ID] = info.Size()
	a.mu.Unlock()
	buf := make([]byte, info.Size()-readOffset)
	if _, err := f.ReadAt(buf, readOffset); err != nil && !errors.Is(err, io.EOF) {
		return
	}
	text := string(buf)
	a.log.Event("job_transcript", map[string]any{"jobId": job.ID, "role": job.Role, "path": job.TranscriptPath, "fromByte": readOffset, "toByte": info.Size(), "truncated": readOffset != offset, "content": text})
}

func (a *App) RunScheduler(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = a.PollOnce(ctx)
		}
	}
}

func (a *App) Job(id string) (Job, error) {
	var j Job
	err := a.store.DB.QueryRow(`SELECT id,role,provider,status,subject_type,subject_id,COALESCE(tmux_session_name,''),prompt_path,COALESCE(transcript_path,''),COALESCE(output_artifact_path,''),timeout_seconds FROM agent_jobs WHERE id=?`, id).Scan(&j.ID, &j.Role, &j.Provider, &j.Status, &j.SubjectType, &j.SubjectID, &j.TmuxSessionName, &j.PromptPath, &j.TranscriptPath, &j.OutputPath, &j.TimeoutSeconds)
	if errors.Is(err, sql.ErrNoRows) {
		return j, APIError{Status: 404, Code: "resource.not_found", Message: "job not found"}
	}
	return j, err
}

func (a *App) CompleteJob(ctx context.Context, id string, exitCode int, errorCode string) error {
	job, err := a.Job(id)
	if err != nil {
		return err
	}
	status := "succeeded"
	if exitCode != 0 || errorCode != "" {
		status = "failed"
	}
	if status == "succeeded" && job.OutputPath != "" {
		realRoot, _ := filepath.EvalSymlinks(job.OutputPath)
		if err := filepath.WalkDir(job.OutputPath, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			real, err := filepath.EvalSymlinks(path)
			if err == nil && !paths.Contains(realRoot, real) {
				return APIError{Status: 500, Code: "artifact.write_failed", Message: "artifact escapes output root"}
			}
			return nil
		}); err != nil {
			status, errorCode = "failed", "artifact.write_failed"
		}
	}
	if status == "succeeded" && job.Role == "repo_analysis" {
		if err := a.importCandidateReport(ctx, job); err != nil {
			status = "failed"
			if apiErr := (APIError{}); errors.As(err, &apiErr) && apiErr.Code != "" {
				errorCode = apiErr.Code
			} else {
				errorCode = "candidate_report.invalid"
			}
		}
	}
	if status == "succeeded" && job.Role == "spec_enrichment" {
		if err := a.completeSpecEnrichment(ctx, job); err != nil {
			status, errorCode = "failed", "artifact.write_failed"
		}
	}
	if status == "succeeded" && job.Role == "composition_clarifier" {
		if err := a.completeCompositionClarifier(ctx, job); err != nil {
			status, errorCode = "failed", "artifact.write_failed"
		}
	}
	if status == "succeeded" && job.Role == "blueprint_compiler" {
		if err := a.completeCompositionCompile(ctx, job); err != nil {
			status, errorCode = "failed", "artifact.write_failed"
		}
	}
	_, err = a.store.DB.ExecContext(ctx, `UPDATE agent_jobs SET status=?, exit_code=?, error_code=?, finished_at=? WHERE id=?`, status, exitCode, nullable(errorCode), now(), id)
	if err != nil {
		return err
	}
	a.log.Event("job_finished", map[string]any{"jobId": id, "status": status, "errorCode": errorCode})
	return nil
}

func readExitCode(outputPath string) (int, error) {
	b, err := os.ReadFile(filepath.Join(outputPath, "exit_code"))
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(b)))
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

type textArtifactInfo struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
}

func readTextArtifact(path string, limit int64) (string, textArtifactInfo, error) {
	info := textArtifactInfo{Path: path}
	if path == "" {
		return "", info, os.ErrNotExist
	}
	stat, err := os.Stat(path)
	if err != nil {
		return "", info, err
	}
	info.Size = stat.Size()
	readSize := stat.Size()
	if readSize > limit {
		readSize = limit
		info.Truncated = true
	}
	f, err := os.Open(path)
	if err != nil {
		return "", info, err
	}
	defer f.Close()
	if info.Truncated {
		if _, err := f.Seek(stat.Size()-readSize, 0); err != nil {
			return "", info, err
		}
	}
	b := make([]byte, readSize)
	n, err := io.ReadFull(f, b)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", info, err
	}
	return string(b[:n]), info, nil
}

func outputFiles(root string, limit int) ([]map[string]any, error) {
	if root == "" {
		return nil, nil
	}
	files := []map[string]any{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			rel = path
		}
		info, _ := d.Info()
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		files = append(files, map[string]any{"path": rel, "size": size})
		return nil
	})
	sort.Slice(files, func(i, j int) bool { return asString(files[i]["path"]) < asString(files[j]["path"]) })
	if len(files) > limit {
		files = files[:limit]
	}
	return files, err
}
