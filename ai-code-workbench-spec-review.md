# Adversarial Review: AI Code Workbench

**Spec reviewed**: ai-code-workbench-spec.md
**Review date**: 2026-05-10
**Cycle**: 2
**Verdict**: BLOCK

## Executive Summary

The revision resolved most cycle-1 structural gaps, but three implementation-blocking defects remain: Claude Code jobs are constrained by prompt text rather than enforceable filesystem/process boundaries, source-file reads do not account for symlink escape, and many required API surfaces are listed without request/response contracts. There are 3 BLOCKERs, 9 WARNINGs, and 2 INFO findings.

| Severity | Count |
|----------|-------|
| BLOCKER | 3 |
| WARNING | 9 |
| INFO | 2 |
| **Total** | **14** |

---

## Findings

### BLOCKER Findings

#### [G-001] Claude Code jobs have no enforceable filesystem boundary

- **Dimension**: insecurity
- **Affected**: FR-012, FR-014, FR-015, FR-024, FR-035
- **Description**: FR-014 says prompts include an "allowed output path" and FR-024/FR-035 say jobs operate on extraction plans or blueprint documents, but the provider contract never requires the Claude Code process to run in a constrained working directory, isolated worktree, sandbox, permission mode, or allowlisted filesystem root. A prompt instruction is not an enforcement mechanism. A malformed prompt, repo prompt injection, or agent mistake can modify files outside `data/jobs/{jobId}` or `data/blueprints/{blueprintId}/generated/{jobId}`.
- **Impact**: A wiring or extraction job can damage unrelated workspace files or write generated code into the wrong project while still satisfying the current spec's "read document and generate artifacts" wording.
- **Fix hint**: Add a provider safety requirement: every agent job MUST launch with explicit `cwd`, explicit writable output root, read roots, denied path rules, environment allowlist, and Claude Code permission/sandbox settings. The backend MUST verify expected output files are under the allowed output root by resolved realpath before marking a job `succeeded`.

#### [G-002] Source file viewing is vulnerable to symlink escape

- **Dimension**: insecurity
- **Affected**: FR-020, FR-042, FR-043, `GET /api/sessions/{sessionId}/files?path={relativePath}`
- **Description**: The spec rejects absolute paths and `..` segments, but it does not require resolving symlinks before reading from the session checkout. A repository can contain `internal/leak.go -> /Users/nixlim/.ssh/config` or another absolute symlink; the API would receive a valid relative path and return content outside the checkout.
- **Impact**: Opening source for an untrusted cloned repository can disclose arbitrary local files readable by the backend process.
- **Fix hint**: Require `lstat`/`realpath` containment checks for every source file and artifact read. The resolved target path MUST remain under the session checkout root, symlinks escaping the checkout MUST return `400 path.invalid`, and tests MUST cover absolute symlink, relative symlink escape, and normal in-tree symlink cases.

---

### WARNING Findings

#### [G-004] Intent storage and analysis queueing conflict

- **Dimension**: incorrectness
- **Affected**: FR-009, FR-010, `POST /api/sessions/{sessionId}/intent`, `POST /api/sessions/{sessionId}/analysis-jobs`
- **Description**: `POST /api/sessions/{sessionId}/intent` returns phase `queued`, and DM-002 allows `awaiting_user_intent -> queued -> analysing`. Separately, `POST /api/sessions/{sessionId}/analysis-jobs` is the endpoint that queues an analysis job. The spec does not define whether storing intent automatically queues analysis, or whether "queued" means "ready to queue" without an `agent_jobs` row.
- **Fix hint**: Split the states or the endpoints. Either make intent submission create the analysis job transactionally, or change the post-intent phase to a distinct value such as `intent_recorded`/`ready_for_analysis` and reserve `queued` for sessions with an active queued analysis job.

#### [G-005] CandidateReport invalid handling contradicts itself

- **Dimension**: inconsistency
- **Affected**: CandidateReport import contract, Error Contract, Scenario "Candidate report missing ports is rejected"
- **Description**: The CandidateReport contract says malformed files mark the job `failed` with `error_code = 'candidate_report.invalid'`, and the Error Contract maps that condition to `422 candidate_report.invalid`. The behavioral scenario for a missing `ports` field instead expects `400 request.missing_field`. This is not an HTTP request from the user; it is malformed agent output imported after job completion.
- **Fix hint**: Change the scenario to expect job status `failed`, `error_code = 'candidate_report.invalid'`, no partial candidate rows, and a validation report or user-visible job error describing the missing `ports` field.

