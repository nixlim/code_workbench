# Feature Specification: AI Code Workbench

**Created**: 2026-05-10
**Status**: Draft
**Intent**: Build a local single-user AI-assisted modularisation and composition workbench that discovers reusable infrastructure from repositories, gates extraction through explicit approval, registers extracted Go modules, composes registered modules visually, emits semantic blueprints, and launches Claude Code CLI wiring jobs in tmux. Out of scope: multi-user auth, remote public registry publishing, hosted SaaS deployment, billing, enterprise RBAC, and unattended extraction without approval.

## Implementation Scope

**Capabilities**:

1. Create and manage repo-scoped sessions for repository analysis, candidate discovery, extraction, registry publishing, blueprint validation, and wiring jobs.
2. Persist operational state in SQLite and persist large/generated documents as local filesystem artifacts referenced from SQLite.
3. Run repo analysis, extraction, testing, registry comparison, documentation, blueprint validation, and wiring agents through a generic agent-runner interface whose first implementation launches Claude Code CLI in tmux.
4. Present a local web UI for repositories, sessions, candidates, modules, blueprints, agent jobs, and a React Flow workbench.
5. Validate typed module ports and emit semantic blueprint documents separately from React Flow layout documents.

**Guard rails**:

- Backend MUST be implemented in Go `1.26.3` or a later patch release within the Go `1.26.x` line.
- Frontend MUST be implemented in this repo with TypeScript, React, React Flow, and Vite.
- The app MUST run as a local single-user process with no login, no roles, and no remote account dependency.
- The first agent provider MUST be Claude Code CLI launched in tmux through the generic agent interface.
- The system MUST use local filesystem documents plus SQLite; it MUST NOT require Postgres, Redis, hosted queues, or cloud object storage.
- Analysis concurrency MUST default to `4`, extraction concurrency MUST default to `2`, and wiring concurrency MUST default to `1`.
- Repo analysis agents MUST operate on one repository session at a time and MUST NOT perform global multi-repo analysis.
- No extraction job MAY start until the relevant candidate is explicitly approved by the user.

## Existing Codebase Context

| Area | Existing files | Required change |
|------|----------------|-----------------|
| Feature brief | `ai_code_workbench.md` | Use as product and architecture source material for the implementation spec. |
| Portfolio catalog | `../CATALOG_AS_OF_20260410_002616.md` | Use as the candidate inventory for local reuse/reference code before implementing new infrastructure. |
| Project root | `.` | Add greenfield backend, frontend, migrations, local storage directories, tests, and developer commands. |
| Local skills | `.agents/skills/plan-spec` | No runtime dependency; only used to format this specification. |

## Implementation Candidate Inventory

The implementation agent should review these local candidates before writing equivalent infrastructure. Reuse means adapting code into this repo with package names, tests, ownership boundaries, and the Workbench Go `1.26.3` toolchain adjusted for Code Workbench. Reference means inspect the implementation pattern, but do not copy the module wholesale. Adapted Go code MUST be tested under Go `1.26.3` or a later Go `1.26.x` patch release, and copied `go.mod` versions from source repos MUST NOT downgrade the Workbench toolchain.

| Candidate | Location | Reuse posture | Applicable surfaces | Implementation use |
|-----------|----------|---------------|---------------------|--------------------|
| AgentBridge coordinator | `../agentbridge` | Adapt/reference | Agent adapters, workspace isolation, browser dashboard, WebSocket events, human gates, task lifecycle | Use `adapter_claude.go`, `adapter_exec.go`, `workspace.go`, `server.go`, `hub.go`, and `coordinator.go` as references for the generic agent provider, isolated workspaces, event streaming, and human decision gates. Do not copy its spec-review workflow model as the Code Workbench domain model. |
| Cortex Claude CLI runner | `../cortex/internal/claudecli` | Adapt | Claude Code CLI invocation, JSON envelope parsing, timeout handling, structured output parsing | Use as the strongest starting point for the Claude provider's process execution and output parsing. Wrap it with the tmux session behavior required by FR-012 rather than using it as a plain one-shot runner. |
| Cortex operational logging | `../cortex/internal/opslog` | Adapt | Structured JSONL logs, append serialization, log rotation, file permissions | Use as the reference for local job and API operational logs. Align fields with this spec's job IDs, subject IDs, provider, role, and phase transitions. |
| cc-top SQLite storage | `../cc-top/internal/storage` | Adapt | SQLite opening, WAL mode, foreign keys, busy timeout, migrations, retention patterns | Use for the local SQLite persistence skeleton and migration style. Replace cc-top telemetry tables with DM-001 through DM-008. |
| cc-top Claude telemetry | `../cc-top/internal/receiver`, `../cc-top/internal/scanner`, `../cc-top/internal/events`, `../cc-top/internal/alerts` | Reference/adapt | OTLP receiver, Claude process/session discovery, event buffers, alerts, kill controls | Use for agent observability and job monitoring once basic job state works. The Workbench UI should expose job health without importing the TUI. |
| Task Templating validator | `../task_templating/internal/validator`, `../task_templating/schemas` | Adapt | JSON Schema validation plus semantic graph validation | Use the two-tier validation model for CandidateReport, ModuleManifest, Blueprint, and Flow Layout documents: structural schema validation first, semantic validation second. |
| Allium validator | `../allium/internal/schema`, `../allium/internal/semantic`, `../allium/internal/report` | Reference/adapt | State-machine checks, uniqueness/reference validation, report formatting | Use as a reference for session and candidate transition validators, semantic blueprint diagnostics, and user-readable validation reports. |
| Adversarial Spec System orchestration | `../adversarial_spec_system/internal/specworkflow`, `../adversarial_spec_system/internal/codereview`, `../adversarial_spec_system/internal/codedoc`, `../adversarial_spec_system/internal/api` | Reference/adapt | Multi-agent orchestration, provider boundaries, workflow gates, process/log APIs, WebSocket/log streaming | Use for orchestration and API patterns where they fit. Keep Code Workbench roles limited to repo analysis, extraction, module test, registry comparison, documentation, blueprint validation, and wiring. |
| Claude Peers MCP | `../claude-peers-mcp` | Reference only | Session discovery and message exchange between Claude sessions | Use only as a reference for cross-session communication patterns. This spec does not require MCP peer messaging in the core implementation. |
| Mempalace | `../mempalace` | Reference only | Durable memory, retrieval, MCP server, conversation mining | Use as a reference for artifact search and provenance ideas. Do not add memory/retrieval subsystems to this implementation unless a separate spec expands the scope. |
| Cortex knowledge pipeline | `../cortex/internal/ingest`, `../cortex/internal/recall`, `../cortex/internal/write`, `../cortex/internal/prompts`, `../cortex/internal/pagination` | Reference only | Ingest pipelines, recall APIs, prompt sanitization, pagination helpers | Use for API and prompt hygiene patterns. Do not add graph/vector knowledge storage to this implementation. |

## Terminology

