AI-Assisted Composable Agent Framework

Unified System Design Document

1. Purpose

We are designing an AI-assisted composable framework for extracting reusable infrastructure from existing open-source repositories, converting or adapting it into reusable Go modules where needed, and composing those modules visually into new systems.

The system is intended for software that supports running, administering, orchestrating, and monitoring AI agents.

Examples of reusable functionality include:

OpenTelemetry metrics for coding agents
agent orchestration
agent administration APIs
process supervision
workspace management
repo checkout
task queues
model/provider abstractions
log and trace collection
deployment helpers
health checks
audit logs
tool registries
approval gates

The final product is not just an extraction tool. It is a combined:

Extraction Studio + Module Registry + React Flow Blueprint Workbench + AI Wiring Agent

The system allows a user to extract reusable modules from many repositories, approve those modules, compose them visually, emit a blueprint, and then ask an AI coding agent to wire the blueprint into runnable code.

⸻

2. Core Principle

The main design principle is:

Run many repo sessions in parallel.
Keep each session scoped to one repository.
Aggregate only at the candidate, registry, and workbench layers.

This avoids overwhelming the user with one huge multi-repo analysis while still allowing the system to operate efficiently.

So the system should not do this:

analyse all repos together
  -> produce one giant candidate list
  -> ask user to review everything

Instead, it should do this:

repo list
  -> create one session per repo
  -> run several repo sessions in parallel
  -> each session asks for extraction intent for that repo
  -> each session analyses only its repo
  -> each session proposes candidates for that repo
  -> Web UI presents candidates grouped by session
  -> user approves / rejects / modifies candidates
  -> approved candidates become extraction jobs
  -> extracted modules enter shared registry
  -> registered modules become nodes in the React Flow workbench
  -> workbench emits blueprint
  -> AI agent wires blueprint into code

The short version:

parallel execution, repo-scoped reasoning, global composition

⸻

3. High-Level System

The system has four major parts.

1. Extraction Studio
   Repo-by-repo discovery, candidate review, approval, and extraction.
2. Module Registry
   Stores extracted reusable modules, manifests, provenance, ports, schemas, and versions.
3. Blueprint Workbench
   A React Flow node-connector UI where users compose registered modules visually.
4. AI Wiring Agent
   Takes the blueprint and generates runnable code, glue code, configuration, tests, and deployment scaffolding.

The flow is:

Repositories
  -> Repo Sessions
  -> Candidate Reports
  -> User Approval
  -> Extraction Plans
  -> Extracted Modules
  -> Module Registry
  -> Workbench Nodes
  -> Blueprint
  -> Generated System

⸻

4. End-to-End Lifecycle

The lifecycle should be:

repository
  -> repo session
  -> user extraction intent
  -> candidate discovery
  -> candidate approval
  -> extraction plan
  -> extracted module
  -> module manifest
  -> registry entry
  -> workbench node
  -> blueprint component
  -> generated implementation

A more detailed version:

1. User adds a list of repositories.
2. System creates one RepoSession per repository.
3. Several RepoSessions may run in parallel.
4. Each RepoSession asks:
   "For this repo, do you know what functionality you want extracted?"
5. User can provide:
   - specific functionality
   - vague areas of interest
   - files/directories
   - things to avoid
   - "no suggestions"
6. Agent analyses that repo only.
7. Agent proposes reusable module candidates.
8. Web UI presents candidates grouped by repo/session.
9. User approves, rejects, or modifies candidates.
10. Approved candidates become extraction plans.
11. Extraction agents extract approved modules.
12. Extracted modules are tested and registered.
13. Registered modules appear as draggable nodes in the Workbench.
14. User composes modules using a React Flow node canvas.
15. Workbench validates typed connections.
16. Workbench emits a blueprint document.
17. AI wiring agent turns blueprint into runnable code.

⸻

5. Repo-Scoped Parallel Sessions

Each repository becomes a focused session.

However, the system can run many such sessions at once.

Repos
  ├── Repo A -> Session A -> Agent Worker A
  ├── Repo B -> Session B -> Agent Worker B
  ├── Repo C -> Session C -> Agent Worker C
  └── Repo D -> Session D -> Agent Worker D