#### [G-006] Candidate mutation endpoint ignores state-machine constraints

- **Dimension**: inconsistency
- **Affected**: DM-003, `PATCH /api/candidates/{candidateId}`, FR-020
- **Description**: The PATCH candidate response always returns status `modified`, but DM-003 only allows `proposed -> modified`, `deferred -> modified`, and not `approved -> modified`, `duplicate_detected -> modified`, or `registered -> modified`. The endpoint contract does not state which source statuses are mutable or what error code is returned for immutable statuses.
- **Fix hint**: Add preconditions to `PATCH /api/candidates/{candidateId}`. For example: PATCH is allowed only from `proposed` or `deferred`; otherwise return `409 candidate.invalid_transition`. If approved candidates can be edited, add explicit approved-to-modified consequences for extraction plans and approvals.

#### [G-007] Candidate approval reason is ambiguous

- **Dimension**: ambiguity
- **Affected**: FR-021, FR-022, `POST /api/candidates/{candidateId}/approve`
- **Description**: FR-022 requires non-empty reasons for reject, defer, and duplicate actions only. The approve endpoint request includes `reason`, and the approval scenario says the user approves "with a non-empty reason", but no FR says approval reasons are required or persisted.
- **Fix hint**: Decide one rule. Either require approval reasons in FR-021 and persist them, or remove `reason` from the approve request and scenario.

#### [G-008] Allowed roots have no configuration source or default behavior

- **Dimension**: ambiguity
- **Affected**: FR-042, `GET /api/config`, `POST /api/repositories`
- **Description**: FR-042 says repository paths outside allowed roots are rejected "when allowed roots are configured", and `GET /api/config` shows an `allowedRoots` array. The spec does not define where allowed roots are configured, whether the default is empty, whether an empty list means "deny all local paths" or "allow all local paths", or whether Git clone destinations are subject to the same root policy.
- **Fix hint**: Specify config source and default. For example: `--allowed-root` may be repeated; default is the current workspace root; empty explicit config denies `local_path` registration; cloned repos are always placed under the configured data directory.

#### [G-009] Tmux "open or focus" is not implementable as written

- **Dimension**: infeasibility
- **Affected**: FR-013, `POST /api/agent-jobs/{jobId}/open`
- **Description**: A local HTTP backend cannot reliably "open or focus" a tmux session in the user's terminal unless the backend is running inside an attached tmux client, has terminal focus privileges, or invokes an OS-specific terminal command. The endpoint response shape for `open` is also absent.
- **Fix hint**: Replace "open or focus" with a testable behavior. Return an attach command such as `tmux attach -t <session>`, no focus, and define the response as `{ "tmuxSessionName": "...", "attachCommand": "..." }`.

#### [G-010] Frontend stack choice conflicts with React Flow requirements

- **Dimension**: inconsistency
- **Affected**: Guard rails, FR-040, Terminology "Workbench"
- **Description**: The guard rail says the frontend MAY use React, React Flow, Vite "or an equivalent local web stack selected by the implementer", but FR-040 requires a "React Flow canvas" and the terminology defines Flow Layout as React Flow visual state. An implementer choosing an "equivalent" stack would immediately violate the React Flow-specific storage and UI language.
- **Fix hint**: Either make React Flow mandatory for this implementation, or rewrite the workbench requirements around a generic graph-canvas abstraction and define the persisted layout schema independently of React Flow.

#### [G-011] Registry comparison classification has no decision rules

- **Dimension**: incompleteness
- **Affected**: FR-027, `POST /api/modules/{moduleId}/compare`, Scenario "Duplicate module is classified during comparison"
- **Description**: FR-027 lists six classifications but gives no criteria for choosing among `duplicate`, `variant`, `adapter_needed`, `merge_candidate`, and `reject_duplicate`. The source brief explicitly depends on registry reconciliation, but the spec leaves the hardest business rule to the implementer.
- **Fix hint**: Define comparison inputs and thresholds: capability overlap, source path overlap, port compatibility, dependency overlap, test/doc maturity, and whether user approval is required before merge/reject outcomes.

#### [G-012] Agent output contracts are named but not schema-backed

- **Dimension**: incompleteness
- **Affected**: FR-014, FR-015, FR-017, FR-025, FR-035
- **Description**: CandidateReport gets an inline shape, but extraction outputs, module manifests, config schemas, documentation outputs, registry comparison results, validation reports, and wiring job outputs do not have schema paths or required file manifests. FR-015 requires produced artifacts to be linked before success, but each role's required artifacts are undefined.
- **Fix hint**: Add a per-role output contract table: role, expected output files, schema file path, success validation checks, and import behavior. Include extraction module manifest, module config schema, registry comparison report, blueprint validation report, and wiring output manifest.

