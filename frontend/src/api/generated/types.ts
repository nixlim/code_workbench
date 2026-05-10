// Generated from openapi.yaml sha256:09b8e092021ead2eb1dadf82706e7f8b092feda186123b29fb04e8b9c0ff46a6
export type APIRecord = Record<string, unknown>;

export interface ListEnvelope<T = APIRecord> {
  items: T[];
}

export interface Repository {
  id: string;
  name: string;
  sourceType: 'local_path' | 'git_url';
  sourceUri: string;
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

export interface Candidate {
  id: string;
  sessionId: string;
  repositoryId: string;
  proposedName: string;
  description: string;
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
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Blueprint {
  id: string;
  name: string;
  validationStatus: 'not_run' | 'valid' | 'invalid';
  targetLanguage: string;
  outputKind: string;
  packageName: string;
}