All sessions feed into shared stores:

Candidate Store
Extraction Job Store
Module Registry
Blueprint Workbench

The repo session is the unit of analysis.

The module registry is the unit of reuse.

The workbench is the unit of composition.

⸻

6. Repo Session State Machine

Each repo session should have its own lifecycle.

created
  -> awaiting_user_intent
  -> queued
  -> analysing
  -> candidates_ready
  -> awaiting_approval
  -> extraction_planned
  -> extracting
  -> extracted
  -> registered
  -> available_in_workbench

Error and interruption states:

failed_analysis
failed_extraction
needs_user_input
paused
cancelled
duplicate_detected
conflict_detected

Example session record:

apiVersion: agentfw.dev/v1alpha1
kind: RepoSession
metadata:
  sessionId: sess-coding-agent-runner-001
  repoName: coding-agent-runner
repo:
  url: git@github.com:example/coding-agent-runner.git
  branch: main
  commit: 8f4c2aa
status:
  phase: analysing
  startedAt: 2026-05-10T12:00:00Z
intent:
  userProvided: true
  requestedFunctionality:
    - OpenTelemetry metrics
    - agent orchestration
agent:
  workerId: worker-03
  tool: codex-cli
outputs:
  candidateReport: null
  extractionPlan: null
  extractedModules: []

⸻

7. User Intent Collection

Before analysing a repository, the agent must ask the user what functionality they want extracted from that specific repo.

The prompt should be repo-scoped:

For repo: coding-agent-runner
Do you already know what functionality you want extracted from this repo?
You can provide:
- specific functionality
- relevant files, packages, or directories
- general areas of interest
- things that should not be extracted
- preferred target language, defaulting to Go
- "no suggestions" if you want the agent to discover candidates itself

The agent must handle three cases.

Case 1: User has specific suggestions

Example:

Extract the OpenTelemetry metrics code and agent supervision code.
Metrics is probably in internal/telemetry.
Supervisor is probably in internal/runtime.

The agent should prioritise those areas.

Case 2: User has vague suggestions

Example:

Mostly observability and orchestration.

The agent should use this as a discovery focus.

Case 3: User has no suggestions

Example:

No suggestions. You identify candidates.

The agent should analyse the repo and propose candidates itself.

Important rule:

No extraction happens before explicit user approval.

⸻

8. Candidate Discovery

During discovery, the agent analyses one repository and proposes reusable candidates.

It must not modify code during discovery.

Each candidate should include:

candidate ID
repo/session ID
proposed module name
functionality description
source paths
why the functionality is reusable
project-specific coupling
dependencies
side effects
tests found
missing tests
target language
module kind
extraction risk
confidence
recommended action
proposed workbench node shape
proposed typed ports

Candidate IDs should be namespaced by repo or session to avoid collisions during parallel execution.

Examples:

CAND-coding-agent-runner-001
CAND-admin-api-server-001
CAND-deployment-tools-001

or:

sess_7f92.cand_001
sess_88ab.cand_001

⸻

9. Candidate Report Example

apiVersion: agentfw.dev/v1alpha1
kind: CandidateReport
metadata:
  sessionId: sess-coding-agent-runner-001
  repoName: coding-agent-runner
candidates:
  - id: CAND-coding-agent-runner-001
    proposedName: otel-agent-metrics
    description: Converts agent lifecycle events into OpenTelemetry metrics.
    confidence: high
    extractionRisk: low
    recommendedAction: approve
    sourcePaths:
      - internal/telemetry
      - internal/events
      - internal/runtime/metrics.go
    whyReusable:
      - Converts generic agent lifecycle events into metrics
      - Useful across coding-agent runtimes
      - Has a clear boundary and existing tests
    projectSpecificCoupling:
      level: low
      notes:
        - Uses internal event names that may need normalisation
    targetLanguage: go
    moduleKind: library
    dependencies:
      - go.opentelemetry.io/otel
      - internal event model
    proposedPorts:
      inputs:
        - name: events
          type: AgentLifecycleEventStream
          required: true
        - name: config
          type: OTelMetricsConfig
          required: false
      outputs:
        - name: metrics
          type: OTelMetricStream
        - name: health
          type: HealthStatus
    proposedWorkbenchNode:
      title: OTel Agent Metrics
      category: Observability
      nodeType: module