---

### INFO Findings

#### [G-013] Provider extensibility still partially re-enters deferred scope

- **Dimension**: overcomplexity
- **Affected**: FR-011, FR-016, Deferred From This Spec
- **Suggestion**: The spec defers non-Claude providers but still requires API request shapes and database schema to tolerate an additional CLI provider. A fake provider for tests justifies an interface; schema/API future-proofing for real providers is less clearly justified.

#### [G-014] Go 1.26.3 requirement is current but should be treated as a deliberate upgrade

- **Dimension**: codebase_fit
- **Affected**: Guard rails, FR-001, SC-001, Implementation Candidate Inventory
- **Suggestion**: Go `1.26.3` is a real current release, but the sibling candidate repos checked here use `go 1.22`, `go 1.25.0`, or `go 1.25.6`. The spec should state that adapted code must be upgraded to the Workbench toolchain and that any Go 1.26 language/runtime changes must be handled during adaptation.

---

## Structural / Narrative Integrity

| Check | Result | Notes |
|-------|--------|-------|
| Every FR-NNN has at least one behavioural scenario | PASS | FR-001 through FR-046 are covered by scenarios through direct traces or the traceability matrix. |
| Every behavioural scenario traces back to an FR-NNN | PASS | Every scenario under Behavioral Scenarios has a `Traces to` line. |
| Acceptance criteria are falsifiable and measurable | PASS | SC-001 through SC-012 are command, API, persistence, or UI-test observable. |
| Cross-references resolve (no dangling IDs) | PASS | FR, DM, SC, and scenario references resolve. |
| Scope boundaries are explicit (in / out / deferred) | PASS | Implementation Scope, Guard rails, and Deferred sections are present. |
| Error and failure modes addressed | FAIL | CandidateReport invalid handling contradicts itself, source symlink escape is unaddressed, and unspecified endpoints have no error behavior. See G-002, G-003, G-005. |
| Dependencies between requirements identified | PARTIAL | Task decomposition and traceability group dependencies, but intent submission versus analysis job queueing is semantically inconsistent. See G-004. |
| Actors (users, systems, services, jobs) named | PASS | User, backend, scheduler, agent provider, Claude Code CLI, tmux, frontend, and filesystem storage are named. |
| Implementation detail sufficient to begin work | FAIL | Core listed endpoints and role output contracts are still missing. See G-003 and G-012. |
| Assumptions and constraints stated explicitly | PARTIAL | Major local-only constraints are stated, but allowed-root configuration and agent process permissions are not. See G-001 and G-008. |

---

## Alignment Summary

### Scope Alignment (Check 9)

The spec still maps to the source document's stated product: repo-scoped extraction, local registry, React Flow workbench, semantic blueprints, and AI wiring. No major feature drifts into hosted SaaS, multi-user auth, or remote registry publishing. The main scope concern is not expansion but under-specification: required surfaces from the stated workflow are named but lack contracts (G-003).

### Codebase Fit (Check 10)

The referenced sibling candidate paths exist, and this project remains greenfield, so there is no established in-repo architecture to violate. The one fit issue is toolchain adaptation: the spec mandates Go 1.26.3 while several cited adaptation sources are Go 1.22 or Go 1.25.x; this is manageable, but the implementation agent should not blindly copy go.mod settings or version-sensitive code (G-014).

---

## Quality Gate Summary

| Check | Triggered? | Locations |
|-------|-----------|-----------|
| QG-USER-STORY (user-story narrative) | No | -- |
| QG-RESURRECTED (deleted section reappeared) | No | -- |
| QG-TEST-CATALOG (numbered test catalog >10) | No | Testing Requirements lists are below the threshold. |
| QG-WEASEL (weasel words in FRs) | No | No unqualified prohibited weasel words found in FR bodies. |
| QG-FALSIFY (non-falsifiable AC) | No | Success criteria are observable. |
| QG-SPEC-FAIL (specificity failure) | Yes | Unspecified required endpoints and agent output contracts; see G-003 and G-012. |
| QG-DEFER-NO-REASON (deferred without reason) | No | Deferred items include reasons. |

---

## Test Coverage Assessment