| Term | Definition |
|------|------------|
| Repository | A source repository supplied by the user as a local path or clone URL. |
| Repo Session | A single analysis and extraction lifecycle scoped to one repository checkout or worktree. |
| Candidate | A proposed reusable module discovered in one repo session. A candidate is not a module. |
| Extraction Plan | A document created from approved candidates that constrains extraction work. |
| Module | Extracted reusable code with tests, manifest, typed ports, config schema, docs, and provenance. |
| Module Manifest | A persisted document describing a registered module, including ports and provenance. |
| Registry | The local SQLite and filesystem-backed source of truth for registered modules. |
| Workbench | The React Flow canvas where registered modules are composed visually. |
| Blueprint | A semantic architecture document emitted by the workbench; it excludes visual layout state. |
| Flow Layout | React Flow visual state, including positions, viewport, and selection metadata. |
| Agent Job | A queued or running invocation of an agent role through a provider implementation. |
| Agent Provider | A backend adapter that can start, monitor, and stop an agent process. |

## Surface / API Inventory

### New surfaces

- `GET /api/health` - reports local backend health, database status, storage status, and worker status.
- `GET /api/config` - returns concurrency limits, storage paths, and enabled agent providers.
- `POST /api/repositories` - registers a repository from a local path or clone URL.
- `GET /api/repositories` - lists known repositories.
- `POST /api/sessions` - creates repo sessions from registered repositories.
- `GET /api/sessions` - lists sessions with phase, worker, and artifact summary.
- `GET /api/sessions/{sessionId}` - returns one session with intent, phase, artifacts, and jobs.
- `GET /api/sessions/{sessionId}/files?path={relativePath}` - returns source file content from the session checkout after path validation.
- `POST /api/sessions/{sessionId}/intent` - stores repo-scoped extraction intent.
- `POST /api/sessions/{sessionId}/analysis-jobs` - queues an analysis job.
- `GET /api/candidates` - lists candidates with filtering by session, repo, status, risk, confidence, and capability.
- `PATCH /api/candidates/{candidateId}` - modifies candidate fields that are user-editable.
- `POST /api/candidates/{candidateId}/approve` - approves a candidate and records approval metadata.
- `POST /api/candidates/{candidateId}/reject` - rejects a candidate with a reason.
- `POST /api/candidates/{candidateId}/defer` - defers a candidate with a reason.
- `POST /api/candidates/{candidateId}/duplicate` - marks a candidate as duplicate with a reason and optional duplicate module ID.
- `POST /api/candidates/{candidateId}/rescan` - queues a scoped rescan for one candidate or session.
- `POST /api/extraction-plans` - creates extraction plans from approved candidates.
- `GET /api/extraction-plans/{planId}` - returns an extraction plan document and status.
- `POST /api/extraction-plans/{planId}/jobs` - queues extraction jobs.
- `GET /api/modules` - lists registered modules available to the registry and workbench.
- `GET /api/modules/{moduleId}` - returns manifest, provenance, ports, docs paths, and test status.
- `POST /api/modules/{moduleId}/compare` - runs duplicate or overlap comparison against the local registry.
- `GET /api/workbench/palette` - returns registered modules as draggable node definitions.
- `POST /api/blueprints` - creates a blueprint from semantic document and flow layout.
- `GET /api/blueprints` - lists blueprints.
- `GET /api/blueprints/{blueprintId}` - returns blueprint metadata and document paths.
- `PATCH /api/blueprints/{blueprintId}` - updates semantic and visual blueprint documents.
- `POST /api/blueprints/{blueprintId}/validate` - validates typed ports, required config, duplicate node IDs, and runtime output.
- `POST /api/blueprints/{blueprintId}/wiring-jobs` - queues a Claude Code CLI wiring job in tmux.
- `GET /api/agent-jobs` - lists agent jobs with provider, role, status, tmux session, and artifacts.
- `GET /api/agent-jobs/{jobId}` - returns one agent job and recent status.
- `POST /api/agent-jobs/{jobId}/open` - returns a tmux attach command for the running job.
- `POST /api/agent-jobs/{jobId}/cancel` - cancels queued jobs or stops running jobs.

### Modified surfaces

- None. This is a greenfield implementation inside the current repo.

### Deferred From This Spec

- Remote public module registry publishing - excluded because the confirmed persistence target is local filesystem documents plus SQLite.
- Multi-user authentication and role authorization - excluded because the confirmed runtime is local single-user with no auth surface.
- Non-Claude agent providers - excluded because the first provider is Claude Code CLI; the provider interface exists only to support test doubles and keep provider execution isolated.
- Hosted deployment automation - excluded because the workbench runs locally and generated systems are emitted as local artifacts.
- In-app candidate follow-up chat - excluded because candidate clarification requires a separate conversation model beyond the extraction approval workflow.
- Data deletion and archival APIs - excluded because the local data directory is append-only for this implementation; users may remove the configured data directory manually when they want a full reset.

## Data Model Changes

**DM-001**: Add table `repositories`

```sql
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('local_path', 'git_url')),
  source_uri TEXT NOT NULL,
  default_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_type, source_uri)
);
```

**DM-002**: Add table `repo_sessions`