⸻

10. Candidate Review in the Web UI

Candidates should be presented in the Web UI as cards grouped by repo session.

Example:

Candidates Ready
coding-agent-runner
  CAND-coding-agent-runner-001  OTel Agent Metrics
  CAND-coding-agent-runner-002  Agent Supervisor
  CAND-coding-agent-runner-003  Workspace Manager
admin-api-server
  CAND-admin-api-server-001     Admin Status API
  CAND-admin-api-server-002     Audit Log Writer
  CAND-admin-api-server-003     Auth Middleware

A candidate card should show:

Candidate name
Repo
Confidence
Risk
Suggested module kind
Short description
Source paths
Recommended action

Actions:

Approve
Reject
Modify
View Source
Ask Agent
Request Rescan
Mark Duplicate
Defer

Example card:

CAND-coding-agent-runner-001: OpenTelemetry Agent Metrics
Repo: coding-agent-runner
Confidence: High
Risk: Low
Suggested kind: Go library
Extracts:
- lifecycle metrics
- task duration histograms
- token usage counters
- agent error counters
Source paths:
- internal/telemetry
- internal/events
- internal/runtime/metrics.go
Actions:
[Approve] [Reject] [Modify] [View Source] [Ask Agent]

⸻

11. Candidate State Machine

Candidates should have a strict state machine.

proposed
  -> approved
  -> extraction_planned
  -> extracting
  -> extracted
  -> registered
  -> available_in_workbench

Other paths:

proposed
  -> rejected
proposed
  -> deferred
proposed
  -> needs_rescan
proposed
  -> modified
  -> approved
extracted
  -> duplicate_detected
  -> merge_required
  -> registered

A candidate is not yet a module.

An approved candidate is not yet a module.

An extracted module is not yet composable until it has:

module code
tests
manifest
typed ports
configuration schema
provenance metadata
registry entry

⸻

12. Extraction Plans

When the user approves candidates, the system creates an extraction plan.

The extraction plan should be repo/session-scoped.

Example:

apiVersion: agentfw.dev/v1alpha1
kind: ExtractionPlan
metadata:
  name: coding-agent-runner-extraction-plan
  sessionId: sess-coding-agent-runner-001
  repoName: coding-agent-runner
approvedCandidates:
  - id: CAND-coding-agent-runner-001
    moduleName: otel-agent-metrics
    targetLanguage: go
    moduleKind: library
    sourcePaths:
      - internal/telemetry
      - internal/events
      - internal/runtime/metrics.go
    constraints:
      - preserve behaviour
      - write golden tests
      - remove project-specific dependencies
      - produce module manifest
      - expose typed ports for workbench composition
  - id: CAND-coding-agent-runner-002
    moduleName: agent-supervisor
    targetLanguage: go
    moduleKind: library
    sourcePaths:
      - internal/runtime
      - cmd/agent-runner
    constraints:
      - extract lifecycle supervision only
      - do not extract project-specific CLI commands
      - expose events output port
      - expose health output port
rejectedCandidates:
  - id: CAND-coding-agent-runner-003
    reason: too coupled to project-specific workspace assumptions

The extraction agent should only act on approved candidates in this plan.

⸻

13. Parallelism and Worker Pools

The backend should support concurrent analysis and extraction.

Suggested controls:

workerPool:
  maxConcurrentAnalysisSessions: 4
  maxConcurrentExtractionSessions: 2
  maxConcurrentWiringJobs: 1

Analysis can run with higher concurrency.

Extraction should run with lower concurrency because it modifies code, creates modules, runs tests, and publishes to the registry.

A sensible execution model:

analysis: many in parallel
candidate review: human-paced
extraction: limited parallelism
registry publishing: locked or serialized
blueprint wiring: usually one blueprint at a time

