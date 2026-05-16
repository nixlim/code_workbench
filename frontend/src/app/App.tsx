import ReactFlow, { Background, Controls, Handle, Position, addEdge, useEdgesState, useNodesState, type Connection, type NodeProps } from 'reactflow';
import { AlertCircle, Ban, Boxes, Check, ChevronDown, ChevronRight, Clock, Copy, FileText, GitBranch, LayoutDashboard, Loader2, PlaySquare, Plus, RefreshCw, Settings2, Trash2, WandSparkles, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentJob, Candidate, Composition, ModuleRecord, Repository, Session, SessionCleanupResult, SpecEnrichment } from '../api/generated/types';
import { APIRequestError, api } from '../api/client';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Select } from '../components/ui/select';
import { Dialog } from '../components/ui/dialog';
import { ConfirmProvider, useConfirm } from '../components/ui/confirm';
import { WorkbenchView } from '../components/workbench/WorkbenchView';
import { cn } from '../lib/utils';

type Screen = 'registry' | 'spec' | 'composition' | 'workbench' | 'modules' | 'jobs';
type Port = { name: string; type: string; required?: boolean };
type ModuleNodeData = { label: string; module: ModuleRecord };
type TargetLanguageOption = { value: string; label: string };
type StepState = 'todo' | 'active' | 'done' | 'blocked';
type Navigate = (screen: Screen) => void;

const defaultExtractionTargetLanguage = 'go';
const targetLanguageOptions: TargetLanguageOption[] = [
  { value: 'go', label: 'Go' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'rust', label: 'Rust' }
];

function normalizeTargetLanguage(value?: string) {
  const normalized = value?.trim().toLowerCase();
  return normalized || defaultExtractionTargetLanguage;
}

function targetLanguageLabel(value?: string) {
  const normalized = normalizeTargetLanguage(value);
  return targetLanguageOptions.find((option) => option.value === normalized)?.label ?? value ?? 'Go';
}

const screens: Array<{ id: Screen; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'registry', label: 'Registry & Extraction', icon: GitBranch },
  { id: 'spec', label: 'Spec Enrichment', icon: FileText },
  { id: 'composition', label: 'Composition', icon: WandSparkles },
  { id: 'workbench', label: 'Workbench', icon: LayoutDashboard },
  { id: 'modules', label: 'Modules', icon: Boxes },
  { id: 'jobs', label: 'Agent Jobs', icon: PlaySquare }
];

const candidateReviewPhases = new Set(['awaiting_approval', 'candidates_ready']);
const analysisRunningPhases = new Set(['queued', 'analysing']);
const hasReviewableCandidates = (item: Session) => candidateReviewPhases.has(item.phase);
const isAnalysisRunning = (item: Session) => analysisRunningPhases.has(item.phase);
const isFailedPhase = (phase: string) => phase.startsWith('failed');
const sessionNotice = (item: Session) => hasReviewableCandidates(item)
  ? `${item.repoName} analysis succeeded. Review proposed candidates.`
  : `Extraction session ${item.id} is ${item.phase}.`;
const sessionActionLabel = (item: Session) => hasReviewableCandidates(item) ? 'Review candidates' : 'Continue';

function useRunningJobCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true;
    const poll = () => api.list<AgentJob>('/api/agent-jobs')
      .then((r) => { if (active) setCount(r.items.filter((job) => job.status === 'running').length); })
      .catch(() => { /* badge is best-effort */ });
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return count;
}

export function App() {
  return (
    <ConfirmProvider>
      <AppShell />
    </ConfirmProvider>
  );
}