| Missing category | Affected scenarios / FRs | Why it matters |
|------------------|--------------------------|----------------|
| Agent filesystem containment | FR-012, FR-014, FR-015, FR-024, FR-035 | Prompt-only output restrictions are not enough to prevent destructive writes. |
| Symlink path escape | FR-020, FR-042, FR-043 | Relative path validation can still leak files through symlinks. |
| Full API contract conformance | FR-020, FR-027, FR-029, FR-036..FR-041 | UI screens and candidate workflows depend on endpoints with no schemas. |
| CandidateReport import errors | FR-017, FR-018, FR-044 | The spec currently expects conflicting error codes and job state. |
| Intent/job lifecycle transitions | FR-009, FR-010, FR-012 | The scheduler can observe `queued` session state without a clear job row invariant. |

---

## Unasked Questions

1. What exact Claude Code permission/sandbox mode should each provider role use?
2. Which filesystem roots may an agent read, and which roots may it write?
3. Does submitting repo intent automatically create an analysis job, or does it only make the session ready for a separate queue request?
4. Are approval reasons required and persisted, or only negative-action reasons?
5. What are the response shapes for the listed but unspecified list/detail/action endpoints?
6. How should registry comparison decide between duplicate, variant, adapter needed, merge candidate, and reject duplicate?
7. Should the workbench be strictly React Flow, or can an equivalent graph library be used?

---

## Verdict Rationale

This cycle is not stalled: the prior state-machine, pagination, timeout, clone-failure, source-viewing, and health-contract findings were mostly addressed. The remaining defects are sharper and more implementation-critical. G-001 and G-002 are concrete local security issues, and G-003 leaves too much of the backend/frontend contract unspecified for a coding agent to implement consistently.

The spec should not be taskified until the blocker findings are fixed. After that, the remaining warnings can be handled in the same revision pass because they mainly require clarifying contracts and resolving contradictions.

### Recommended Next Actions

- [ ] Add enforceable Claude Code process/filesystem containment requirements (G-001)
- [ ] Add realpath/symlink containment requirements and tests for source reads (G-002)
- [ ] Specify every endpoint currently listed only in the Surface / API Inventory (G-003)
- [ ] Resolve the intent-versus-analysis-queue state model (G-004)
- [ ] Normalize CandidateReport import failure semantics (G-005)
- [ ] Add per-role agent output schemas and artifact manifests (G-012)

---

## Issues