⸻

14. Session Isolation

Because sessions can run in parallel, each session must be isolated.

Each session should have:

own repo checkout or git worktree
own scratch directory
own agent transcript
own candidate report
own extraction plan
own logs
own generated branch
own job state

Example filesystem layout:

/workspaces/sessions/
  sess-coding-agent-runner-001/
    repo/
    scratch/
    reports/
    extraction-plan.yaml
    agent-log.jsonl
  sess-admin-api-server-001/
    repo/
    scratch/
    reports/
    extraction-plan.yaml
    agent-log.jsonl

No worker should directly modify a shared checkout.

⸻

15. Duplicate and Overlap Handling

Parallel discovery may find similar functionality in different repos.

Example:

Repo A discovers config-loader
Repo B discovers env-config-loader
Repo C discovers runtime-config-loader

The system should support local discovery first and global reconciliation later.

local repo discovery
  -> candidate report
  -> registry comparison
  -> duplicate / variant / merge decision

Possible outcomes:

new module
duplicate
variant
adapter needed
merge candidate
reject duplicate

UI example:

Possible duplicate detected
New candidate:
  env-config-loader from deployment-tools
Existing module:
  config-loader from admin-api-server
Options:
  [Publish as variant]
  [Merge into existing module]
  [Create adapter]
  [Reject duplicate]

The repo analysis agent should not reason across every repo at once.

Instead:

Repo Analysis Agent:
  What reusable modules exist in this repo?
Registry Comparison Agent:
  Does this candidate overlap with existing candidates or modules?

⸻

16. Module Registry

The module registry is the shared source of truth for extracted reusable modules.

It stores:

module metadata
module version
source repo
source candidate
source session
language
module kind
import path
capabilities
typed ports
configuration schema
test status
provenance
documentation
examples
compatibility information

The registry feeds the Workbench palette.

A module should not appear as a draggable workbench node until it is registered.

⸻

17. Module Manifest

Every extracted module needs a manifest.

Example:

apiVersion: agentfw.dev/v1alpha1
kind: ModuleManifest
metadata:
  name: otel-agent-metrics
  version: 0.1.0
  sourceRepo: coding-agent-runner
  sourceSession: sess-coding-agent-runner-001
  sourceCandidate: CAND-coding-agent-runner-001
module:
  language: go
  kind: library
  importPath: github.com/agentfw/modules/otel-agent-metrics
description: Converts agent lifecycle events into OpenTelemetry metrics.
capabilities:
  - observability.metrics
  - agent.lifecycle
  - opentelemetry
ports:
  inputs:
    - name: events
      type: AgentLifecycleEventStream
      required: true
    - name: config
      type: OTelMetricsConfig
      required: false
  outputs:
    - name: metrics
      type: OTelMetricStream
    - name: health
      type: HealthStatus
configuration:
  schemaRef: schemas/otel-agent-metrics-config.schema.json
tests:
  status: passing
  command: go test ./...
provenance:
  extractedFrom:
    repo: coding-agent-runner
    session: sess-coding-agent-runner-001
    candidate: CAND-coding-agent-runner-001
    paths:
      - internal/telemetry
      - internal/runtime/metrics.go

⸻

18. Workbench

The Workbench is a visual node-connector interface built around React Flow.

It is where the user composes registered modules into systems.

The workbench should be global, not repo-specific.

Session A extracts OTel Metrics
Session B extracts Admin API
Session C extracts Workspace Manager
Workbench allows composition:
[Workspace Manager] -> [Agent Runner] -> [OTel Metrics]
                                     -> [Admin API]

The Workbench consumes registered module manifests and turns them into draggable nodes.

⸻

19. Workbench Node Types

Suggested node types:

ModuleNode
  An extracted reusable module.
AdapterNode
  Converts one module’s output type to another module’s input type.
RuntimeNode
  Defines how the composed system runs: service, CLI, daemon, worker.
ConfigNode
  Supplies config values, environment variables, and secret references.
DataNode
  Represents storage, queues, filesystems, and artifact stores.