function AppShell() {
  const [screen, setScreenState] = useState<Screen>(() => {
    const saved = window.localStorage.getItem('code-workbench:screen');
    return screens.some((item) => item.id === saved) ? saved as Screen : 'registry';
  });
  const [error, setError] = useState('');
  const runningJobs = useRunningJobCount();
  const setScreen = useCallback((value: Screen) => {
    setScreenState(value);
    window.localStorage.setItem('code-workbench:screen', value);
  }, []);

  return (
    <div className="grid grid-cols-[56px_1fr] min-h-screen lg:grid-cols-[220px_1fr]">
      <aside className="bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="px-4 py-4 border-b border-sidebar-border hidden lg:block">
          <h1 className="text-sm font-semibold text-sidebar-text-active tracking-tight">Code Workbench</h1>
        </div>
        <nav className="flex flex-col gap-0.5 p-2 flex-1" aria-label="Primary">
          {screens.map((item) => {
            const Icon = item.icon;
            const isActive = screen === item.id;
            const badge = item.id === 'jobs' && runningJobs > 0 ? runningJobs : null;
            return (
              <button
                key={item.id}
                title={item.label}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'relative flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors duration-100 border-none cursor-pointer w-full text-left justify-center lg:justify-start',
                  isActive
                    ? 'bg-sidebar-active text-sidebar-text-active font-medium'
                    : 'text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-text-active'
                )}
                onClick={() => setScreen(item.id)}
              >
                <span className="relative shrink-0">
                  <Icon size={16} />
                  {badge !== null && (
                    <span className="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent-emphasis px-1 text-[9px] font-semibold text-white lg:hidden" aria-hidden="true">
                      {badge}
                    </span>
                  )}
                </span>
                <span className="hidden lg:inline flex-1">{item.label}</span>
                {badge !== null && (
                  <span className="hidden lg:inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-emphasis px-1 text-[10px] font-semibold text-white">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="p-3 border-t border-sidebar-border hidden lg:block">
          <span className="text-xs text-sidebar-text/60">v0.1.0</span>
        </div>
      </aside>
      <main className="overflow-auto">
        <div className="max-w-[1400px] mx-auto p-6">
          {error && (
            <div role="alert" className="flex items-center gap-2 bg-danger-subtle border border-danger-muted text-danger-fg rounded-lg px-4 py-3 mb-4 text-sm animate-in">
              <AlertCircle size={16} className="shrink-0" />
              <span className="flex-1">{error}</span>
              <button onClick={() => setError('')} aria-label="Dismiss error" className="p-0.5 hover:bg-danger-muted/30 rounded border-none cursor-pointer text-danger-fg">
                <X size={14} />
              </button>
            </div>
          )}
          {screen === 'registry' && <RegistryExtractionWizard onError={setError} onNavigate={setScreen} />}
          {screen === 'spec' && <SpecEnrichmentWizard onError={setError} />}
          {screen === 'composition' && <CompositionWizard onError={setError} onNavigate={setScreen} />}
          {screen === 'workbench' && <WorkbenchView onError={setError} />}
          {screen === 'modules' && <Modules onError={setError} onNavigate={setScreen} />}
          {screen === 'jobs' && <Jobs onError={setError} />}
        </div>
      </main>
    </div>
  );
}

function RegistryExtractionWizard({ onError, onNavigate }: { onError: (value: string) => void; onNavigate: Navigate }) {
  const confirm = useConfirm();
  const [sourceType, setSourceType] = useState<'local_path' | 'git_url'>('local_path');
  const [sourceUri, setSourceUri] = useState('');
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [repo, setRepo] = useState<Repository | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState('');
  const [intent, setIntent] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [reason, setReason] = useState('approved for extraction');
  const [planId, setPlanId] = useState('');
  const [message, setMessage] = useState('');
  const [refreshedRepoId, setRefreshedRepoId] = useState('');
  const [activeSessionNotice, setActiveSessionNotice] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [decisionBusy, setDecisionBusy] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [defaultTargetLanguage, setDefaultTargetLanguage] = useState(defaultExtractionTargetLanguage);
  const [candidateTargetLanguages, setCandidateTargetLanguages] = useState<Record<string, string>>({});
  const approvedIds = useMemo(() => candidates.filter((c) => c.status === 'approved').map((c) => c.id), [candidates]);
  const approvedCandidates = useMemo(() => candidates.filter((c) => c.status === 'approved'), [candidates]);
  const selectedSourceUri = repo?.sourceUri ?? '';
  const rescanSourceUri = sourceUri.trim() || selectedSourceUri;
  const rescanSourceType = sourceUri.trim() ? sourceType : (repo?.sourceType ?? sourceType);
  const rescanLabel = sourceUri.trim() ? 'Rescan source' : repo ? `Rescan ${repo.name}` : 'Rescan source';
  const sourceNeedsRefresh = Boolean(repo && !session && !pendingSessionId && repo.id !== refreshedRepoId);
  const nextAction = repo
    ? session && hasReviewableCandidates(session)
      ? `Review proposed extraction candidates for ${session.repoName}.`
      : pendingSessionId
      ? `Continue the extraction session for ${repo.name}.`
      : intent.trim()
      ? `Start candidate scan for ${repo.name}.`
      : sourceNeedsRefresh
        ? `Rescan ${repo.name} to refresh .sources, then describe what reusable functionality to extract.`
        : `Describe what reusable functionality to extract, then start candidate scan for ${repo.name}.`
    : 'Import a repository or choose a registered source.';

  const stepStates: StepState[] = [
    repo && (session || pendingSessionId) ? 'done' : 'active',
    !session ? 'blocked' : candidates.length > 0 ? 'done' : 'active',
    candidates.length === 0 ? 'blocked' : approvedIds.length > 0 ? 'done' : 'active',
    approvedIds.length === 0 ? 'blocked' : planId ? 'done' : 'active'
  ];
  const activeStep = stepStates.findIndex((s) => s === 'active');

  const loadRepositories = () => api.list<Repository>('/api/repositories').then((r) => {
    setRepositories(r.items);
    return r.items;
  }).catch((e) => {
    onError(e.message);
    return [];
  });
  const loadCandidates = (sessionId = session?.id) => {
    if (!sessionId) return Promise.resolve();
    return api.list<Candidate>(`/api/candidates?sessionId=${encodeURIComponent(sessionId)}`).then((r) => setCandidates(r.items)).catch((e) => onError(e.message));
  };
  const activateSession = (item: Session, repoList = repositories) => {
    setSession(item);
    setPendingSessionId('');
    setRepo(repoList.find((r) => r.id === item.repositoryId) ?? repo);
    setActiveSessionNotice(sessionNotice(item));
    void loadCandidates(item.id);
  };
  const loadSessions = (repoList = repositories, autoActivate = false) => api.list<Session>('/api/sessions').then((r) => {
    setSessions(r.items);
    const current = session ? r.items.find((item) => item.id === session.id) : undefined;
    if (current && current.phase !== session?.phase) {
      setSession(current);
      setActiveSessionNotice(sessionNotice(current));
      if (hasReviewableCandidates(current)) {
        void loadCandidates(current.id);
      }
    }
    if (autoActivate && !session && !pendingSessionId) {
      const reviewable = r.items.find(hasReviewableCandidates);
      if (reviewable) {
        activateSession(reviewable, repoList);
      }
    }
    return r.items;
  }).catch((e) => {
    onError(e.message);
    return [];
  });
  useEffect(() => {
    void Promise.all([api.list<Repository>('/api/repositories'), api.list<Session>('/api/sessions')]).then(([repoList, sessionList]) => {
      setRepositories(repoList.items);
      setSessions(sessionList.items);
      const reviewable = sessionList.items.find(hasReviewableCandidates);
      if (reviewable) {
        activateSession(reviewable, repoList.items);
      }
    }).catch((e) => onError(e.message));
  }, []);
  useEffect(() => {
    if (!session || !isAnalysisRunning(session)) return;
    const timer = window.setInterval(() => {
      void loadSessions(repositories, true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.phase, repositories]);

  const startSession = async (target: Repository, refreshed = false, activate = true) => {
    setSourceType(target.sourceType);
    setSourceUri(target.sourceUri);
    let usable = target;
    if (!target.sourceCheckoutPath) {
      usable = await api.post<Repository>('/api/repositories', {
        name: target.name,
        sourceType: target.sourceType,
        sourceUri: target.sourceUri,
        rescan: true
      });
      await loadRepositories();
      setMessage(`${usable.name} had no .sources checkout, so it was rescanned first.`);
      refreshed = true;
    }
    setRepo(usable);
    setRefreshedRepoId(refreshed ? usable.id : '');
    let created: Session;
    try {
      created = await api.post<Session>('/api/sessions', { repositoryId: usable.id });
    } catch (e) {
      if (e instanceof APIRequestError && e.code === 'repository.clone_failed') {
        usable = await api.post<Repository>('/api/repositories', {
          name: target.name,
          sourceType: target.sourceType,
          sourceUri: target.sourceUri,
          rescan: true
        });
        await loadRepositories();
        setRepo(usable);
        created = await api.post<Session>('/api/sessions', { repositoryId: usable.id });
      } else {
        throw e;
      }
    }
    if (activate) {
      setSession(created);
      setPendingSessionId('');
    } else {
      setSession(null);
      setPendingSessionId(created.id);
    }
    setCandidates([]);
    setPlanId('');
    setActiveSessionNotice(activate ? `Extraction session ${created.id} is ${created.phase}.` : `Extraction session ${created.id} is ready. Press Continue to select it.`);
    setMessage(activate ? `${usable.name} is ready for candidate scanning. Agent Jobs will update after Start candidate scan.` : `${usable.name} has a new extraction session. Continue it before entering intent.`);
    await loadSessions();
    return created;
  };
  const begin = async () => {
    setBusyAction('Importing source and creating extraction session...');
    try {
      const saved = await api.post<Repository>('/api/repositories', { sourceType, sourceUri });
      await loadRepositories();
      await startSession(saved, true);
    } catch (e) {
      if (e instanceof APIRequestError && e.code === 'repository.duplicate') {
        const existing = e.details?.repository as Repository | undefined;
        if (existing?.id) {
          await loadRepositories();
          await startSession(existing);
          setMessage(`${existing.name} is already registered. Using the existing .sources checkout.`);
          return;
        }
      }
      throw e;
    } finally {
      setBusyAction('');
    }
  };
  const rescan = async () => {
    if (!rescanSourceUri) {
      setMessage('Choose a registered source or enter a repository path before rescanning.');
      return;
    }
    setBusyAction(`Rescanning ${repo?.name ?? 'source'} and creating extraction session...`);
    try {
      const saved = await api.post<Repository>('/api/repositories', {
        sourceType: rescanSourceType,
        sourceUri: rescanSourceUri,
        rescan: true
      });
      await loadRepositories();
      const created = await startSession(saved, true);
      setMessage(`${saved.name} was rescanned into .sources and extraction session ${created.id} was created. Enter an intent and press Start candidate scan to create an Agent Jobs entry.`);
    } finally {
      setBusyAction('');
    }
  };
  const scan = async () => {
    if (!session) return;
    const updated = await api.post<Session>(`/api/sessions/${session.id}/intent`, { specificFunctionality: intent, allowAgentDiscovery: true, expectedUpdatedAt: session.updatedAt });
    setSession(updated);
    await api.post<AgentJob>(`/api/sessions/${session.id}/analysis-jobs`, {});
    await loadSessions(repositories, true);
    setMessage('Candidate scan started. Track progress under Agent Jobs.');
  };
  const clearPreviousSessions = async () => {
    const decision = await confirm({
      title: 'Clear previous extraction sessions?',
      body: 'This permanently deletes every other extraction session. The currently selected session is kept.',
      variant: 'danger',
      confirmLabel: 'Clear sessions'
    });
    if (!decision.confirmed) return;
    const query = session?.id ? `?keepSessionId=${encodeURIComponent(session.id)}` : '';
    const result = await api.request<SessionCleanupResult>(`/api/sessions${query}`, { method: 'DELETE' });
    if (result.deleted > 0) {
      setMessage(`Cleared ${result.deleted} previous extraction ${result.deleted === 1 ? 'session' : 'sessions'}.`);
    } else {
      setMessage('No previous extraction sessions could be cleared.');
    }
    await loadSessions(repositories, true);
  };
  const continueSession = (item: Session) => {
    activateSession(item);
  };
  const decide = async (candidate: Candidate, action: 'approve' | 'reject' | 'defer' | 'rescan') => {
    let effectiveReason = reason;
    if (action === 'reject') {
      const decision = await confirm({
        title: `Drop ${candidate.proposedName}?`,
        body: 'This rejects the candidate so it will not be extracted.',
        variant: 'danger',
        confirmLabel: 'Drop candidate',
        withReason: true,
        reasonLabel: 'Decision reason',
        defaultReason: reason
      });
      if (!decision.confirmed) return;
      effectiveReason = decision.reason?.trim() || reason;
    } else if (action === 'rescan') {
      const decision = await confirm({
        title: `Rescan ${candidate.proposedName}?`,
        body: 'This re-runs analysis for this candidate and may create a new agent job.',
        variant: 'primary',
        confirmLabel: 'Rescan candidate',
        withReason: true,
        reasonLabel: 'Reason',
        defaultReason: reason
      });
      if (!decision.confirmed) return;
      effectiveReason = decision.reason?.trim() || reason;
    }
    setDecisionBusy(`${candidate.id}:${action}`);
    try {
      await api.post<Candidate>(`/api/candidates/${candidate.id}/${action}`, { reason: effectiveReason });
      await loadCandidates(candidate.sessionId);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setDecisionBusy('');
    }
  };
  const openExtractionConfig = () => {
    const next: Record<string, string> = {};
    for (const candidate of approvedCandidates) {
      next[candidate.id] = candidateTargetLanguages[candidate.id] ?? defaultExtractionTargetLanguage;
    }
    setDefaultTargetLanguage(defaultExtractionTargetLanguage);
    setCandidateTargetLanguages(next);
    setConfigOpen(true);
  };
  const applyDefaultTargetLanguage = (value: string) => {
    setDefaultTargetLanguage(value);
    setCandidateTargetLanguages((current) => {
      const next: Record<string, string> = {};
      for (const candidate of approvedCandidates) {
        next[candidate.id] = value || current[candidate.id] || defaultExtractionTargetLanguage;
      }
      return next;
    });
  };
  const setCandidateTargetLanguage = (candidateId: string, value: string) => {
    setCandidateTargetLanguages((current) => ({ ...current, [candidateId]: value }));
  };
  const configureAndCreatePlan = async () => {
    if (!session || approvedCandidates.length === 0) return;
    const configured = approvedCandidates.map((candidate) => ({
      ...candidate,
      targetLanguage: normalizeTargetLanguage(candidateTargetLanguages[candidate.id])
    }));
    await Promise.all(configured.map((candidate) => api.patch<Candidate>(`/api/candidates/${candidate.id}`, {
      targetLanguage: candidate.targetLanguage
    })));
    const plan = await api.post<{ id: string }>('/api/extraction-plans', {
      sessionId: session.id,
      approvedCandidateIds: configured.map((candidate) => candidate.id),
      rejectedCandidateIds: candidates.filter((c) => c.status === 'rejected').map((c) => c.id)
    });
    setPlanId(plan.id);
    setConfigOpen(false);
    setMessage(`Extraction plan ${plan.id} configured for ${targetLanguageLabel(defaultTargetLanguage)} output.`);
    await loadCandidates(session.id);
  };

  return (
    <section className="space-y-4">
      <PageHeader title="Registry & Code Extraction" />
      <NextActionBar text={nextAction} />
      <div className="space-y-4">
        {/* Step 1: Source */}
        <StepCard n={1} title="Source" state={stepStates[0]} active={activeStep === 0}>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={sourceType} onChange={(e) => setSourceType(e.target.value as 'local_path' | 'git_url')} aria-label="Source type">
                <option value="local_path">Local path</option>
                <option value="git_url">Git URL</option>
              </Select>
              <Input className="flex-1 min-w-[200px]" value={sourceUri} onChange={(e) => setSourceUri(e.target.value)} placeholder="Repository path or URL" />
              <Button disabled={Boolean(busyAction)} onClick={() => begin().catch((e) => onError(e.message))}>Import to .sources</Button>
              <Button
                variant={sourceNeedsRefresh && !intent.trim() ? 'attention' : 'default'}
                disabled={Boolean(busyAction)}
                onClick={() => rescan().catch((e) => onError(e.message))}
              >
                {rescanLabel}
              </Button>
              <Button variant="ghost" size="icon" onClick={() => { void loadRepositories().then((repoList) => loadSessions(repoList, true)); }} aria-label="Refresh registered sources">
                <RefreshCw size={14} />
              </Button>
            </div>

            {busyAction && (
              <div className="flex items-center gap-2 bg-accent-subtle border border-accent-fg/20 rounded-md px-3 py-2 text-sm text-accent-fg">
                <Loader2 size={14} className="animate-spin" />
                <span>{busyAction}</span>
              </div>
            )}
            <LiveRegion>
              {message && <Notice>{message}</Notice>}
              {activeSessionNotice && <Notice>{activeSessionNotice}</Notice>}
            </LiveRegion>
            {repo && repo.sourceCheckoutPath && (
              <div className="text-xs text-gray-500 font-mono bg-surface-secondary rounded px-2 py-1.5">
                {repo.name} stored at {repo.sourceCheckoutPath}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4 pt-2">
              <div>
                <SectionLabel>Registered sources</SectionLabel>
                <div className="space-y-1.5">
                  {repositories.map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        'flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5 text-sm transition-colors duration-100',
                        repo?.id === item.id
                          ? 'border-accent-fg bg-accent-subtle/50 ring-1 ring-accent-fg/20'
                          : 'border-border-default bg-surface hover:border-border-muted hover:bg-surface-secondary'
                      )}
                    >
                      <span className="font-medium text-gray-900">{item.name}</span>
                      <Badge>{item.sourceType}</Badge>
                      <span className="text-xs text-gray-500 font-mono flex-1 truncate">{item.sourceCheckoutPath || item.sourceUri}</span>
                      <Button size="sm" onClick={() => startSession(item, false, false).catch((e) => onError(e.message))}>
                        Use for extraction
                      </Button>
                    </div>
                  ))}
                  {repositories.length === 0 && <EmptyState>No registered sources. Import a repository above to begin.</EmptyState>}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <SectionLabel className="mb-0">Recent sessions</SectionLabel>
                  <Button variant="ghost" size="sm" disabled={sessions.length === 0 || Boolean(busyAction)} onClick={() => clearPreviousSessions().catch((e) => onError(e.message))}>
                    <Trash2 size={12} />
                    Clear
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {sessions.slice(0, 6).map((item) => {
                    const failed = isFailedPhase(item.phase);
                    const reviewable = hasReviewableCandidates(item);
                    return (
                      <div
                        key={item.id}
                        className={cn(
                          'flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors duration-100',
                          session?.id === item.id || pendingSessionId === item.id
                            ? 'border-accent-fg bg-accent-subtle/50 ring-1 ring-accent-fg/20'
                            : 'border-border-default bg-surface hover:bg-surface-secondary'
                        )}
                      >
                        <span className="font-medium text-gray-900">{item.repoName}</span>
                        <Badge variant={reviewable ? 'success' : failed ? 'danger' : 'default'} title={failed ? `Session ${item.id} ${item.phase}` : undefined}>{item.phase}</Badge>
                        <span className="flex items-center gap-1 text-xs text-gray-400" title={item.updatedAt}>
                          <Clock size={11} />{relativeTime(item.updatedAt || item.createdAt)}
                        </span>
                        <div className="flex-1" />
                        <Button
                          size="sm"
                          variant={pendingSessionId === item.id || reviewable ? 'attention' : 'default'}
                          onClick={() => continueSession(item)}
                        >
                          {sessionActionLabel(item)}
                        </Button>
                      </div>
                    );
                  })}
                  {sessions.length === 0 && <EmptyState>No extraction sessions.</EmptyState>}
                </div>
              </div>
            </div>
          </CardContent>
        </StepCard>

        {/* Step 2: Scan */}
        <StepCard n={2} title="Scan candidates" state={stepStates[1]} active={activeStep === 1}>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input className="flex-1 min-w-[200px]" value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Reusable functionality to extract" aria-label="Reusable functionality to extract" />
              <Button variant={session && intent.trim() ? 'primary' : 'default'} disabled={!session} onClick={() => scan().catch((e) => onError(e.message))}>
                Start candidate scan
              </Button>
              <Button variant="ghost" disabled={!session} onClick={() => void loadCandidates()}>
                <RefreshCw size={14} />
                Refresh
              </Button>
              {session && (
                <Button variant="ghost" size="sm" onClick={() => onNavigate('jobs')}>
                  <PlaySquare size={13} /> View Agent Jobs
                </Button>
              )}
            </div>
            {session && (
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Badge variant={isAnalysisRunning(session) ? 'accent' : isFailedPhase(session.phase) ? 'danger' : 'default'}>{session.phase}</Badge>
                <span className="text-gray-500">{session.repoName}</span>
              </div>
            )}
          </CardContent>
        </StepCard>

        {/* Step 3: Compare and approve */}
        <StepCard
          n={3}
          title="Compare and approve"
          state={stepStates[2]}
          active={activeStep === 2}
          aside={candidates.length > 0 ? <span className="text-xs text-gray-500">{approvedIds.length} approved of {candidates.length}</span> : undefined}
        >
          <CardContent className="space-y-3">
            <label className="block space-y-1 max-w-md">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Default approval reason</span>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Decision reason" />
            </label>
            <div className="space-y-2">
              {candidates.map((candidate) => {
                const busyFor = (action: string) => decisionBusy === `${candidate.id}:${action}`;
                return (
                  <div key={candidate.id} className="rounded-md border border-border-default bg-surface p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-900">{candidate.proposedName}</span>
                      <Badge variant={candidate.status === 'approved' ? 'success' : candidate.status === 'rejected' ? 'danger' : 'default'}>
                        {candidate.status}
                      </Badge>
                      <Badge>{candidate.registryDecision ?? 'add'}</Badge>
                      <span className="text-xs text-gray-500 font-mono">{candidate.comparedModuleId ?? 'new registry module'}</span>
                    </div>
                    {candidate.description && <p className="text-sm text-gray-600 m-0">{candidate.description}</p>}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span>Agent language hint</span>
                      <Badge>{targetLanguageLabel(candidate.targetLanguage)}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <Button size="sm" variant="success" disabled={candidate.registryDecision === 'drop' || Boolean(decisionBusy)} onClick={() => decide(candidate, 'approve')}>
                        {busyFor('approve') ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Approve
                      </Button>
                      <Button size="sm" variant="danger" disabled={Boolean(decisionBusy)} onClick={() => decide(candidate, 'reject')}>
                        {busyFor('reject') ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />} Drop
                      </Button>
                      <Button size="sm" disabled={Boolean(decisionBusy)} onClick={() => decide(candidate, 'defer')}>Defer</Button>
                      <Button size="sm" disabled={Boolean(decisionBusy)} onClick={() => decide(candidate, 'rescan')}>Rescan</Button>
                    </div>
                  </div>
                );
              })}
              {candidates.length === 0 && <EmptyState>No candidates to review yet. Start a candidate scan in step 2.</EmptyState>}
            </div>
          </CardContent>
        </StepCard>

        {/* Step 4: Extraction */}
        <StepCard n={4} title="Extraction" state={stepStates[3]} active={activeStep === 3}>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={approvedIds.length === 0} onClick={openExtractionConfig}>
                <Settings2 size={14} />
                Configure extraction job
              </Button>
              <Button variant="primary" disabled={!planId} onClick={() => api.post(`/api/extraction-plans/${planId}/jobs`, {}).then(() => { setMessage('Extraction job started. Track progress under Agent Jobs.'); }).catch((e) => onError(e.message))}>Run extraction job</Button>
              {planId && (
                <Button variant="ghost" size="sm" onClick={() => onNavigate('jobs')}>
                  <PlaySquare size={13} /> View Agent Jobs
                </Button>
              )}
            </div>
            {approvedIds.length > 0 && !planId && <Notice variant="muted">Configure the extraction job to set output language and candidate-specific settings before creating a plan.</Notice>}
            {approvedIds.length === 0 && <Notice variant="muted">Extraction is blocked until at least one candidate is approved.</Notice>}
            {planId && (
              <CopyablePath label="Plan" value={planId} />
            )}
          </CardContent>
        </StepCard>
      </div>
      <ExtractionJobConfigModal
        open={configOpen}
        candidates={approvedCandidates}
        defaultTargetLanguage={defaultTargetLanguage}
        candidateTargetLanguages={candidateTargetLanguages}
        onDefaultTargetLanguageChange={applyDefaultTargetLanguage}
        onCandidateTargetLanguageChange={setCandidateTargetLanguage}
        onClose={() => setConfigOpen(false)}
        onSubmit={() => configureAndCreatePlan().catch((e) => onError(e.message))}
      />
    </section>
  );
}

function ExtractionJobConfigModal({
  open,
  candidates,
  defaultTargetLanguage,
  candidateTargetLanguages,
  onDefaultTargetLanguageChange,
  onCandidateTargetLanguageChange,
  onClose,
  onSubmit
}: {
  open: boolean;
  candidates: Candidate[];
  defaultTargetLanguage: string;
  candidateTargetLanguages: Record<string, string>;
  onDefaultTargetLanguageChange: (value: string) => void;
  onCandidateTargetLanguageChange: (candidateId: string, value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="extraction-config-title">
      <header className="flex items-center gap-3 border-b border-border-default px-4 py-3">
        <Settings2 size={16} className="text-accent-fg" />
        <div>
          <h3 id="extraction-config-title" className="m-0 text-base font-semibold text-gray-900">Configure extraction job</h3>
          <p className="m-0 text-xs text-gray-500">Set the reusable module output language before creating the extraction plan.</p>
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close extraction job configuration">
          <X size={14} />
        </Button>
      </header>
      <div className="space-y-4 px-4 py-4">
        <div className="rounded-md border border-border-default bg-surface-secondary p-3">
          <label className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-gray-700">Default output language</span>
            <Select value={defaultTargetLanguage} onChange={(e) => onDefaultTargetLanguageChange(e.target.value)} aria-label="Default output language">
              {targetLanguageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </label>
        </div>
        <div className="space-y-2">
          {candidates.map((candidate) => (
            <article key={candidate.id} className="rounded-md border border-border-default bg-surface p-3">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-[220px] flex-1">
                  <div className="font-medium text-gray-900">{candidate.proposedName}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <span>Agent language hint</span>
                    <Badge>{targetLanguageLabel(candidate.targetLanguage)}</Badge>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-gray-600">Output</span>
                  <Select
                    value={candidateTargetLanguages[candidate.id] ?? defaultTargetLanguage}
                    onChange={(e) => onCandidateTargetLanguageChange(candidate.id, e.target.value)}
                    aria-label={`${candidate.proposedName} output language`}
                  >
                    {targetLanguageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </label>
              </div>
            </article>
          ))}
        </div>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border-default px-4 py-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={onSubmit}>Save configuration and create plan</Button>
      </footer>
    </Dialog>
  );
}

function SpecEnrichmentWizard({ onError }: { onError: (value: string) => void }) {
  const [specPath, setSpecPath] = useState('');
  const [enrichment, setEnrichment] = useState<SpecEnrichment | null>(null);
  const create = () => api.post<SpecEnrichment>('/api/spec-enrichments', { specPath }).then(setEnrichment).catch((e) => onError(e.message));
  const refresh = () => enrichment && api.get<SpecEnrichment>(`/api/spec-enrichments/${enrichment.id}`).then(setEnrichment).catch((e) => onError(e.message));
  const start = () => enrichment && api.post<AgentJob>(`/api/spec-enrichments/${enrichment.id}/jobs`, {}).then(() => refresh()).catch((e) => onError(e.message));
  const statusVariant = enrichment?.status === 'succeeded' ? 'success' : enrichment?.status === 'failed' ? 'danger' : enrichment?.status === 'running' || enrichment?.status === 'queued' ? 'accent' : 'default';
  return (
    <section className="max-w-3xl space-y-4">
      <PageHeader title="Spec Enrichment" />
      <Card>
        <CardHeader>
          <CardTitle>Spec file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="flex-1 min-w-[200px]" value={specPath} onChange={(e) => setSpecPath(e.target.value)} placeholder="/absolute/path/to/spec.md" aria-label="Spec file path" />
            <Button variant={specPath.trim() && !enrichment ? 'primary' : 'default'} disabled={!specPath.trim()} onClick={create}>Create enrichment</Button>
            <Button disabled={!enrichment} onClick={start}>Select registry references</Button>
            <Button variant="ghost" size="icon" disabled={!enrichment} aria-label="Refresh enrichment" onClick={() => void refresh()}>
              <RefreshCw size={14} />
            </Button>
          </div>
          {!enrichment && (
            <EmptyState>Point at an absolute spec path and create an enrichment. The enriched spec and registry references appear here once the job runs.</EmptyState>
          )}
        </CardContent>
      </Card>
      {enrichment && (
        <Card className="animate-in">
          <CardHeader>
            <CardTitle>Enrichment</CardTitle>
            <Badge variant={statusVariant}>{enrichment.status}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Spec path"><code className="text-xs font-mono break-all">{enrichment.specPath}</code></Field>
              <Field label="Output path">{enrichment.outputPath ? <CopyablePath value={enrichment.outputPath} /> : <span className="text-sm text-gray-400">Available after the job succeeds</span>}</Field>
              {enrichment.registryReferencesPath && (
                <Field label="Registry references"><CopyablePath value={enrichment.registryReferencesPath} /></Field>
              )}
              <Field label="Artifact root"><code className="text-xs font-mono break-all">{enrichment.artifactRoot}</code></Field>
            </div>
            {enrichment.status === 'succeeded'
              ? <Notice>Enriched spec is ready at the output path above. Feed it into composition or your downstream build.</Notice>
              : enrichment.status === 'failed'
                ? <Notice variant="muted">The enrichment job failed. Check Agent Jobs for the transcript, then recreate the enrichment.</Notice>
                : <Notice variant="muted">Run “Select registry references” to enrich this spec against the module registry.</Notice>}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function CompositionWizard({ onError, onNavigate }: { onError: (value: string) => void; onNavigate: Navigate }) {
  const [modules, setModules] = useState<ModuleRecord[]>([]);
  const [intent, setIntent] = useState('');
  const [composition, setComposition] = useState<Composition | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [inspected, setInspected] = useState<ModuleRecord | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<ModuleNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const nodeTypes = useMemo(() => ({ moduleNode: ModuleNode }), []);
  useEffect(() => { api.list<ModuleRecord>('/api/workbench/palette').then((r) => setModules(r.items)).catch((e) => onError(e.message)); }, []);
  const selectedModuleIds = useMemo(() => unique(nodes.map((node) => node.data.module.id)), [nodes]);
  const addModule = (module: ModuleRecord) => {
    setInspected(module);
    setNodes((current) => [
      ...current,
      {
        id: `${module.id}-${current.length + 1}`,
        type: 'moduleNode',
        position: { x: 80 + (current.length % 4) * 260, y: 80 + Math.floor(current.length / 4) * 170 },
        data: { label: `${module.name}@${module.version}`, module }
      }
    ]);
  };
  const onConnect = async (connection: Connection) => {
    const source = nodes.find((node) => node.id === connection.source)?.data.module;
    const target = nodes.find((node) => node.id === connection.target)?.data.module;
    const sourcePort = findPort(source, 'outputs', connection.sourceHandle);
    const targetPort = findPort(target, 'inputs', connection.targetHandle);
    if (!source || !target || !sourcePort || !targetPort) {
      onError('Incompatible ports cannot be connected.');
      return;
    }
    await api.post('/api/workbench/validate-edge', { sourceModuleId: source.id, sourcePort: sourcePort.name, targetModuleId: target.id, targetPort: targetPort.name });
    setEdges((current) => addEdge({ ...connection, data: { sourcePort: sourcePort.name, targetPort: targetPort.name } }, current));
  };
  const flowLayout = () => ({
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: { moduleId: node.data.module.id, label: node.data.label }
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
      data: edge.data
    }))
  });
  const create = async () => {
    const saved = await api.post<Composition>('/api/compositions', { intent, selectedModuleIds: selectedModuleIds, flowLayout: flowLayout() });
    setComposition(saved);
  };
  const saveLayout = async () => {
    if (!composition) return;
    const saved = await api.patch<Composition>(`/api/compositions/${composition.id}/layout`, { flowLayout: flowLayout() });
    setComposition(saved);
  };
  const refresh = () => composition && api.get<Composition>(`/api/compositions/${composition.id}`).then(setComposition).catch((e) => onError(e.message));
  const questions = Array.isArray(composition?.questionsJson) ? composition.questionsJson : [];
  const allAnswered = questions.length > 0 && questions.every((q) => q.id && answers[q.id]);
  const compiled = Boolean(composition?.blueprintPath || composition?.specPath);

  const stepStates: StepState[] = [
    nodes.length > 0 ? 'done' : 'active',
    !composition ? (selectedModuleIds.length > 0 && intent ? 'active' : 'blocked') : 'done',
    questions.length === 0 ? 'blocked' : allAnswered ? 'done' : 'active',
    compiled ? 'done' : composition?.status === 'ready_to_compile' ? 'active' : 'blocked'
  ];
  const activeStep = stepStates.findIndex((s) => s === 'active');
  const nextAction = compiled
    ? 'Composition compiled. Open the blueprint in Workbench or hand the spec to your build.'
    : !composition
      ? nodes.length === 0
        ? 'Add modules from the palette to the canvas.'
        : !intent
          ? 'Describe the composition intent, then create the composition.'
          : 'Create the composition to lock in the selected modules.'
      : composition.status === 'ready_to_compile'
        ? 'All questions answered. Compile the blueprint and spec.'
        : questions.length === 0
          ? 'Ask clarifying questions to refine the composition.'
          : 'Answer the clarifying questions, then save answers.';

  return (
    <section className="space-y-4">
      <PageHeader title="Freeform Composition" />
      <NextActionBar text={nextAction} />
      <div className="space-y-4">
        {/* Canvas */}
        <StepCard n={1} title="Compose system" state={stepStates[0]} active={activeStep === 0}>
          <CardContent className="p-0">
            <div className="grid grid-cols-[200px_1fr_240px] h-[min(580px,calc(100vh-240px))] min-h-[420px]">
              {/* Palette */}
              <div className="border-r border-border-subtle p-3 overflow-auto space-y-1">
                {modules.map((module) => (
                  <button
                    key={module.id}
                    className="flex items-center gap-2 w-full px-2.5 py-2 rounded-md text-left text-sm border-none bg-transparent hover:bg-surface-secondary transition-colors cursor-pointer"
                    onClick={() => addModule(module)}
                  >
                    <Plus size={12} className="text-gray-400 shrink-0" />
                    <span className="font-medium text-gray-900 truncate">{module.name}</span>
                    <span className="text-xs text-gray-400 ml-auto">{module.version}</span>
                  </button>
                ))}
                {modules.length === 0 && <EmptyState>No modules available. Approve and extract candidates first.</EmptyState>}
              </div>
              {/* Canvas */}
              <div className="relative" aria-label="Composition canvas">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={(connection) => onConnect(connection).catch((e) => onError(e.message))}
                  onNodeClick={(_, node) => setInspected(node.data.module)}
                  fitView
                >
                  <Background />
                  <Controls />
                </ReactFlow>
              </div>
              {/* Inspector */}
              <div className="border-l border-border-subtle p-3 overflow-auto">
                {inspected ? (
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold text-gray-900 m-0">{inspected.name}</h4>
                    <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap overflow-wrap-anywhere bg-surface-secondary rounded p-2 m-0">
                      {JSON.stringify(inspected.portsJson, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 m-0">Select a module to inspect</p>
                )}
              </div>
            </div>
          </CardContent>
        </StepCard>

        {/* Intent */}
        <StepCard n={2} title="Clarify intent" state={stepStates[1]} active={activeStep === 1}>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input className="flex-1 min-w-[200px]" value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Composition intent" aria-label="Composition intent" />
              <Button disabled={selectedModuleIds.length === 0 || !intent} onClick={() => create().catch((e) => onError(e.message))}>Create composition</Button>
              <Button disabled={!composition} onClick={() => saveLayout().catch((e) => onError(e.message))}>Save layout</Button>
              <Button variant="primary" disabled={!composition} onClick={() => composition && api.post(`/api/compositions/${composition.id}/clarification-jobs`, {}).then(refresh).catch((e) => onError(e.message))}>
                Ask clarifying questions
              </Button>
              <Button variant="ghost" size="icon" disabled={!composition} aria-label="Refresh composition" onClick={() => void refresh()}>
                <RefreshCw size={14} />
              </Button>
            </div>
            {composition && <Badge variant={composition.status === 'ready_to_compile' ? 'success' : composition.status === 'failed' ? 'danger' : 'default'}>{composition.status}</Badge>}
          </CardContent>
        </StepCard>

        {/* Answers */}
        <StepCard n={3} title="Answers" state={stepStates[2]} active={activeStep === 2}>
          <CardContent className="space-y-3">
            {questions.length === 0 && <EmptyState>Questions appear after the clarification job succeeds.</EmptyState>}
            {questions.map((question) => (
              <label key={question.id} className="block space-y-1">
                <span className="text-sm font-medium text-gray-700">{question.question}</span>
                <Input
                  value={answers[question.id ?? ''] ?? ''}
                  onChange={(e) => question.id && setAnswers((current) => ({ ...current, [question.id as string]: e.target.value }))}
                  className="max-w-lg"
                />
              </label>
            ))}
            {questions.length > 0 && (
              <Button disabled={!composition || !allAnswered} onClick={() => composition && api.post<Composition>(`/api/compositions/${composition.id}/answers`, { answers }).then(setComposition).catch((e) => onError(e.message))}>
                Save answers
              </Button>
            )}
          </CardContent>
        </StepCard>

        {/* Compile */}
        <StepCard n={4} title="Compile" state={stepStates[3]} active={activeStep === 3}>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={!composition || composition.status !== 'ready_to_compile'} onClick={() => composition && api.post(`/api/compositions/${composition.id}/compile-jobs`, {}).then(refresh).catch((e) => onError(e.message))}>
                Compile blueprint and spec
              </Button>
              {compiled && (
                <Button onClick={() => onNavigate('workbench')}>
                  <LayoutDashboard size={14} /> Open in Workbench
                </Button>
              )}
            </div>
            {composition?.blueprintPath && <CopyablePath label="Blueprint" value={composition.blueprintPath} />}
            {composition?.specPath && <CopyablePath label="Spec" value={composition.specPath} />}
            {compiled && <Notice>Blueprint and spec compiled. Open the wiring canvas in Workbench to generate code, or hand the spec to your build pipeline.</Notice>}
          </CardContent>
        </StepCard>
      </div>
    </section>
  );
}

function Modules({ onError, onNavigate }: { onError: (value: string) => void; onNavigate: Navigate }) {
  const [items, setItems] = useState<ModuleRecord[]>([]);
  useEffect(() => { api.list<ModuleRecord>('/api/modules').then((r) => setItems(r.items)).catch((e) => onError(e.message)); }, []);
  return (
    <section className="space-y-4">
      <PageHeader title="Modules" />
      <Card>
        <CardContent className="p-0">
          <DataTable
            rows={items}
            columns={['name', 'version', 'registryDecision', 'supersedesModuleId', 'supersededByModuleId', 'sourceCheckoutPath', 'testStatus', 'availableInWorkbench']}
            empty={(
              <div className="space-y-2">
                <p className="m-0">No modules in the registry yet.</p>
                <Button size="sm" onClick={() => onNavigate('registry')}>
                  <GitBranch size={13} /> Go to Registry &amp; Extraction
                </Button>
              </div>
            )}
          />
        </CardContent>
      </Card>
    </section>
  );
}

function Jobs({ onError }: { onError: (value: string) => void }) {
  const confirm = useConfirm();
  const [items, setItems] = useState<AgentJob[]>([]);
  const [inspected, setInspected] = useState<AgentJob | null>(null);
  const [attachCommand, setAttachCommand] = useState('');
  const [selectedJobId, setSelectedJobId] = useState(() => window.localStorage.getItem('code-workbench:selected-agent-job') ?? '');
  const load = useCallback(() => api.list<AgentJob>('/api/agent-jobs').then((r) => setItems(r.items)).catch((e) => onError(e.message)), [onError]);
  const clearSelectedJob = useCallback(() => {
    setInspected(null);
    setAttachCommand('');
    setSelectedJobId('');
    window.localStorage.removeItem('code-workbench:selected-agent-job');
  }, []);
  const inspectById = useCallback((id: string) => api.get<AgentJob>(`/api/agent-jobs/${id}`).then((job) => {
    setInspected(job);
    setSelectedJobId(job.id);
    window.localStorage.setItem('code-workbench:selected-agent-job', job.id);
    if (job.attachCommand) {
      setAttachCommand(job.attachCommand);
    }
  }).catch((e) => {
    if (e instanceof APIRequestError && e.code === 'resource.not_found') {
      clearSelectedJob();
      return;
    }
    onError(e.message);
  }), [clearSelectedJob, onError]);
  const inspect = (job: AgentJob) => inspectById(job.id);
  const openJob = (job: AgentJob) => api.post<{ attachCommand: string }>(`/api/agent-jobs/${job.id}/open`).then((opened) => {
    setAttachCommand(opened.attachCommand);
    return api.get<AgentJob>(`/api/agent-jobs/${job.id}`).then((detail) => setInspected({ ...detail, ...opened }));
  }).catch((e) => onError(e.message));
  const cancelJob = async (job: AgentJob) => {
    const decision = await confirm({
      title: `Cancel ${job.role} job?`,
      body: 'This stops the running agent job. Completed work is kept but the job will not finish.',
      variant: 'danger',
      confirmLabel: 'Cancel job',
      cancelLabel: 'Keep running'
    });
    if (!decision.confirmed) return;
    await api.post(`/api/agent-jobs/${job.id}/cancel`).then(load).catch((e) => onError(e.message));
  };
  useEffect(() => {
    void load();
    if (selectedJobId) {
      void inspectById(selectedJobId);
    }
  }, [inspectById, load, selectedJobId]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void load();
      if (selectedJobId) {
        void inspectById(selectedJobId);
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [inspectById, load, selectedJobId]);
  return (
    <section className="space-y-4">
      <PageHeader title="Agent Jobs" action={
        <Button variant="ghost" size="icon" onClick={() => void load()} aria-label="Refresh jobs">
          <RefreshCw size={14} />
        </Button>
      } />

      {attachCommand && <CommandBlock value={attachCommand} />}

      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border-subtle">
            {items.map((j) => {
              const selected = inspected?.id === j.id;
              return (
                <div
                  key={j.id}
                  className={cn(
                    'flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm transition-colors duration-100',
                    selected ? 'bg-accent-subtle/50' : 'hover:bg-surface-secondary'
                  )}
                >
                  <span className="font-medium text-gray-900">{j.role}</span>
                  <Badge variant={j.status === 'succeeded' ? 'success' : j.status === 'failed' ? 'danger' : j.status === 'running' ? 'accent' : 'default'}>
                    {j.status}
                  </Badge>
                  <span className="text-xs text-gray-500">{j.provider}</span>
                  <span className="flex items-center gap-1 text-xs text-gray-400" title={j.createdAt}>
                    <Clock size={11} />{relativeTime(j.finishedAt || j.startedAt || j.createdAt)}
                  </span>
                  <span className="text-xs text-gray-400 font-mono truncate max-w-[180px]">{j.id}</span>
                  <div className="flex-1" />
                  <div className="flex gap-1">
                    <Button size="sm" onClick={() => inspect(j)}>Inspect</Button>
                    <Button size="sm" onClick={() => openJob(j)}>Open</Button>
                    <Button size="sm" variant="danger" disabled={j.status !== 'running' && j.status !== 'queued'} onClick={() => void cancelJob(j)}>
                      <Ban size={12} /> Cancel
                    </Button>
                  </div>
                </div>
              );
            })}
            {items.length === 0 && <EmptyState>No agent jobs yet. Start a candidate scan or extraction to create one.</EmptyState>}
          </div>
        </CardContent>
      </Card>

      {inspected && <JobInspector job={inspected} />}
    </section>
  );
}

function JobInspector({ job }: { job: AgentJob }) {
  const events = [...(job.transcript?.events ?? []), ...(job.activityLog?.events ?? [])];
  const files = job.outputFiles ?? [];
  const hasFailureDetail = job.errorCode || job.exitCode !== undefined;
  const attachCommand = tmuxAttachCommand(job);
  const running = job.status === 'running';
  return (
    <Card className="animate-in">
      <CardHeader>
        <CardTitle>{job.role}</CardTitle>
        <Badge variant={job.status === 'succeeded' ? 'success' : job.status === 'failed' ? 'danger' : job.status === 'running' ? 'accent' : 'default'}>
          {job.status}
        </Badge>
        <span className="flex items-center gap-1 text-xs text-gray-400" title={job.createdAt}>
          <Clock size={11} />{relativeTime(job.finishedAt || job.startedAt || job.createdAt)}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        {(attachCommand || job.tmuxSessionName) && (
          <div className="bg-surface-secondary border border-border-subtle rounded-md p-3 space-y-2">
            <SectionLabel>{running ? 'Live session' : 'tmux session'}</SectionLabel>
            {job.tmuxSessionName && <div className="text-xs font-mono text-gray-600">{job.tmuxSessionName}</div>}
            {attachCommand && <CommandBlock value={attachCommand} />}
          </div>
        )}

        {hasFailureDetail && (
          <div className="flex flex-wrap gap-2">
            {job.errorCode && (
              <div className="flex items-center gap-2 bg-danger-subtle border border-danger-muted rounded-md px-3 py-1.5 text-xs">
                <span className="font-semibold text-danger-fg">errorCode</span>
                <span className="font-mono">{job.errorCode}</span>
              </div>
            )}
            {job.exitCode !== undefined && (
              <div className="flex items-center gap-2 bg-attention-subtle border border-attention-muted rounded-md px-3 py-1.5 text-xs">
                <span className="font-semibold text-attention-fg">exitCode</span>
                <span className="font-mono">{job.exitCode}</span>
              </div>
            )}
          </div>
        )}

        {/* Metrics */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
          {Object.entries(job.metrics ?? {}).map(([key, value]) => (
            <div key={key} className="bg-surface-secondary border border-border-subtle rounded-md px-3 py-2">
              <div className="text-xs font-medium text-gray-500">{key}</div>
              <div className="text-sm font-mono text-gray-900">{value}</div>
            </div>
          ))}
          {Object.keys(job.metrics ?? {}).length === 0 && (
            <div className="bg-surface-secondary border border-border-subtle rounded-md px-3 py-2">
              <div className="text-xs text-gray-400">No metrics yet</div>
            </div>
          )}
        </div>

        {/* Logs */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <LogViewer title="Prompt" path={job.prompt?.path ?? job.promptPath} content={job.prompt?.content ?? ''} truncated={job.prompt?.truncated} />
          <LogViewer title="Transcript" path={job.transcript?.path ?? job.transcriptPath} content={job.transcript?.content ?? ''} truncated={job.transcript?.truncated} autoScroll={running} />
          {job.activityLog && <LogViewer title="Live activity" path={job.activityLog.path} content={job.activityLog.content} truncated={job.activityLog.truncated} autoScroll={running} />}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <SectionLabel>Detected messages and prompts</SectionLabel>
            <div className="space-y-1.5 max-h-[320px] overflow-auto">
              {events.map((event, index) => (
                <div key={`${event.kind}-${event.line}-${index}`} className="bg-surface-secondary border border-border-subtle rounded px-2.5 py-1.5 text-xs">
                  <span className="font-semibold text-gray-700">{event.kind}</span>
                  <span className="text-gray-400 mx-1.5">line {event.line}</span>
                  <span className="text-gray-600 whitespace-pre-wrap break-words">{unescapeLog(event.text)}</span>
                </div>
              ))}
              {events.length === 0 && <EmptyState>No markers detected yet.</EmptyState>}
            </div>
          </div>
          <div>
            <SectionLabel>Output files</SectionLabel>
            <div className="space-y-1.5">
              {files.map((file) => (
                <div key={file.path} className="bg-surface-secondary border border-border-subtle rounded px-2.5 py-1.5 text-xs">
                  <span className="font-mono text-gray-700">{file.path}</span>
                  <span className="text-gray-400 ml-2">{file.size} bytes</span>
                </div>
              ))}
              {files.length === 0 && <EmptyState>No output files yet.</EmptyState>}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Shared UI components ---

function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <header className="flex items-center justify-between pb-1">
      <h2 className="text-lg font-semibold text-gray-900 m-0">{title}</h2>
      {action}
    </header>
  );
}

function NextActionBar({ text }: { text: string }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-attention-subtle border border-attention-muted rounded-md px-3 py-2 text-sm shadow-sm" aria-live="polite">
      <ChevronRight size={14} className="text-attention-fg shrink-0" />
      <span className="text-attention-fg font-medium">{text}</span>
    </div>
  );
}

function stepStateClasses(state: StepState) {
  if (state === 'done') return 'bg-success-emphasis text-white';
  if (state === 'active') return 'bg-gray-900 text-white ring-2 ring-accent-fg/40';
  if (state === 'blocked') return 'bg-surface-tertiary text-gray-400';
  return 'bg-gray-900 text-white';
}

function StepNumber({ n, state }: { n: number; state: StepState }) {
  return (
    <span className={cn('inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-semibold shrink-0', stepStateClasses(state))}>
      {state === 'done' ? <Check size={12} /> : n}
    </span>
  );
}

function StepCard({ n, title, state, active, aside, children }: { n: number; title: string; state: StepState; active?: boolean; aside?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active && ref.current && typeof ref.current.scrollIntoView === 'function') {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [active]);
  return (
    <div ref={ref}>
      <Card className={cn('transition-opacity duration-150', state === 'blocked' && 'opacity-60', active && 'ring-1 ring-accent-fg/30')}>
        <CardHeader>
          <StepNumber n={n} state={state} />
          <CardTitle>{title}</CardTitle>
          {(aside || state === 'blocked') && <div className="flex-1" />}
          {aside}
          {state === 'blocked' && !aside && <span className="text-xs text-gray-400">Locked</span>}
        </CardHeader>
        {children}
      </Card>
    </div>
  );
}

function Notice({ children, variant = 'default' }: { children: ReactNode; variant?: 'default' | 'muted' }) {
  return (
    <div className={cn(
      'rounded-md px-3 py-2 text-sm',
      variant === 'muted'
        ? 'bg-surface-secondary border border-border-subtle text-gray-500'
        : 'bg-success-subtle border border-success-muted text-success-fg'
    )}>
      {children}
    </div>
  );
}

function LiveRegion({ children }: { children: ReactNode }) {
  return <div aria-live="polite" className="space-y-3 empty:hidden">{children}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <SectionLabel className="mb-0">{label}</SectionLabel>
      <div>{children}</div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="text-sm text-gray-400 py-3 text-center">{children}</div>;
}

function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <h4 className={cn('text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 m-0', className)}>{children}</h4>;
}

function CommandBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(value).then(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }).catch(() => setCopied(false));
  return (
    <div className="flex items-center gap-2 bg-gray-950 rounded-md px-3 py-2">
      <code className="flex-1 text-xs font-mono text-gray-100 overflow-wrap-anywhere leading-relaxed">{value}</code>
      <button
        type="button"
        className="p-1.5 rounded hover:bg-gray-800 transition-colors border-none cursor-pointer text-gray-400 hover:text-gray-200"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy command'}
        title={copied ? 'Copied' : 'Copy command'}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function CopyablePath({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(value).then(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }).catch(() => setCopied(false));
  return (
    <div className="flex items-center gap-2 bg-surface-secondary rounded px-2 py-1.5 text-xs font-mono text-gray-600">
      {label && <span className="font-sans font-semibold text-gray-500 not-italic shrink-0">{label}</span>}
      <span className="flex-1 break-all">{value}</span>
      <button
        type="button"
        className="p-1 rounded hover:bg-surface-tertiary transition-colors border-none cursor-pointer text-gray-500"
        onClick={copy}
        aria-label={copied ? 'Copied' : `Copy ${label ?? 'path'}`}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function LogViewer({ title, path, content, truncated, autoScroll }: { title: string; path?: string; content: string; truncated?: boolean; autoScroll?: boolean }) {
  const text = unescapeLog(content);
  const [open, setOpen] = useState(text.length <= 4000);
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const lineCount = text ? text.split('\n').length : 0;
  useEffect(() => {
    if (autoScroll && open && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [text, autoScroll, open]);
  const copy = () => navigator.clipboard.writeText(text).then(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }).catch(() => setCopied(false));
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wider border-none bg-transparent cursor-pointer p-0"
        >
          <ChevronDown size={12} className={cn('transition-transform', !open && '-rotate-90')} />
          {title}
        </button>
        <span className="text-[11px] text-gray-400">{lineCount} lines{truncated ? ' · tail' : ''}</span>
        <div className="flex-1" />
        {text && (
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? 'Copied' : `Copy ${title.toLowerCase()}`}
            title={copied ? 'Copied' : 'Copy'}
            className="p-1 rounded hover:bg-surface-secondary transition-colors border-none bg-transparent cursor-pointer text-gray-500"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
      </div>
      {path && <div className="text-xs font-mono text-gray-400 mb-1.5 truncate">{path}{truncated ? ' (tail shown)' : ''}</div>}
      <pre ref={preRef} className={cn('log-block', !open && 'hidden')}>{text || 'No content captured yet.'}</pre>
      {!open && (
        <button type="button" onClick={() => setOpen(true)} className="text-xs text-accent-fg border-none bg-transparent cursor-pointer p-0 hover:underline">
          Show {lineCount} lines
        </button>
      )}
    </div>
  );
}

const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  version: 'Version',
  registryDecision: 'Registry decision',
  supersedesModuleId: 'Supersedes',
  supersededByModuleId: 'Superseded by',
  sourceCheckoutPath: 'Checkout path',
  testStatus: 'Test status',
  availableInWorkbench: 'In workbench',
  status: 'Status',
  specPath: 'Spec path',
  outputPath: 'Output path',
  selectedModulesJson: 'Selected modules',
  role: 'Role',
  provider: 'Provider',
  subjectType: 'Subject',
  subjectId: 'Subject ID',
  tmuxSessionName: 'tmux session',
  createdAt: 'Created',
  finishedAt: 'Finished'
};

function humanizeColumn(key: string) {
  if (COLUMN_LABELS[key]) return COLUMN_LABELS[key];
  const spaced = key
    .replace(/Json$/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const BOOLEAN_COLUMNS = new Set(['availableInWorkbench']);

function DataTable<T extends object>({ rows, columns, empty }: { rows: T[]; columns: string[]; empty?: ReactNode }) {
  return (
    <div className="overflow-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border-subtle bg-surface-secondary">
            {columns.map((c) => (
              <th key={c} className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">{humanizeColumn(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const record = row as Record<string, unknown>;
            return (
              <tr key={String(record.id ?? i)} className="border-b border-border-subtle hover:bg-surface-secondary transition-colors duration-75">
                {columns.map((c) => (
                  <td key={c} className="px-3 py-2 text-gray-700 whitespace-nowrap overflow-hidden text-ellipsis max-w-[240px]">{formatCell(record[c], c)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <EmptyState>{empty ?? 'No data.'}</EmptyState>}
    </div>
  );
}

function ModuleNode({ data }: NodeProps<ModuleNodeData>) {
  const inputs = getPorts(data.module, 'inputs');
  const outputs = getPorts(data.module, 'outputs');
  return (
    <div className="min-w-[200px] bg-surface border border-border-default rounded-lg p-3 shadow-md">
      <strong className="block text-xs font-semibold text-gray-900 mb-2">{data.label}</strong>
      <div className="grid grid-cols-2 gap-3">
        <div>{inputs.map((port, index) => <PortRow key={port.name} port={port} type="target" index={index} total={inputs.length} />)}</div>
        <div>{outputs.map((port, index) => <PortRow key={port.name} port={port} type="source" index={index} total={outputs.length} />)}</div>
      </div>
    </div>
  );
}

function PortRow({ port, type, index, total }: { port: Port; type: 'source' | 'target'; index: number; total: number }) {
  const top = `${((index + 1) / (total + 1)) * 100}%`;
  return (
    <span className={cn('relative grid gap-0.5 min-h-[24px] text-xs text-gray-700', type === 'source' && 'text-right')}>
      <Handle id={port.name} type={type} position={type === 'source' ? Position.Right : Position.Left} style={{ top }} />
      {port.name}
      <em className="not-italic text-gray-400 text-[10px]">{port.type}{port.required ? ' required' : ''}</em>
    </span>
  );
}

// --- Utilities ---

function relativeTime(value?: string) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return value;
  const diff = Date.now() - then;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}

function unescapeLog(value: string) {
  if (!value || (value.indexOf('\\n') === -1 && value.indexOf('\\t') === -1 && value.indexOf('\\r') === -1)) return value;
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t');
}

function tmuxAttachCommand(job: AgentJob) {
  if (job.attachCommand) return job.attachCommand;
  if (!job.tmuxSessionName) return '';
  const socketPath = job.promptPath ? `${job.promptPath.replace(/\/[^/]*$/, '')}/tmux.sock` : '';
  if (!socketPath) return `tmux attach -t ${shellQuote(job.tmuxSessionName)}`;
  return `tmux -S ${shellQuote(socketPath)} attach -t ${shellQuote(job.tmuxSessionName)}`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatCell(value: unknown, column?: string) {
  if (value == null) return '';
  if (column && BOOLEAN_COLUMNS.has(column)) return value ? 'Yes' : 'No';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function findPort(module: ModuleRecord | undefined, direction: 'inputs' | 'outputs', name: string | null | undefined) {
  return getPorts(module, direction).find((port) => port.name === name);
}

function getPorts(module: ModuleRecord | undefined, direction: 'inputs' | 'outputs'): Port[] {
  const raw = module?.portsJson;
  const ports = typeof raw === 'string' ? safeJSON<{ inputs?: Port[]; outputs?: Port[] }>(raw) : raw as { inputs?: Port[]; outputs?: Port[] } | undefined;
  return ports?.[direction] ?? [];
}

function safeJSON<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