```sql
CREATE TABLE repo_sessions (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  repo_name TEXT NOT NULL,
  checkout_path TEXT NOT NULL,
  scratch_path TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'created',
    'awaiting_user_intent',
    'ready_for_analysis',
    'queued',
    'analysing',
    'candidates_ready',
    'awaiting_approval',
    'extraction_planned',
    'extracting',
    'extracted',
    'registered',
    'available_in_workbench',
    'failed_analysis',
    'failed_extraction',
    'needs_user_input',
    'paused',
    'cancelled',
    'duplicate_detected',
    'conflict_detected'
  )),
  intent_json_path TEXT,
  candidate_report_path TEXT,
  extraction_plan_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Valid session phase transitions:

| From | To |
|------|----|
| `created` | `awaiting_user_intent`, `cancelled` |
| `awaiting_user_intent` | `ready_for_analysis`, `needs_user_input`, `cancelled` |
| `ready_for_analysis` | `queued`, `needs_user_input`, `cancelled` |
| `queued` | `analysing`, `paused`, `cancelled` |
| `analysing` | `candidates_ready`, `failed_analysis`, `needs_user_input`, `cancelled` |
| `candidates_ready` | `awaiting_approval`, `duplicate_detected`, `conflict_detected`, `cancelled` |
| `awaiting_approval` | `extraction_planned`, `needs_user_input`, `cancelled` |
| `extraction_planned` | `extracting`, `paused`, `cancelled` |
| `extracting` | `extracted`, `failed_extraction`, `needs_user_input`, `cancelled` |
| `extracted` | `registered`, `duplicate_detected`, `conflict_detected` |
| `registered` | `available_in_workbench`, `conflict_detected` |
| `failed_analysis` | `ready_for_analysis`, `cancelled` |
| `failed_extraction` | `extraction_planned`, `cancelled` |
| `needs_user_input` | `ready_for_analysis`, `awaiting_approval`, `extraction_planned`, `cancelled` |
| `paused` | `queued`, `extracting`, `cancelled` |
| `duplicate_detected` | `awaiting_approval`, `cancelled` |
| `conflict_detected` | `awaiting_approval`, `extraction_planned`, `cancelled` |

**DM-003**: Add table `candidates`

```sql
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES repo_sessions(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  proposed_name TEXT NOT NULL,
  description TEXT NOT NULL,
  module_kind TEXT NOT NULL,
  target_language TEXT NOT NULL DEFAULT 'go',
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  extraction_risk TEXT NOT NULL CHECK (extraction_risk IN ('low', 'medium', 'high')),
  status TEXT NOT NULL CHECK (status IN (
    'proposed',
    'modified',
    'approved',
    'rejected',
    'deferred',
    'needs_rescan',
    'extraction_planned',
    'extracting',
    'extracted',
    'duplicate_detected',
    'merge_required',
    'registered',
    'available_in_workbench'
  )),
  source_paths_json TEXT NOT NULL,
  ports_json TEXT NOT NULL,
  workbench_node_json TEXT NOT NULL,
  report_path TEXT NOT NULL,
  user_reason TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Valid candidate status transitions:

| From | To |
|------|----|
| `proposed` | `modified`, `approved`, `rejected`, `deferred`, `needs_rescan`, `duplicate_detected` |
| `modified` | `approved`, `rejected`, `deferred`, `needs_rescan`, `duplicate_detected` |
| `approved` | `extraction_planned`, `needs_rescan`, `duplicate_detected` |
| `rejected` | `needs_rescan` |
| `deferred` | `modified`, `approved`, `rejected`, `needs_rescan` |
| `needs_rescan` | `proposed`, `modified`, `rejected` |
| `extraction_planned` | `extracting`, `merge_required`, `duplicate_detected` |
| `extracting` | `extracted`, `merge_required`, `duplicate_detected`, `needs_rescan` |
| `extracted` | `registered`, `merge_required`, `duplicate_detected` |
| `duplicate_detected` | `merge_required`, `rejected`, `needs_rescan` |
| `merge_required` | `registered`, `rejected`, `needs_rescan` |
| `registered` | `available_in_workbench` |

**DM-004**: Add table `extraction_plans`

```sql
CREATE TABLE extraction_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES repo_sessions(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'extracting', 'extracted', 'failed', 'cancelled')),
  plan_path TEXT NOT NULL,
  approved_candidate_ids_json TEXT NOT NULL,
  rejected_candidate_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**DM-005**: Add table `modules`

```sql
CREATE TABLE modules (
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
  test_status TEXT NOT NULL CHECK (test_status IN ('not_run', 'passing', 'failing')),
  available_in_workbench INTEGER NOT NULL DEFAULT 0 CHECK (available_in_workbench IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(name, version)
);
```

**DM-006**: Add table `blueprints`

```sql
CREATE TABLE blueprints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  semantic_document_path TEXT NOT NULL,
  flow_layout_path TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('not_run', 'valid', 'invalid')),
  validation_report_path TEXT,
  target_language TEXT NOT NULL DEFAULT 'go',
  output_kind TEXT NOT NULL CHECK (output_kind IN ('service', 'cli', 'daemon', 'worker', 'library')),
  package_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**DM-007**: Add table `agent_jobs`

```sql
CREATE TABLE agent_jobs (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN (
    'repo_analysis',
    'extraction',
    'module_test',
    'registry_comparison',
    'documentation',
    'blueprint_validation',
    'wiring'
  )),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('session', 'candidate', 'extraction_plan', 'module', 'blueprint')),
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
);
```

Active job uniqueness:

```sql
CREATE UNIQUE INDEX agent_jobs_one_active_role_per_subject
ON agent_jobs(role, subject_type, subject_id)
WHERE status IN ('queued', 'running');
```

**DM-008**: Add table `settings`

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Migration / backfill notes:

- Initial migration creates all tables in an empty SQLite database at `<workspace>/data/workbench.sqlite`.
- The app creates `<workspace>/data/documents`, `<workspace>/data/sessions`, `<workspace>/data/modules`, `<workspace>/data/blueprints`, and `<workspace>/data/jobs` on startup if missing.
- SQLite rows store metadata and document paths; candidate reports, extraction plans, manifests, schemas, transcripts, blueprint documents, and flow layouts are stored as filesystem documents.
- Rejected candidate IDs on extraction plans are stored only for provenance and for extraction prompts to avoid previously rejected surfaces; extraction jobs MUST NOT operate on those IDs.
- Data deletion and archival are not implemented by this spec; foreign-key cascades exist for data integrity if a later migration adds delete APIs, but this implementation does not expose those APIs.

## Functional Requirements

### Foundation and Runtime

- **FR-001** (MUST): The backend MUST compile and run with Go `1.26.3` or a later Go `1.26.x` patch release and expose one local HTTP server process that serves `/api/*` and the frontend build on a configurable host and port.
- **FR-002** (MUST): On startup, the backend MUST open or create a SQLite database at the configured data directory and apply idempotent migrations for all tables in DM-001 through DM-008.
- **FR-003** (MUST): On startup, the backend MUST create the document directories `documents`, `sessions`, `modules`, `blueprints`, and `jobs` under the configured data directory when they do not exist.
- **FR-004** (MUST): The backend MUST expose configured worker limits of analysis `4`, extraction `2`, and wiring `1` through `GET /api/config` and enforce those limits in the job scheduler.
- **FR-005** (SHOULD): The project SHOULD include developer commands that run backend tests, frontend tests, all tests, local dev server, and production build with one command each; production mode MUST serve embedded frontend assets from the Go server, development mode MUST proxy `/api/*` from the frontend dev server to the Go backend, and non-API non-static production routes MUST return `index.html` for SPA routing.

### Repository and Session Lifecycle

- **FR-006** (MUST): The system MUST register repositories from either a local filesystem path or a Git clone URL and reject duplicate `(source_type, source_uri)` pairs with `409 repository.duplicate`; `local_path` values MUST be readable directories containing `.git`, `git_url` values MUST use `https://`, `ssh://`, or `git@host:owner/repo.git` syntax, and credentials beyond the user's existing local Git configuration are not accepted.
- **FR-007** (MUST): Creating a repo session MUST allocate a unique `sessionId`, create an isolated checkout or worktree directory, create a scratch directory, persist a `repo_sessions` row, and set phase to `awaiting_user_intent`; Git URLs MUST be cloned during session creation into `data/sessions/{sessionId}/repo`, clone failures MUST return `502 repository.clone_failed`, and failed partial checkout directories MUST be removed before the response is returned.
- **FR-008** (MUST): Each repo session MUST store user extraction intent as a JSON document containing `specificFunctionality`, `areasOfInterest`, `sourceHints`, `avoidPatterns`, `preferredTargetLanguage`, and `allowAgentDiscovery`.
- **FR-009** (MUST): Storing session intent MUST set phase to `ready_for_analysis` and MUST NOT create an `agent_jobs` row; a session MUST NOT queue analysis until intent is recorded, and if the user has no suggestions, `allowAgentDiscovery` MUST be `true`.
- **FR-010** (MUST): Session phase transitions MUST be validated against the state machine in DM-002 and invalid transitions MUST return `409 session.invalid_transition`; transition writes MUST use optimistic locking on the caller's last seen `updated_at` value and return `409 state.conflict` when another tab or request updated the row first.

### Agent Runner and tmux

- **FR-011** (MUST): The backend MUST define an `AgentProvider` interface with `Start(ctx, job)`, `Open(ctx, job)`, `Cancel(ctx, job)`, and `Status(ctx, job)` methods.
- **FR-012** (MUST): The first provider implementation MUST launch Claude Code CLI inside a named tmux session using the job prompt file as input context, with process `cwd` set to an isolated job workspace under `data/jobs/{jobId}/workspace`, writable output root set to the role's output directory, read roots copied or mounted under `data/jobs/{jobId}/workspace/read`, denied paths including the Workbench repo root outside the job workspace, the user's real home directory, `.ssh`, `.config`, and any path outside the job workspace, and a fixed environment allowlist containing only `PATH`, `HOME`, `TMPDIR`, `SHELL`, `TERM`, and Workbench-provided job variables where `HOME` is `data/jobs/{jobId}/home`; the provider MUST persist the tmux session name in `agent_jobs.tmux_session_name`, MUST invoke Claude Code with `--bare`, `--permission-mode acceptEdits`, `--allowedTools Read,Grep,Glob,Edit,Write,MultiEdit,Bash(git *),Bash(go test *),Bash(go list *)`, `--disallowedTools WebFetch,WebSearch`, and no `--add-dir` outside the job workspace, MUST add an OS-level filesystem sandbox or equivalent wrapper that denies writes outside the writable output root before the process starts, and default timeouts MUST be analysis `1800` seconds, extraction `3600` seconds, module test `1800` seconds, registry comparison `900` seconds, documentation `1800` seconds, blueprint validation `900` seconds, and wiring `3600` seconds.
- **FR-013** (MUST): The `POST /api/agent-jobs/{jobId}/open` endpoint MUST return the tmux session name and attach command for a running job, MUST NOT claim terminal focus, and MUST return `409 agent_job.not_running` when the job has no active tmux session.
- **FR-014** (MUST): Agent prompts MUST be generated with Go `text/template` from files under `templates/prompts/{role}.md.tmpl`, rendered with the role's subject metadata, relevant artifact paths, read roots, writable output root, denied path rules, and required JSON output contract, and stored under `data/jobs/{jobId}/prompt.md` before a job is started.
- **FR-015** (MUST): Agent transcripts and produced artifacts MUST be stored under the role-specific output root in `data/jobs/{jobId}` or `data/blueprints/{blueprintId}/generated/{jobId}`, linked from the `agent_jobs` row before the job is marked `succeeded`, and accepted only after the backend resolves every produced path with `realpath` and verifies it remains inside the allowed output root; the provider MUST detect completion by monitoring the tmux-launched process exit code and MUST poll running jobs every `5` seconds while the backend is active.
- **FR-016** (SHOULD): The agent provider interface SHOULD allow a fake provider for tests without changing database schema or API request shapes.

### Candidate Discovery and Review

- **FR-017** (MUST): A repo analysis job MUST inspect only the assigned session checkout and MUST emit one CandidateReport JSON document at `data/jobs/{jobId}/candidate-report.json`; the backend MUST automatically import that document when the job status becomes `succeeded`.
- **FR-018** (MUST): Every candidate persisted from a CandidateReport MUST include a globally unique candidate ID, session ID, repo ID, proposed name, description, source paths, reusable rationale, coupling notes, dependencies, side effects, tests found, missing tests, target language, module kind, extraction risk, confidence, proposed ports, and workbench node shape.
- **FR-019** (MUST): Candidate IDs MUST be namespaced by session ID using the pattern `{sessionId}.cand.{threeDigitSequence}`.
- **FR-020** (MUST): The candidate review API and UI MUST support approve, reject, modify, defer, request rescan, mark duplicate, and view source actions; modify MUST be allowed only when current status is `proposed` or `deferred` and otherwise return `409 candidate.invalid_transition`, mark duplicate MUST set status `duplicate_detected`, request rescan MUST set status `needs_rescan`, and view source MUST read from `GET /api/sessions/{sessionId}/files?path={relativePath}` rather than from arbitrary filesystem paths.
- **FR-021** (MUST): Candidate approval MUST require a non-empty user reason with at least `3` non-whitespace characters, MUST persist that reason in `candidates.user_reason`, MUST record approval timestamp, and MUST be required before a candidate can be included in an extraction plan.
- **FR-022** (MUST): Reject, defer, and duplicate actions MUST require a non-empty user reason with at least `3` non-whitespace characters.

### Extraction and Registry

- **FR-023** (MUST): Creating an extraction plan MUST include only candidates with status `approved` and MUST reject any unapproved candidate ID with `409 candidate.not_approved`; rejected candidate IDs on the plan are provenance-only exclusions included in the extraction prompt and MUST NOT be acted on by extraction jobs.
- **FR-024** (MUST): Extraction jobs MUST read the extraction plan document as the source of truth and MUST operate only on the candidates listed in that plan.
- **FR-025** (MUST): Extracted modules MUST NOT be registered until module source code, tests, manifest, typed ports, configuration schema, provenance metadata, docs, semver version, and test status are all present; the first successful extraction of a candidate MUST use version `0.1.0`, and a later successful re-extraction of the same candidate MUST create the next minor version such as `0.2.0` rather than replacing an existing module row.
- **FR-026** (MUST): A module MUST be marked `available_in_workbench = 1` only when `test_status = 'passing'` and manifest, ports, and config schema parse successfully.
- **FR-027** (MUST): Registry comparison MUST classify overlaps as exactly one of `new_module`, `duplicate`, `variant`, `adapter_needed`, `merge_candidate`, or `reject_duplicate` using these decision rules: `duplicate` when capability overlap is at least `0.90`, port names and types are identical, and source path overlap is at least `0.50`; `variant` when capability overlap is at least `0.70` but at least one port or configuration field differs; `adapter_needed` when capability overlap is at least `0.70` and all required inputs/outputs can be mapped with declared adapters but are not identical; `merge_candidate` when capability overlap is at least `0.50`, dependencies or source paths overlap, and test/doc maturity is higher in different modules; `reject_duplicate` when a candidate duplicates a lower-quality existing module and user approval is required before rejection; otherwise `new_module`.
- **FR-028** (SHOULD): Extraction output SHOULD target Go modules by default unless the approved candidate explicitly specifies another target language.

### Workbench and Blueprint

- **FR-029** (MUST): The workbench palette MUST list only modules where `available_in_workbench = 1` and MUST select the highest semver version by default when multiple versions share a module name.
- **FR-030** (MUST): Workbench nodes MUST expose typed input and output ports derived from the module manifest and MUST preserve required versus optional input markers; port names MUST match `^[a-z][a-z0-9_]{0,63}$`, port types MUST match `^[A-Z][A-Za-z0-9]*(<([A-Z][A-Za-z0-9]*)(,[A-Z][A-Za-z0-9]*)*>)?$`, and type comparison MUST be case-sensitive exact string equality after trimming ASCII whitespace.
- **FR-031** (MUST): The workbench MUST reject edges where the source output port type does not exactly match the target input port type, returning `422 blueprint.port_type_mismatch`; the validation report MAY include a non-blocking warning for near-miss type strings but MUST NOT allow the edge.
- **FR-032** (MUST): The workbench MUST store semantic blueprint state separately from React Flow layout state as `semantic_document_path` and `flow_layout_path`.
- **FR-033** (MUST): Blueprint validation MUST check unique node IDs, module references, required input connections, port type compatibility, required config values, target language, output kind, and package name against the Blueprint Semantic Document schema referenced from the OpenAPI components.
- **FR-034** (MUST): A wiring job MUST NOT start unless the blueprint validation status is `valid`.
- **FR-035** (MUST): The wiring agent MUST read the semantic blueprint document and generate local output artifacts under `data/blueprints/{blueprintId}/generated/{jobId}`.

### UI

- **FR-036** (MUST): The UI MUST include screens for Repositories, Sessions, Candidates, Modules, Workbench, Blueprints, and Agent Jobs.
- **FR-037** (MUST): The Sessions screen MUST show repo name, session phase, active job role, timestamps, and next action for each session.
- **FR-038** (MUST): The Candidates screen MUST group candidates by repo session and filter by session, repo, status, risk, confidence, and capability.
- **FR-039** (MUST): The Modules screen MUST show name, version, source repo, source candidate, language, kind, capabilities, ports, test status, docs path, and workbench availability.
- **FR-040** (MUST): The Workbench screen MUST provide module palette, React Flow canvas, inspector, validation status, save action, validate action, and generate code action.
- **FR-041** (MUST): The Agent Jobs screen MUST show queued, running, succeeded, failed, and cancelled jobs with provider, role, subject, tmux session name, timestamps, and open/cancel actions, and MUST poll `GET /api/agent-jobs/{jobId}` every `5` seconds for visible running jobs.

### Security, Safety, and Failure Handling

- **FR-042** (MUST): The backend MUST configure allowed local repository roots from repeated `--allowed-root` flags or `CODE_WORKBENCH_ALLOWED_ROOTS` path-list values; when neither is set, allowed roots default to the backend startup working directory, when the configured list is explicitly empty local path registration is denied, `local_path` repositories outside allowed roots return `400 path.invalid`, and cloned Git repositories are always placed under the configured data directory.
- **FR-043** (MUST): The backend MUST sanitize filesystem artifact paths and source-file paths by rejecting absolute paths, `..` segments, and `\` separators before lookup, then using `lstat` plus `realpath` containment checks; every resolved source file or artifact target MUST remain under the session checkout or allowed artifact root, escaping symlinks MUST return `400 path.invalid`, and valid in-tree symlinks MAY be read only after resolved containment succeeds.
- **FR-044** (MUST): Failed, timed out, interrupted, or malformed-output analysis, extraction, validation, or wiring jobs MUST persist `status = 'failed'`, `error_code`, transcript path when available, and a user-visible error message.
- **FR-045** (MUST): The scheduler MUST leave queued jobs queued when worker capacity is exhausted, MUST start them automatically when capacity becomes available, MUST stop starting new jobs on `SIGINT` or `SIGTERM`, MUST mark jobs that exceed `timeout_seconds` as `failed` with `error_code = 'job.timeout'`, and MUST reconcile jobs left `running` on startup by marking them `failed` with `error_code = 'job.interrupted'` unless the provider can prove the tmux process is still active.
- **FR-046** (SHOULD): The backend SHOULD emit structured JSON logs for API requests, job lifecycle events, state transitions, artifact writes, timeout events, and startup reconciliation events.
- **FR-047** (MUST): The repo MUST include `openapi.yaml` as the source of truth for every `/api/*` endpoint, including request bodies, path/query parameters, response bodies, status codes, error responses, pagination fields, enum values, string length and pattern validation, unknown-field rejection, and shared artifact schemas; backend request/response validation and frontend API types MUST be generated from or checked against this OpenAPI document, and CI MUST fail when implemented routes drift from `openapi.yaml`.

## API / Schema Contracts

`openapi.yaml` is the source of truth for all endpoint contracts. Markdown prose in this spec may name endpoints and behavior, but it MUST NOT duplicate request/response schemas or per-endpoint validation rules that belong in OpenAPI.

The OpenAPI document MUST define every surface listed in Surface / API Inventory, including:

- Operation IDs, tags, path parameters, query parameters, request bodies, response bodies, status codes, and `application/json` content types.
- Shared components for repositories, sessions, candidates, extraction plans, modules, blueprints, agent jobs, errors, pagination envelopes, ports, CandidateReport, ModuleManifest, module config schema metadata, registry comparison reports, blueprint semantic documents, blueprint validation reports, flow layout documents, and wiring output manifests.
- Validation constraints for all external input: required fields, unknown-field rejection, enum values, string trimming semantics, string lengths, regex patterns, array bounds, pagination defaults and maximums, optimistic-lock `expectedUpdatedAt` fields, source path syntax, and reason text bounds.
- Error responses using the Error Contract codes below, with a shared error body component `{ "error": { "code": "string", "message": "string", "details": {} } }`.
- Job-queue idempotency responses: queueing an already-active `(role, subjectType, subjectId)` returns `200` with the existing job; creating a new queued job returns `202`.
- File-read and artifact-write safety semantics that cannot be fully expressed in JSON Schema, including `lstat`, `realpath` containment, symlink escape rejection, and allowed-root behavior, as endpoint descriptions and testable operation requirements.

Runtime configuration source:

- `--data-dir` sets the data directory; default is `data` relative to the backend startup working directory.
- `--allowed-root` MAY be repeated; `CODE_WORKBENCH_ALLOWED_ROOTS` MAY supply the same values as an OS path-list when the flag is absent.
- If neither allowed-root source is set, `allowedRoots` defaults to the backend startup working directory.
- If the allowed-root source is present but empty, `allowedRoots` is `[]` and `POST /api/repositories` MUST reject every `local_path` repository with `400 path.invalid`.
- Git URL sessions clone only under `data/sessions/{sessionId}/repo`; user-supplied clone destinations are not accepted.

Agent output files MUST be validated against the schemas referenced from OpenAPI components, then by semantic validation where success checks require database or filesystem consistency. A job MUST remain or become `failed` with the relevant Error Contract code when any required file is missing, invalid, or outside the allowed output root.

## Error Contract

| Condition | Status | Error code | Notes |
|-----------|--------|------------|-------|
| Malformed JSON body | 400 | `request.invalid_json` | User-visible; not retryable without changing request. |
| Missing required field | 400 | `request.missing_field` | User-visible; includes field name. |
| Unknown request field | 400 | `request.unknown_field` | User-visible; includes field name. |
| Invalid enum value | 400 | `request.invalid_enum` | User-visible; includes allowed values. |
| Invalid filesystem path | 400 | `path.invalid` | User-visible; path traversal, escaping symlinks, and disallowed roots are rejected. |
| Resource not found | 404 | `resource.not_found` | User-visible; not retryable without changing ID. |
| Duplicate repository | 409 | `repository.duplicate` | User-visible; existing repository ID returned in details. |
| Invalid session transition | 409 | `session.invalid_transition` | User-visible; current phase and requested phase returned. |
| Concurrent state update conflict | 409 | `state.conflict` | User-visible; refresh required before retry. |
| Candidate not approved | 409 | `candidate.not_approved` | User-visible; extraction plan creation is blocked. |
| Invalid candidate transition | 409 | `candidate.invalid_transition` | User-visible; immutable candidate status is returned in details. |
| Agent job has no running tmux session | 409 | `agent_job.not_running` | User-visible; open action unavailable. |
| Blueprint invalid | 409 | `blueprint.invalid` | User-visible; wiring job is blocked. |
| Port type mismatch | 422 | `blueprint.port_type_mismatch` | User-visible; returned during edge creation or validation. |
| CandidateReport invalid | 422 | `candidate_report.invalid` | User-visible; import is rejected transactionally. |
| Module output invalid | 422 | `module_output.invalid` | User-visible; extraction output is incomplete or schema-invalid. |
| Agent job timed out | 504 | `job.timeout` | User-visible and logged; retryable by queuing a new job after inspection. |
| Agent job interrupted by backend restart | 500 | `job.interrupted` | User-visible and logged; retryable by queuing a new job. |
| Repository clone failed | 502 | `repository.clone_failed` | User-visible and logged; retryable after URL, network, or local Git credential fix. |
| Agent provider failed to start | 502 | `agent_provider.start_failed` | User-visible and logged; retryable after configuration fix. |
| Artifact write failed | 500 | `artifact.write_failed` | User-visible and logged; retryable after filesystem fix. |
| SQLite operation failed | 500 | `database.operation_failed` | Logged with operation name; user sees generic local database failure. |

## Behavioral Scenarios

### Scenario: User registers a local repository

**Traces to**: FR-006
**Category**: Happy Path

- **Given** the backend is running with an empty repository table
- **When** the user registers a repository with `sourceType` equal to `local_path` and a readable source URI
- **Then** the API returns `201`
- **And** the repository appears in `GET /api/repositories`

### Scenario: User cannot register the same repository twice

**Traces to**: FR-006
**Category**: Error Path

- **Given** a repository exists with `sourceType` equal to `git_url` and `sourceUri` equal to `git@github.com:example/repo.git`
- **When** the user registers another repository with the same source type and URI
- **Then** the API returns `409`
- **And** the error code is `repository.duplicate`

### Scenario: User creates session and records repo intent

**Traces to**: FR-007, FR-008, FR-009, FR-010
**Category**: Happy Path

- **Given** a registered repository exists
- **When** the user creates a session and submits intent with `allowAgentDiscovery` equal to `true`
- **Then** the session phase becomes `ready_for_analysis`
- **And** an intent JSON document exists under the session directory
- **And** no analysis `agent_jobs` row exists until `POST /api/sessions/{sessionId}/analysis-jobs` succeeds

### Scenario: Analysis cannot start without intent

**Traces to**: FR-009, FR-010
**Category**: Error Path

- **Given** a session exists in phase `awaiting_user_intent`
- **When** the user queues an analysis job for that session
- **Then** the API returns `409`
- **And** the error code is `session.invalid_transition`

### Scenario: Git clone failure leaves no partial session checkout

**Traces to**: FR-006, FR-007
**Category**: Error Path

- **Given** a registered repository has `sourceType` equal to `git_url` and an unreachable `sourceUri`
- **When** the user creates a session for that repository
- **Then** the API returns `502`
- **And** the error code is `repository.clone_failed`
- **And** no partial `data/sessions/{sessionId}/repo` directory remains

### Scenario: Concurrent session transition is rejected

**Traces to**: FR-010
**Category**: Edge Case

- **Given** two browser tabs read the same session with the same `updatedAt` value
- **When** both tabs submit different phase-changing actions and the first action succeeds
- **Then** the second action returns `409`
- **And** the error code is `state.conflict`

### Scenario: Startup creates database and document directories

**Traces to**: FR-001, FR-002, FR-003, FR-004, FR-005
**Category**: Happy Path

- **Given** the configured data directory is empty
- **When** the backend starts
- **Then** SQLite migrations are applied
- **And** all required document directories exist
- **And** `GET /api/config` reports analysis limit `4`, extraction limit `2`, and wiring limit `1`

### Scenario: Startup reports blocked storage

**Traces to**: FR-002, FR-003
**Category**: Error Path

- **Given** the configured data directory is not writable
- **When** the backend starts
- **Then** startup fails with a logged storage error
- **And** no HTTP server starts

### Scenario: Analysis job launches Claude Code in tmux

**Traces to**: FR-011, FR-012, FR-013, FR-014, FR-015, FR-016
**Category**: Happy Path

- **Given** a session is in phase `ready_for_analysis` with recorded intent
- **When** the user queues an analysis job with provider `claude_code_tmux`
- **Then** an agent job is created with role `repo_analysis`
- **And** the session phase becomes `queued`
- **And** a tmux session name is persisted when the job starts
- **And** the Claude Code process runs with `cwd` under `data/jobs/{jobId}/workspace`
- **And** produced artifacts are accepted only when their resolved paths remain under the allowed output root
- **And** opening the job returns `tmuxSessionName` and `attachCommand`

### Scenario: Opening inactive tmux job is rejected

**Traces to**: FR-013
**Category**: Error Path

- **Given** an agent job has status `succeeded`
- **When** the user opens the job tmux session
- **Then** the API returns `409`
- **And** the error code is `agent_job.not_running`

### Scenario: Duplicate analysis queue request returns active job

**Traces to**: FR-012, FR-015, FR-045
**Category**: Edge Case

- **Given** a session already has a `queued` analysis job
- **When** the user queues another analysis job for the same session
- **Then** the API returns `200`
- **And** the response contains the existing `jobId`
- **But** no second active analysis job row is created for that session

### Scenario: Timed out agent job records failure

**Traces to**: FR-012, FR-044, FR-045, FR-046
**Category**: Error Path

- **Given** an extraction job has exceeded its `timeout_seconds`
- **When** the scheduler polls running jobs
- **Then** the job status becomes `failed`
- **And** `error_code` is `job.timeout`
- **And** a structured job lifecycle log entry is written

### Scenario: Analysis emits session-scoped candidates

**Traces to**: FR-017, FR-018, FR-019
**Category**: Happy Path

- **Given** an analysis job succeeds for session `sess_abc`
- **When** the backend imports its CandidateReport
- **Then** every persisted candidate ID matches `sess_abc.cand.NNN`
- **And** every candidate has source paths, ports, workbench node shape, confidence, risk, and report path

### Scenario: Candidate report missing ports is rejected

**Traces to**: FR-018
**Category**: Error Path

- **Given** an analysis job output contains a candidate with no proposed ports
- **When** the backend imports the CandidateReport
- **Then** the job status becomes `failed`
- **And** `error_code` is `candidate_report.invalid`
- **And** no partial candidate row is persisted for that candidate
- **And** the user-visible job error names the missing `ports` field

### Scenario: User reviews and approves candidate

**Traces to**: FR-020, FR-021, FR-022
**Category**: Happy Path

- **Given** a proposed candidate exists
- **When** the user modifies its description and approves it with a non-empty reason
- **Then** the candidate status becomes `approved`
- **And** `approvedAt` is populated
- **And** the approval reason is persisted

### Scenario: Immutable candidate cannot be modified

**Traces to**: FR-020
**Category**: Error Path

- **Given** a candidate exists with status `approved`
- **When** the user submits `PATCH /api/candidates/{candidateId}`
- **Then** the API returns `409`
- **And** the error code is `candidate.invalid_transition`
- **And** the candidate row is unchanged

### Scenario: User marks duplicate candidate

**Traces to**: FR-020, FR-022
**Category**: Happy Path

- **Given** a proposed candidate overlaps an existing module
- **When** the user marks it duplicate with a reason of at least `3` non-whitespace characters
- **Then** the candidate status becomes `duplicate_detected`
- **And** the duplicate reason is persisted

### Scenario: User views candidate source file

**Traces to**: FR-020, FR-042, FR-043
**Category**: Happy Path

- **Given** a candidate source path is `internal/telemetry/metrics.go` inside the session checkout
- **When** the user opens source for that candidate path
- **Then** the API returns the file content from `GET /api/sessions/{sessionId}/files?path=internal/telemetry/metrics.go`
- **And** no absolute filesystem path is exposed in the response

### Scenario: Escaping source symlink is rejected

**Traces to**: FR-020, FR-042, FR-043
**Category**: Error Path

- **Given** a session checkout contains `internal/leak.go` as a symlink whose resolved target is outside the checkout
- **When** the user opens `GET /api/sessions/{sessionId}/files?path=internal/leak.go`
- **Then** the API returns `400`
- **And** the error code is `path.invalid`

### Scenario: User cannot reject without a reason

**Traces to**: FR-022
**Category**: Error Path

- **Given** a proposed candidate exists
- **When** the user rejects it with a blank reason
- **Then** the API returns `400`
- **And** the error code is `request.missing_field`

### Scenario: Extraction plan includes approved candidates only

**Traces to**: FR-023, FR-024
**Category**: Happy Path

- **Given** two candidates are approved in the same session
- **When** the user creates an extraction plan with those candidate IDs
- **Then** the API returns `201`
- **And** the extraction plan document lists exactly those approved candidates

### Scenario: Extraction plan rejects unapproved candidate

**Traces to**: FR-023
**Category**: Error Path

- **Given** a candidate exists with status `proposed`
- **When** the user creates an extraction plan containing that candidate ID
- **Then** the API returns `409`
- **And** the error code is `candidate.not_approved`

### Scenario: Passing extracted module enters registry and workbench

**Traces to**: FR-025, FR-026, FR-027, FR-028, FR-029
**Category**: Happy Path

- **Given** an extraction job produced module code, tests, manifest, ports, config schema, provenance, docs, and passing test status
- **When** the backend registers the module
- **Then** the module row is created with `available_in_workbench` equal to `1`
- **And** the module appears in `GET /api/workbench/palette`

### Scenario: Failing module test blocks workbench availability

**Traces to**: FR-025, FR-026
**Category**: Error Path

- **Given** an extraction job produced a module with `test_status` equal to `failing`
- **When** the backend attempts to register it
- **Then** the module is not marked available in the workbench
- **And** the failure is visible on the Modules screen

### Scenario: Duplicate module is classified during comparison

**Traces to**: FR-027
**Category**: Edge Case

- **Given** the registry already contains `config-loader`
- **When** a new candidate has capability overlap at least `0.90`, identical port names and types, and source path overlap at least `0.50`
- **Then** registry comparison returns classification `duplicate`
- **And** the UI presents that classification to the user

### Scenario: User connects compatible workbench ports

**Traces to**: FR-030, FR-031, FR-032, FR-033
**Category**: Happy Path

- **Given** the workbench contains an `AgentLifecycleEventStream` output port and an `AgentLifecycleEventStream` input port
- **When** the user creates an edge from the output port to the input port
- **Then** the edge is accepted
- **And** saving the blueprint writes separate semantic and flow layout documents

### Scenario: User cannot connect incompatible ports

**Traces to**: FR-031, FR-033
**Category**: Error Path

- **Given** the workbench contains an `OTelMetricStream` output port and an `AgentLifecycleEventStream` input port
- **When** the user creates an edge from the output port to the input port
- **Then** the API returns `422`
- **And** the error code is `blueprint.port_type_mismatch`

### Scenario: Wiring job runs for a valid blueprint

**Traces to**: FR-034, FR-035
**Category**: Happy Path

- **Given** a blueprint has validation status `valid`
- **When** the user queues a wiring job
- **Then** an agent job with role `wiring` is queued
- **And** generated artifacts are written under the blueprint generated artifacts directory when the job succeeds

### Scenario: Wiring job is blocked for invalid blueprint

**Traces to**: FR-034
**Category**: Error Path

- **Given** a blueprint has validation status `invalid`
- **When** the user queues a wiring job
- **Then** the API returns `409`
- **And** the error code is `blueprint.invalid`

### Scenario: User navigates all primary UI screens

**Traces to**: FR-036, FR-037, FR-038, FR-039, FR-040, FR-041
**Category**: Happy Path

- **Given** the backend has one session, one candidate, one module, one blueprint, and one agent job
- **When** the user opens each primary UI screen
- **Then** each screen renders its required fields and primary actions without a full page reload

### Scenario: Unsafe artifact path is rejected

**Traces to**: FR-042, FR-043
**Category**: Error Path

- **Given** allowed roots are configured for repository paths
- **When** the user submits a path containing `../`
- **Then** the API returns `400`
- **And** the error code is `path.invalid`

### Scenario: Local repository outside allowed roots is rejected

**Traces to**: FR-042
**Category**: Error Path

- **Given** the backend is configured with `--allowed-root=/work/allowed`
- **When** the user registers a `local_path` repository at `/work/other/repo`
- **Then** the API returns `400`
- **And** the error code is `path.invalid`

### Scenario: Scheduler respects analysis capacity

**Traces to**: FR-004, FR-045
**Category**: Edge Case

- **Given** four analysis jobs are running
- **When** the user queues a fifth analysis job
- **Then** the fifth job remains queued
- **And** it starts automatically after one running analysis job finishes

### Scenario: Failed job persists diagnostic state

**Traces to**: FR-044, FR-046
**Category**: Error Path

- **Given** an extraction job process exits with a non-zero code
- **When** the scheduler records completion
- **Then** the job status becomes `failed`
- **And** the row includes `error_code`, transcript path when available, and finish timestamp

### Scenario: Backend restart reconciles interrupted jobs

**Traces to**: FR-045, FR-046
**Category**: Error Path

- **Given** the SQLite database contains a `running` wiring job from a previous backend process
- **When** the backend starts and the provider cannot prove the tmux process is still active
- **Then** the job status becomes `failed`
- **And** `error_code` is `job.interrupted`
- **And** a structured startup reconciliation log entry is written

### Scenario: OpenAPI remains the endpoint contract source

**Traces to**: FR-047
**Category**: Happy Path

- **Given** the repo contains `openapi.yaml`
- **When** CI runs the API contract check
- **Then** every `/api/*` route has a matching OpenAPI operation
- **And** generated or checked backend validation and frontend API types match `openapi.yaml`
- **And** the check fails on any implemented route, request schema, response schema, status code, or error code drift

## Testing Requirements

### Unit

- SQLite migration creation and idempotency for DM-001 through DM-008.
- Session state transition validation and invalid transition errors.
- Candidate state transition validation and duplicate/rescan status transitions.
- CandidateReport import validation, including required ports and namespaced candidate IDs.
- Extraction plan validation that rejects unapproved candidates.
- Port compatibility validator for exact type matches and mismatches.
- AgentProvider interface behavior using a fake provider.
- Filesystem path sanitization, allowed-root checks, absolute symlink escape rejection, relative symlink escape rejection, and valid in-tree symlink reads.
- Agent output contract validation for required files, schema validation, semantic validation, and realpath containment.
- Scheduler capacity accounting, active-job idempotency, timeouts, and startup reconciliation for analysis, extraction, and wiring queues.
- OpenAPI schema validation for endpoint request bodies, query/path parameters, response bodies, error bodies, and unknown-field rejection.

### Integration

- Repository registration through session creation and intent persistence against real SQLite and temp filesystem directories.
- Analysis job queue through Claude provider adapter boundary with tmux command execution mocked or isolated behind a test double.
- Candidate approval, immutable candidate edit rejection, duplicate marking, source viewing including symlink escape rejection, and extraction plan document creation.
- Module registration through workbench palette availability.
- Blueprint save, validate, and wiring job queue against real SQLite and temp document storage.
- HTTP error contract for representative 400, 409, 422, and 500 paths.
- OpenAPI contract check that fails when implemented routes or generated API types drift from `openapi.yaml`.

### E2E Smoke

- Register repo, create session, record intent, queue analysis, import candidates, approve candidate, create extraction plan.
- Register a passing module, open Workbench, add node, connect compatible ports, save and validate blueprint.
- Queue a wiring job for a valid blueprint and display the returned tmux attach command.

## Success Criteria

- **SC-001**: `go test ./...` exits `0` under Go `1.26.3` or a later Go `1.26.x` patch release.
- **SC-002**: Frontend unit or component test command exits `0`.
- **SC-003**: Full local app startup creates SQLite database and all required data directories from an empty data directory.
- **SC-004**: `GET /api/config` returns analysis limit `4`, extraction limit `2`, and wiring limit `1`.
- **SC-005**: Attempting to create an extraction plan with any unapproved candidate returns `409 candidate.not_approved`.
- **SC-006**: Attempting to connect incompatible ports returns `422 blueprint.port_type_mismatch`.
- **SC-007**: A valid blueprint can queue exactly one running wiring job while additional wiring jobs remain queued.
- **SC-008**: Candidate report, extraction plan, module manifest, config schema, registry comparison report, blueprint validation report, wiring output manifest, blueprint semantic document, flow layout document, prompt, transcript, and generated artifacts are stored as local filesystem documents with paths referenced from SQLite.
- **SC-009**: The UI renders all seven primary screens and completes the E2E smoke path without requiring authentication.
- **SC-010**: The first provider can create a tmux session for a Claude Code CLI job and the job open endpoint returns `tmuxSessionName` plus `attachCommand` while the session is running.
- **SC-011**: Session and candidate invalid state transitions return `409` and do not modify persisted status.
- **SC-012**: Repeating a job-queue POST while an active job exists returns the existing job and creates no duplicate active job row.
- **SC-013**: CI fails if any `/api/*` route, request schema, response schema, status code, error code, or generated frontend API type drifts from `openapi.yaml`.

## Traceability Matrix

| FR Range | Area | Scenarios | Test surfaces |
|----------|------|-----------|---------------|
| FR-001..FR-005 | Foundation and Runtime | Startup creates database and document directories (Happy), Startup reports blocked storage (Error), Scheduler respects analysis capacity (Edge) | Unit: migrations and scheduler limits; Integration: startup with temp data dir |
| FR-006..FR-010 | Repository and Session Lifecycle | User registers a local repository (Happy), User cannot register the same repository twice (Error), User creates session and records repo intent (Happy), Analysis cannot start without intent (Error), Git clone failure leaves no partial session checkout (Error), Concurrent session transition is rejected (Edge) | Unit: state transitions; Integration: repository/session/intent APIs |
| FR-011..FR-016 | Agent Runner and tmux | Analysis job launches Claude Code in tmux (Happy), Opening inactive tmux job is rejected (Error), Duplicate analysis queue request returns active job (Edge), Timed out agent job records failure (Error) | Unit: AgentProvider fake; Integration: provider adapter boundary |
| FR-017..FR-022 | Candidate Discovery and Review | Analysis emits session-scoped candidates (Happy), Candidate report missing ports is rejected (Error), User reviews and approves candidate (Happy), Immutable candidate cannot be modified (Error), User marks duplicate candidate (Happy), User views candidate source file (Happy), Escaping source symlink is rejected (Error), User cannot reject without a reason (Error) | Unit: CandidateReport importer; Integration: candidate APIs |
| FR-023..FR-028 | Extraction and Registry | Extraction plan includes approved candidates only (Happy), Extraction plan rejects unapproved candidate (Error), Passing extracted module enters registry and workbench (Happy), Failing module test blocks workbench availability (Error), Duplicate module is classified during comparison (Edge) | Unit: extraction plan validator; Integration: module registration and registry comparison |
| FR-029..FR-035 | Workbench and Blueprint | User connects compatible workbench ports (Happy), User cannot connect incompatible ports (Error), Wiring job runs for a valid blueprint (Happy), Wiring job is blocked for invalid blueprint (Error) | Unit: port validator; Integration: blueprint save/validate/wiring APIs |
| FR-036..FR-041 | UI | User navigates all primary UI screens (Happy) | Unit: screen/component rendering; E2E: local UI navigation |
| FR-042..FR-047 | Security, Safety, and Failure Handling | User views candidate source file (Happy), Escaping source symlink is rejected (Error), Unsafe artifact path is rejected (Error), Local repository outside allowed roots is rejected (Error), Scheduler respects analysis capacity (Edge), Timed out agent job records failure (Error), Failed job persists diagnostic state (Error), Backend restart reconciles interrupted jobs (Error), OpenAPI remains the endpoint contract source (Happy) | Unit: path sanitization, job finalization, and OpenAPI schema validation; Integration: error contract and route drift checks |

## Task Decomposition Guidance

1. **Project foundation** - covers FR-001..FR-005 and FR-042..FR-047. Outcome: local backend starts, migrates SQLite, creates data directories, enforces paths, logs job state, exposes health/config APIs, and keeps API validation/types generated from `openapi.yaml`.
2. **Repositories, sessions, and agent jobs** - covers FR-006..FR-016. Outcome: users can register repos, create sessions, record intent, queue jobs, and launch/open Claude Code CLI tmux sessions through the provider interface.
3. **Candidates and extraction planning** - covers FR-017..FR-024. Outcome: analysis outputs import into candidates, users review candidates, and approved candidates produce extraction plans.
4. **Module registry** - covers FR-025..FR-029. Outcome: extraction outputs register as modules only when complete and passing, duplicate comparison runs, and valid modules appear in the workbench palette.
5. **Workbench and blueprints** - covers FR-030..FR-035. Outcome: users compose registered modules with typed ports, save semantic and visual documents separately, validate blueprints, and queue wiring jobs.
6. **Frontend completion** - covers FR-036..FR-041. Outcome: all primary screens support the full local workflow with no auth.