ExternalServiceNode
  Represents external systems such as Prometheus, Grafana, GitHub, Postgres, Redis.
AgentNode
  Represents an AI or coding-agent runtime.
PolicyNode
  Represents rules such as retries, timeouts, approval gates, and permissions.
BlueprintOutputNode
  Represents the final generated/deployable system.

Initial palette examples:

Agent Runner
Agent Supervisor
OpenTelemetry Metrics
Trace Exporter
Log Collector
Admin API
Workspace Manager
Repo Checkout
Task Queue
Model Provider
Tool Registry
Artifact Store
Human Approval Gate
Deployment Generator

⸻

20. Typed Ports and Edges

Nodes should expose typed input and output ports.

Example:

nodeType: otel-agent-metrics
inputs:
  events:
    type: AgentLifecycleEventStream
    required: true
  config:
    type: OTelMetricsConfig
    required: false
outputs:
  metrics:
    type: OTelMetricStream
  health:
    type: HealthStatus

Visually:

        ┌──────────────────────────┐
events ─▶ OTel Agent Metrics        ├─▶ metrics
config ─▶                          ├─▶ health
        └──────────────────────────┘

Edges connect compatible ports.

Valid:

Agent Runner.lifecycleEvents -> OTel Metrics.events

Invalid:

Prometheus Exporter.metrics -> Agent Runner.config

The workbench should validate connections using semantic port types.

Example edge validation:

from:
  node: agent-runner
  port: lifecycleEvents
  type: AgentLifecycleEventStream
to:
  node: otel-agent-metrics
  port: events
  type: AgentLifecycleEventStream
compatible: true

⸻

21. Blueprint Output

The Workbench should emit a blueprint.

The blueprint is the semantic architecture document.

It should not be confused with the React Flow layout JSON.

Example blueprint:

apiVersion: agentfw.dev/v1alpha1
kind: Blueprint
metadata:
  name: coding-agent-observability-stack
nodes:
  - id: repo-checkout
    type: module
    moduleRef: registry.agentfw.dev/workspace/repo-checkout:v0.1.0
  - id: agent-runner
    type: module
    moduleRef: registry.agentfw.dev/runtime/agent-runner:v0.1.0
  - id: otel-metrics
    type: module
    moduleRef: registry.agentfw.dev/observability/otel-agent-metrics:v0.1.0
  - id: prometheus-exporter
    type: external
    provider: prometheus
edges:
  - from:
      node: repo-checkout
      port: workspace
    to:
      node: agent-runner
      port: workspace
  - from:
      node: agent-runner
      port: lifecycleEvents
    to:
      node: otel-metrics
      port: events
  - from:
      node: otel-metrics
      port: metrics
    to:
      node: prometheus-exporter
      port: scrapeTarget
config:
  agent-runner:
    maxConcurrentTasks: 4
  otel-metrics:
    serviceName: coding-agent
    histogramBuckets:
      - 1
      - 5
      - 10
      - 30
      - 60
wiring:
  targetLanguage: go
  outputKind: service
  packageName: github.com/example/generated-agent-stack

⸻

22. React Flow State Versus Blueprint State

The system should store two separate documents.

React Flow JSON
  stores visual layout:
  - node positions
  - viewport
  - zoom
  - UI metadata
  - selected nodes
  - visual grouping
Blueprint YAML/JSON
  stores semantic architecture:
  - modules
  - ports
  - edges
  - config
  - runtime
  - deployment target
  - wiring instructions

Recommended storage:

blueprint:
  semanticDocument: blueprint.yaml
  visualDocument: flow-layout.json

This prevents visual layout changes from accidentally changing the architecture.

⸻

23. Web UI Structure

The Web UI should be the main control surface.

Core screens:

1. Repos
2. Sessions
3. Candidates
4. Modules
5. Workbench
6. Blueprints
7. Agent Jobs

Important working screens:

Sessions Dashboard
Candidate Review
Module Registry
React Flow Workbench
Blueprint Runs

⸻

24. Sessions Dashboard

The sessions dashboard shows parallel repo sessions.

Example:

