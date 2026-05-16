// Generated from openapi.yaml sha256:993ec747689d7592f534bc6fabe3c762fb6b6b10d2a07b8a3d0633cb5da4db0c
export type APIRecord = Record<string, unknown>;

export interface ListEnvelope<T = APIRecord> {
  items: T[];
}

export interface Repository {
  id: string;
  name: string;
  sourceType: 'local_path' | 'git_url';
  sourceUri: string;
  sourceCheckoutPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  repositoryId: string;
  repoName: string;
  phase: string;
  activeJobRole?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionCleanupResult {
  deleted: number;
  retained: number;
}

export interface Candidate {
  id: string;
  sessionId: string;
  repositoryId: string;
  proposedName: string;
  description: string;
  moduleKind: string;
  targetLanguage: string;
  status: string;
  extractionRisk: string;
  confidence: string;
  sourcePathsJson?: string[] | string;
  reusableRationale?: string;
  couplingNotes?: string;
  dependenciesJson?: string[] | string;
  sideEffectsJson?: string[] | string;
  testsFoundJson?: string[] | string;
  missingTestsJson?: string[] | string;
  portsJson?: APIRecord;
  comparedModuleId?: string;
  registryDecision?: 'add' | 'replace' | 'keep-as-variant' | 'drop';
  architectureScoreJson?: APIRecord;
  userReason?: string;
}

export interface ModuleRecord {
  id: string;
  name: string;
  version: string;
  sourceRepositoryId: string;
  sourceCandidateId: string;
  language: string;
  moduleKind: string;
  capabilitiesJson: string[] | string;
  portsJson: APIRecord;
  supersedesModuleId?: string;
  supersededByModuleId?: string;
  registryDecision?: 'add' | 'replace' | 'keep-as-variant' | 'drop';
  architectureScoreJson?: APIRecord;
  sourceCheckoutPath?: string;
  testStatus: string;
  docsPath: string;
  availableInWorkbench: number;
}

export interface RegistryComparison {
  moduleId: string;
  comparedModuleId?: string;
  classification: 'new_module' | 'duplicate' | 'variant' | 'adapter_needed' | 'merge_candidate' | 'reject_duplicate';
  capabilityOverlap: number;
  sourcePathOverlap: number;
  portsIdentical: boolean;
  configIdentical: boolean;
  dependenciesOverlap: boolean;
}

export interface ValidateEdgeRequest {
  sourceModuleId: string;
  sourcePort: string;
  targetModuleId: string;
  targetPort: string;
}

export interface AgentJob {
  id: string;
  role: string;
  provider: string;
  status: string;
  subjectType: string;
  subjectId: string;
  tmuxSessionName?: string;
  timeoutSeconds?: number;
  exitCode?: number;
  errorCode?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  promptPath?: string;
  transcriptPath?: string;
  outputArtifactPath?: string;
  attachCommand?: string;
  prompt?: JobTextArtifact;
  transcript?: JobTextArtifact & { lineCount?: number; events?: AgentLogEvent[] };
  activityLog?: JobTextArtifact & { lineCount?: number; events?: AgentLogEvent[] };
  outputFiles?: Array<{ path: string; size: number }>;
  metrics?: Record<string, number>;
}

export interface JobTextArtifact {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface AgentLogEvent {
  kind: 'prompt' | 'tool' | 'error' | 'metric' | 'message';
  line: number;
  text: string;
}

export interface Blueprint {
  id: string;
  name: string;
  validationStatus: 'not_run' | 'valid' | 'invalid';
  targetLanguage: string;
  outputKind: string;
  packageName: string;
}

export interface SpecEnrichment {
  id: string;
  specPath: string;
  outputPath: string;
  artifactRoot: string;
  status: 'created' | 'queued' | 'running' | 'succeeded' | 'failed';
  selectedModulesJson?: string[] | string;
  registryReferencesPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Composition {
  id: string;
  name: string;
  intent: string;
  selectedModulesJson: string[] | string;
  flowLayoutPath: string;
  status: 'draft' | 'clarifying' | 'awaiting_answers' | 'ready_to_compile' | 'compiling' | 'compiled' | 'failed';
  questionsJson?: Array<{ id?: string; question?: string }>;
  answersJson?: APIRecord;
  blueprintPath?: string;
  specPath?: string;
  createdAt: string;
  updatedAt: string;
}