```yaml
issues:
  - id: G-001
    dimension: insecurity
    severity: blocker
    affected: "FR-012, FR-014, FR-015, FR-024, FR-035"
    description: |
      Claude Code jobs are constrained by prompt text rather than enforceable filesystem or process boundaries. The provider contract never requires a constrained cwd, isolated worktree, sandbox, permission mode, read roots, write roots, or allowlisted output directory. A repo prompt injection or agent mistake can modify files outside the intended artifact directory.
    fix_hint: |
      Add provider safety requirements for explicit cwd, writable output root, read roots, denied paths, environment allowlist, and Claude Code permission/sandbox settings. Require the backend to verify all produced artifacts are under the allowed output root by resolved realpath before marking a job succeeded.

  - id: G-002
    dimension: insecurity
    severity: blocker
    affected: "FR-020, FR-042, FR-043, GET /api/sessions/{sessionId}/files?path={relativePath}"
    description: |
      Source file viewing rejects absolute paths and '..' segments but does not require symlink-safe realpath containment. A cloned repository can include a symlink that points outside the checkout, and the API would still receive a valid relative path.
    fix_hint: |
      Require lstat/realpath containment for every file read. Resolved targets must stay under the session checkout root; escaping symlinks must return 400 path.invalid. Add tests for absolute symlink, relative symlink escape, and valid in-tree symlink behavior.

  - id: G-004
    dimension: incorrectness
    severity: warning
    affected: "FR-009, FR-010, POST /api/sessions/{sessionId}/intent, POST /api/sessions/{sessionId}/analysis-jobs"
    description: |
      Intent submission returns phase queued, but analysis job creation is a separate endpoint. The spec does not define whether storing intent automatically queues analysis or whether queued can exist without an agent_jobs row.
    fix_hint: |
      Either make intent submission create the analysis job transactionally, or introduce a distinct ready_for_analysis phase and reserve queued for sessions with an active queued job.

  - id: G-005
    dimension: inconsistency
    severity: warning
    affected: "CandidateReport import contract, Error Contract, Scenario: Candidate report missing ports is rejected"
    description: |
      CandidateReport invalid handling conflicts: the contract says malformed files mark the job failed with candidate_report.invalid, while the scenario expects 400 request.missing_field.
    fix_hint: |
      Update the scenario to expect failed job state, error_code candidate_report.invalid, no partial candidate rows, and a user-visible validation message naming the missing ports field.

  - id: G-006
    dimension: inconsistency
    severity: warning
    affected: "DM-003, PATCH /api/candidates/{candidateId}, FR-020"
    description: |
      PATCH candidate always returns status modified, but the candidate state machine does not allow every source status to transition to modified. The endpoint omits mutability preconditions and invalid-transition behavior.
    fix_hint: |
      State which candidate statuses are mutable and return 409 candidate.invalid_transition for immutable states, or explicitly add transition consequences for editing approved or registered candidates.

  - id: G-007
    dimension: ambiguity
    severity: warning
    affected: "FR-021, FR-022, POST /api/candidates/{candidateId}/approve"
    description: |
      Approval reason handling is unclear. FR-022 requires reasons only for reject, defer, and duplicate, but the approve request includes reason and the scenario uses a non-empty reason.
    fix_hint: |
      Either require and persist approval reasons in FR-021, or remove reason from the approve request and scenario.

  - id: G-008
    dimension: ambiguity
    severity: warning
    affected: "FR-042, GET /api/config, POST /api/repositories"
    description: |
      Allowed roots have no configuration source or default semantics. It is unclear whether no configured roots means allow all local paths, deny all local paths, or use a workspace default.
    fix_hint: |
      Define allowed-root configuration flags/env, default behavior, empty-list behavior, and whether cloned repos are constrained to the data directory.

  - id: G-009
    dimension: infeasibility
    severity: warning
    affected: "FR-013, POST /api/agent-jobs/{jobId}/open"
    description: |
      A browser-accessed local HTTP backend cannot reliably open or focus a tmux session unless terminal/client assumptions are specified. The endpoint response shape is also absent.
    fix_hint: |
      Return an attach command and tmux session name as the guaranteed behavior. Treat automatic focus as optional and only available when the backend can detect an attached tmux client or configured terminal opener.

  - id: G-010
    dimension: inconsistency
    severity: warning
    affected: "Guard rails, FR-040, Terminology: Workbench"
    description: |
      The frontend stack may be an equivalent local web stack, but the workbench requirements explicitly require React Flow canvas and React Flow layout state. These two directions conflict.
    fix_hint: |
      Make React Flow mandatory, or define a generic graph layout schema and remove React Flow-specific implementation language from FRs.

  - id: G-011
    dimension: incompleteness
    severity: warning
    affected: "FR-027, POST /api/modules/{moduleId}/compare, Scenario: Duplicate module is classified during comparison"
    description: |
      Registry comparison classifications are enumerated but no decision rules or thresholds are specified for choosing among duplicate, variant, adapter_needed, merge_candidate, and reject_duplicate.
    fix_hint: |
      Define comparison inputs and criteria, including capability overlap, port compatibility, source overlap, dependency overlap, and user approval requirements for merge/reject outcomes.

  - id: G-012
    dimension: incompleteness
    severity: warning
    affected: "FR-014, FR-015, FR-017, FR-025, FR-035"
    description: |
      Agent output contracts beyond CandidateReport are not schema-backed. Extraction outputs, module manifests, config schemas, registry comparison results, validation reports, and wiring outputs lack required file manifests and validation rules.
    fix_hint: |
      Add a per-role output contract table with role, expected output files, schema file path, success validation checks, and import behavior.

  - id: G-013
    dimension: overcomplexity
    severity: info
    affected: "FR-011, FR-016, Deferred From This Spec"
    description: |
      Provider extensibility still partially re-enters deferred non-Claude provider scope. A fake provider justifies an interface, but schema/API future-proofing for additional CLI providers is not clearly needed in this spec.
    fix_hint: |
      Limit the rationale to test doubles, or explicitly justify why API and schema shapes must support additional real providers now.

  - id: G-014
    dimension: codebase_fit
    severity: info
    affected: "Guard rails, FR-001, SC-001, Implementation Candidate Inventory"
    description: |
      Go 1.26.3 is current, but referenced adaptation sources use older go.mod versions such as go 1.22, go 1.25.0, and go 1.25.6. Blindly copying module metadata or version-sensitive code can create avoidable upgrade friction.
    fix_hint: |
      State that adapted code must be upgraded to the Workbench Go 1.26.3 toolchain and tested under that version.
```