┌──────────────────────────────────────────────────────────────┐
│ Repo Sessions                                                │
├───────────────────────────┬───────────────┬──────────────────┤
│ Repo                      │ Status        │ Action           │
├───────────────────────────┼───────────────┼──────────────────┤
│ coding-agent-runner       │ Analysing     │ View progress    │
│ admin-api-server          │ Candidates    │ Review           │
│ deployment-tools          │ Awaiting hint │ Add intent       │
│ telemetry-sidecar         │ Extracting    │ View logs        │
│ workspace-manager         │ Registered    │ Open modules     │
└───────────────────────────┴───────────────┴──────────────────┘

This allows many sessions to run without forcing the user to review everything at once.

⸻

25. Candidate Review Screen

The candidate review screen presents candidates grouped by repo/session.

It should support:

session filter
repo filter
status filter
risk filter
confidence filter
capability filter
bulk approve
bulk reject
modify candidate
ask agent for explanation
view source
compare with existing modules

Candidate statuses should be visible:

Proposed
Modified
Approved
Rejected
Deferred
Extracting
Extracted
Registered
Duplicate Detected
Available in Workbench

⸻

26. Module Registry Screen

The module registry screen shows extracted modules.

Grouped by category:

Observability
  OTel Agent Metrics
  Log Collector
  Trace Exporter
Runtime
  Agent Runner
  Agent Supervisor
  Task Queue
Admin
  Admin Status API
  Audit Log Writer
Workspace
  Repo Checkout
  Workspace Manager
  Artifact Store

For each module, show:

name
version
source repo
source candidate
language
kind
capabilities
ports
tests
documentation
examples
dependency graph
available in workbench: yes/no

⸻

27. Workbench UI

The Workbench should be a React Flow-style node canvas.

Main areas:

┌────────────────────────────────────────────────────────────┐
│ Top bar: blueprint name, validation status, generate code  │
├───────────────┬──────────────────────────┬─────────────────┤
│ Module palette│ React Flow canvas        │ Inspector       │
│               │                          │                 │
│ Observability │ [nodes and edges]        │ selected node   │
│ Runtime       │                          │ ports           │
│ Admin         │                          │ config          │
│ Workspace     │                          │ validation      │
└───────────────┴──────────────────────────┴─────────────────┘

The user should be able to:

drag registered modules onto canvas
connect typed ports
configure nodes
add adapters
add runtime nodes
add config nodes
validate the graph
save blueprint
generate code

⸻

28. Agent Roles

The system should use several specialised agents or agent modes.

Repo Analysis Agent
  Analyses one repo and proposes candidates.
Extraction Agent
  Extracts approved candidates into reusable modules.
Module Test Agent
  Writes and runs tests for extracted modules.
Registry Comparison Agent
  Detects duplicates and overlaps with existing modules.
Documentation Agent
  Produces module docs, examples, and manifests.
Blueprint Validation Agent
  Checks whether a blueprint graph is semantically valid.
Wiring Agent
  Generates runnable code from a blueprint.

Each agent should have clear boundaries.

Most important boundary:

The repo analysis agent does not modify code.
The extraction agent only acts on approved extraction plans.
The wiring agent only acts on approved blueprints.

⸻

29. Discovery Agent Prompt

Suggested repo analysis prompt:

You are analysing a single repository as part of a repo-by-repo modularisation workflow.
Do not analyse unrelated repositories unless explicitly instructed.
Before analysing this repository, ask the user what functionality they want extracted from this repository.
If the user provides suggestions, prioritise those areas.
If the user has no suggestions, inspect the repository and propose reusable candidates.
Do not modify files during discovery.
Return candidates for this repository only.
Each candidate must include:
- candidate ID
- repo name
- session ID
- source paths
- functionality description
- why it is reusable
- project-specific coupling
- suggested module kind
- target language
- dependencies
- risks
- tests found
- missing tests
- extraction notes
- proposed ports
- proposed workbench node shape
Focus especially on:
- OpenTelemetry metrics
- traces and logs
- agent lifecycle events
- agent administration
- orchestration
- process supervision
- workspace management
- repository checkout
- task queues
- model/provider abstraction
- deployment helpers
- webhooks
- audit logs
- admin APIs
Output only the candidate report and approval request.

⸻

30. Extraction Agent Rules

The extraction agent should follow these rules:

Only extract approved candidates.
Use the extraction plan as the source of truth.
Preserve behaviour.
Prefer Go as the target language unless otherwise specified.
Remove project-specific dependencies.
Create clear public APIs.
Expose typed ports for workbench composition.
Write tests.
Generate module manifest.
Generate docs and examples.
Record provenance.
Do not publish until tests pass.

The extraction result should include:

module source code
go.mod
tests
README
examples
ModuleManifest
configuration schema
port definitions
provenance metadata

⸻

31. Blueprint Wiring Agent Rules

The wiring agent takes a blueprint and generates code.

It should:

read the blueprint
resolve module references
validate ports and edges
generate glue code
generate configuration loading
generate runtime setup
generate dependency injection
generate service or CLI entrypoints
generate tests
generate deployment scaffolding where requested

The wiring agent should not invent new architecture silently.

If the blueprint is invalid, it should return a validation report.

If adapters are needed, it should either:

generate adapter nodes/code
or ask for approval before introducing adapters

⸻

32. Key System Guarantees

The agreed system should enforce these guarantees:

1. Repo-scoped analysis
   Each analysis session focuses on one repo.
2. Parallel execution
   Many repo sessions can run at the same time.
3. User intent first
   Each session asks what functionality the user wants extracted.
4. Agent fallback
   If the user has no suggestions, the agent proposes candidates itself.
5. Human approval gate
   No extraction happens before approval.
6. Candidate provenance
   Every candidate is linked to repo, session, files, and reasoning.
7. Module provenance
   Every module records where it came from.
8. Registry before workbench
   Only registered modules become composable nodes.
9. Typed composition
   Workbench connections use typed ports.
10. Blueprint as contract
   The workbench emits a blueprint; the AI wiring agent implements it.
11. Visual state separated from semantic state
   React Flow layout is separate from blueprint architecture.
12. Local discovery, global reconciliation
   Repos are analysed independently, but modules are deduplicated at the registry layer.

⸻

33. Full Agreed Flow

1. User adds repositories.
2. System creates one RepoSession per repository.
3. User can provide default discovery focus:
   - observability
   - orchestration
   - agent administration
   - workspace management
   - deployment helpers
4. Each repo session asks for repo-specific extraction intent.
5. User answers per repo or applies defaults.
6. Several repo sessions run in parallel.
7. Each analysis agent stays inside its assigned repo.
8. Each session emits a candidate report.
9. Web UI shows candidates grouped by session.
10. User reviews candidates:
    - approve
    - reject
    - modify
    - defer
    - request rescan
11. Approved candidates become extraction plans.
12. Extraction agents run with controlled concurrency.
13. Extracted modules are tested.
14. Module manifests are generated.
15. Registry comparison detects duplicates or overlaps.
16. Registered modules become available in the Workbench palette.
17. User opens the React Flow Workbench.
18. User drags modules onto canvas.
19. User connects typed ports.
20. Workbench validates the graph.
21. Workbench emits blueprint.yaml.
22. AI wiring agent generates runnable code from blueprint.yaml.
23. Generated system can be tested, deployed, and iterated.

⸻

34. Product Definition

The product is best described as:

An AI-assisted modularisation and composition workbench for agent infrastructure.

Or more explicitly:

A system that uses AI coding agents to discover reusable functionality from existing repositories, extract approved functionality into reusable Go modules, register those modules with typed manifests, and let users compose them visually into blueprints using a React Flow node workbench. The resulting blueprints are then wired into runnable systems by an AI agent.

The user experience should feel like:

1. Add repos.
2. Let agents analyse them in parallel.
3. Review useful candidates repo by repo.
4. Approve what should become reusable.
5. Watch modules enter the registry.
6. Drag modules into a visual workbench.
7. Connect them.
8. Generate a blueprint.
9. Let an AI agent wire the system.

This captures the system agreed so far.
