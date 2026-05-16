import ReactFlow, { Background, Controls, Handle, Position, addEdge, useEdgesState, useNodesState, type Connection, type NodeProps } from 'reactflow';
import { Boxes, Check, Copy, FileText, GitBranch, PlaySquare, Plus, RefreshCw, Trash2, WandSparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentJob, Candidate, Composition, ModuleRecord, Repository, Session, SessionCleanupResult, SpecEnrichment } from '../api/generated/types';
import { APIRequestError, api } from '../api/client';

type Screen = 'registry' | 'spec' | 'composition' | 'modules' | 'jobs';
type Port = { name: string; type: string; required?: boolean };
type ModuleNodeData = { label: string; module: ModuleRecord };

const screens: Array<{ id: Screen; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'registry', label: 'Registry & Code Extraction', icon: GitBranch },
  { id: 'spec', label: 'Spec Enrichment', icon: FileText },
  { id: 'composition', label: 'Freeform Composition', icon: WandSparkles },
  { id: 'modules', label: 'Modules', icon: Boxes },
  { id: 'jobs', label: 'Agent Jobs', icon: PlaySquare }
];

const candidateReviewPhases = new Set(['awaiting_approval', 'candidates_ready']);
const analysisRunningPhases = new Set(['queued', 'analysing']);
const hasReviewableCandidates = (item: Session) => candidateReviewPhases.has(item.phase);
const isAnalysisRunning = (item: Session) => analysisRunningPhases.has(item.phase);
const sessionNotice = (item: Session) => hasReviewableCandidates(item)
  ? `${item.repoName} analysis succeeded. Review proposed candidates.`
  : `Extraction session ${item.id} is ${item.phase}.`;
const sessionActionLabel = (item: Session) => hasReviewableCandidates(item) ? 'Review candidates' : 'Continue';

export function App() {
  const [screen, setScreenState] = useState<Screen>(() => {
    const saved = window.localStorage.getItem('code-workbench:screen');
    return screens.some((item) => item.id === saved) ? saved as Screen : 'registry';
  });
  const [error, setError] = useState('');
  const setScreen = (value: Screen) => {
    setScreenState(value);
    window.localStorage.setItem('code-workbench:screen', value);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1>Code Workbench</h1>
        <nav>
          {screens.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={screen === item.id ? 'active' : ''} onClick={() => setScreen(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <main>
        {error && <div className="error">{error}</div>}
        {screen === 'registry' && <RegistryExtractionWizard onError={setError} />}
        {screen === 'spec' && <SpecEnrichmentWizard onError={setError} />}
        {screen === 'composition' && <CompositionWizard onError={setError} />}
        {screen === 'modules' && <Modules onError={setError} />}
        {screen === 'jobs' && <Jobs onError={setError} />}
      </main>
    </div>
  );
}

function RegistryExtractionWizard({ onError }: { onError: (value: string) => void }) {
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
  const approvedIds = useMemo(() => candidates.filter((c) => c.status === 'approved').map((c) => c.id), [candidates]);
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
  };
  const clearPreviousSessions = async () => {
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
  const decide = (candidate: Candidate, action: 'approve' | 'reject' | 'defer' | 'rescan') => {
    void api.post<Candidate>(`/api/candidates/${candidate.id}/${action}`, { reason }).then(() => loadCandidates(candidate.sessionId)).catch((e) => onError(e.message));
  };
  const createPlan = async () => {
    if (!session || approvedIds.length === 0) return;
    const plan = await api.post<{ id: string }>('/api/extraction-plans', { sessionId: session.id, approvedCandidateIds: approvedIds, rejectedCandidateIds: candidates.filter((c) => c.status === 'rejected').map((c) => c.id) });
    setPlanId(plan.id);
  };

  return (
    <section>
      <Header title="Registry & Code Extraction" />
      <div className="wizard-grid">
        <Panel title="1. Source">
          <div className="toolbar">
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value as 'local_path' | 'git_url')}>
              <option value="local_path">Local path</option>
              <option value="git_url">Git URL</option>
            </select>
            <input value={sourceUri} onChange={(e) => setSourceUri(e.target.value)} placeholder="Repository path or URL" />
            <button disabled={Boolean(busyAction)} onClick={() => begin().catch((e) => onError(e.message))}>Import to .sources</button>
            <button disabled={Boolean(busyAction)} className={sourceNeedsRefresh && !intent.trim() ? 'next-action-button' : ''} onClick={() => rescan().catch((e) => onError(e.message))}>{rescanLabel}</button>
            <button onClick={() => { void loadRepositories().then((repoList) => loadSessions(repoList, true)); }} aria-label="Refresh registered sources"><RefreshCw size={16} /></button>
          </div>
          <div className="next-action"><strong>Next action</strong><span>{nextAction}</span></div>
          {busyAction && <div className="notice progress-notice">{busyAction}</div>}
          {message && <div className="notice">{message}</div>}
          {activeSessionNotice && <div className="notice session-notice">{activeSessionNotice}</div>}
          {repo && repo.sourceCheckoutPath && <div className="notice">{repo.name} stored at {repo.sourceCheckoutPath}</div>}
          <div className="source-grid">
            <div>
              <h4>Registered sources</h4>
              <div className="stack">
                {repositories.map((item) => (
                  <article className={repo?.id === item.id ? 'row-card selected' : 'row-card'} key={item.id}>
                    <strong>{item.name}</strong>
                    <span>{item.sourceType}</span>
                    <span>{item.sourceCheckoutPath || item.sourceUri}</span>
                    <button onClick={() => startSession(item, false, false).catch((e) => onError(e.message))}>Use for extraction</button>
                  </article>
                ))}
                {repositories.length === 0 && <div className="notice">No registered sources.</div>}
              </div>
            </div>
            <div>
              <div className="section-heading-row">
                <h4>Recent extraction sessions</h4>
                <button className="inline-icon-button" disabled={sessions.length === 0 || Boolean(busyAction)} onClick={() => clearPreviousSessions().catch((e) => onError(e.message))}>
                  <Trash2 size={15} />
                  <span>Clear previous sessions</span>
                </button>
              </div>
              <div className="stack">
                {sessions.slice(0, 6).map((item) => (
                  <article className={session?.id === item.id || pendingSessionId === item.id ? 'row-card selected' : 'row-card'} key={item.id}>
                    <strong>{item.repoName}</strong>
                    <span>{item.phase}</span>
                    <button className={pendingSessionId === item.id || hasReviewableCandidates(item) ? 'next-action-button' : ''} onClick={() => continueSession(item)}>{sessionActionLabel(item)}</button>
                  </article>
                ))}
                {sessions.length === 0 && <div className="notice">No extraction sessions.</div>}
              </div>
            </div>
          </div>
        </Panel>
        <Panel title="2. Scan candidates">
          <div className="toolbar">
            <input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Reusable functionality to extract" />
            <button className={session && intent.trim() ? 'next-action-button' : ''} disabled={!session} onClick={() => scan().catch((e) => onError(e.message))}>Start candidate scan</button>
            <button disabled={!session} onClick={() => void loadCandidates()}>Refresh candidates</button>
          </div>
          {session && <div className="notice">{session.repoName} {session.phase}</div>}
        </Panel>
        <Panel title="3. Compare and approve">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Decision reason" />
          <div className="stack">
            {candidates.map((candidate) => (
              <article className="row-card" key={candidate.id}>
                <strong>{candidate.proposedName}</strong>
                <span>{candidate.status}</span>
                <span>{candidate.registryDecision ?? 'add'}</span>
                <span>{candidate.comparedModuleId ?? 'new registry module'}</span>
                <p>{candidate.description}</p>
                <button disabled={candidate.registryDecision === 'drop'} onClick={() => decide(candidate, 'approve')}>Approve</button>
                <button onClick={() => decide(candidate, 'reject')}>Drop</button>
                <button onClick={() => decide(candidate, 'defer')}>Keep as variant later</button>
                <button onClick={() => decide(candidate, 'rescan')}>Rescan</button>
              </article>
            ))}
          </div>
        </Panel>
        <Panel title="4. Extraction">
          <div className="toolbar">
            <button disabled={approvedIds.length === 0} onClick={() => createPlan().catch((e) => onError(e.message))}>Create extraction plan</button>
            <button disabled={!planId} onClick={() => api.post(`/api/extraction-plans/${planId}/jobs`, {}).catch((e) => onError(e.message))}>Run extraction job</button>
          </div>
          {approvedIds.length === 0 && <div className="notice">Extraction is blocked until at least one candidate is approved.</div>}
          {planId && <div className="notice">Plan {planId}</div>}
        </Panel>
      </div>
    </section>
  );
}

function SpecEnrichmentWizard({ onError }: { onError: (value: string) => void }) {
  const [specPath, setSpecPath] = useState('');
  const [enrichment, setEnrichment] = useState<SpecEnrichment | null>(null);
  const create = () => api.post<SpecEnrichment>('/api/spec-enrichments', { specPath }).then(setEnrichment).catch((e) => onError(e.message));
  const start = () => enrichment && api.post<AgentJob>(`/api/spec-enrichments/${enrichment.id}/jobs`, {}).then(() => api.get<SpecEnrichment>(`/api/spec-enrichments/${enrichment.id}`).then(setEnrichment)).catch((e) => onError(e.message));
  return (
    <section>
      <Header title="Spec Enrichment" />
      <Panel title="Spec file">
        <div className="toolbar">
          <input value={specPath} onChange={(e) => setSpecPath(e.target.value)} placeholder="/absolute/path/to/spec.md" />
          <button onClick={create}>Create enrichment</button>
          <button disabled={!enrichment} onClick={start}>Select registry references</button>
          <button disabled={!enrichment} onClick={() => enrichment && api.get<SpecEnrichment>(`/api/spec-enrichments/${enrichment.id}`).then(setEnrichment).catch((e) => onError(e.message))}>Refresh</button>
        </div>
        {enrichment && <Table rows={[enrichment]} columns={['status', 'specPath', 'outputPath', 'selectedModulesJson']} />}
      </Panel>
    </section>
  );
}

function CompositionWizard({ onError }: { onError: (value: string) => void }) {
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
  return (
    <section>
      <Header title="Freeform Composition" />
      <div className="wizard-grid">
        <Panel title="1. Compose system">
          <div className="composition-grid">
            <aside className="palette compact">
              {modules.map((module) => (
                <button key={module.id} onClick={() => addModule(module)}>
                  <Plus size={16} />
                  <strong>{module.name}</strong>
                  <span>{module.version}</span>
                </button>
              ))}
              {modules.length === 0 && <div className="notice">No workbench modules are available.</div>}
            </aside>
            <div className="canvas composition-canvas" aria-label="Composition canvas">
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
            <aside className="inspector">
              {inspected ? (
                <>
                  <h3>{inspected.name}</h3>
                  <pre>{JSON.stringify(inspected.portsJson, null, 2)}</pre>
                </>
              ) : (
                <span>Select a module</span>
              )}
            </aside>
          </div>
        </Panel>
        <Panel title="2. Clarify intent">
          <div className="toolbar">
            <input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Composition intent" />
            <button disabled={selectedModuleIds.length === 0 || !intent} onClick={() => create().catch((e) => onError(e.message))}>Create composition</button>
            <button disabled={!composition} onClick={() => saveLayout().catch((e) => onError(e.message))}>Save layout</button>
            <button disabled={!composition} onClick={() => composition && api.post(`/api/compositions/${composition.id}/clarification-jobs`, {}).then(refresh).catch((e) => onError(e.message))}>Ask clarifying questions</button>
            <button disabled={!composition} onClick={() => void refresh()}>Refresh</button>
          </div>
          {composition && <div className="notice">{composition.status}</div>}
        </Panel>
        <Panel title="3. Answers">
          {questions.length === 0 && <div className="notice">Questions appear after the clarification job succeeds.</div>}
          {questions.map((question) => (
            <label className="answer-row" key={question.id}>
              <span>{question.question}</span>
              <input value={answers[question.id ?? ''] ?? ''} onChange={(e) => question.id && setAnswers((current) => ({ ...current, [question.id as string]: e.target.value }))} />
            </label>
          ))}
          <button disabled={!composition || !allAnswered} onClick={() => composition && api.post<Composition>(`/api/compositions/${composition.id}/answers`, { answers }).then(setComposition).catch((e) => onError(e.message))}>Save answers</button>
        </Panel>
        <Panel title="4. Compile">
          <button disabled={!composition || composition.status !== 'ready_to_compile'} onClick={() => composition && api.post(`/api/compositions/${composition.id}/compile-jobs`, {}).then(refresh).catch((e) => onError(e.message))}>Compile blueprint and spec</button>
          {composition?.blueprintPath && <div className="notice">{composition.blueprintPath}</div>}
          {composition?.specPath && <div className="notice">{composition.specPath}</div>}
        </Panel>
      </div>
    </section>
  );
}

function Modules({ onError }: { onError: (value: string) => void }) {
  const [items, setItems] = useState<ModuleRecord[]>([]);
  useEffect(() => { api.list<ModuleRecord>('/api/modules').then((r) => setItems(r.items)).catch((e) => onError(e.message)); }, []);
  return <section><Header title="Modules" /><Table rows={items} columns={['name', 'version', 'registryDecision', 'supersedesModuleId', 'supersededByModuleId', 'sourceCheckoutPath', 'testStatus', 'availableInWorkbench']} /></section>;
}

function Jobs({ onError }: { onError: (value: string) => void }) {
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
    <section>
      <Header title="Agent Jobs" />
      <div className="toolbar">
        <button onClick={() => void load()} aria-label="Refresh jobs"><RefreshCw size={16} /></button>
      </div>
      {attachCommand && <div className="notice">{attachCommand}</div>}
      <Table rows={items} columns={['role', 'provider', 'status', 'subjectType', 'subjectId', 'tmuxSessionName', 'createdAt', 'finishedAt']} />
      <div className="stack job-actions">
        {items.map((j) => (
          <article className={inspected?.id === j.id ? 'row-card selected' : 'row-card'} key={j.id}>
            <strong>{j.role}</strong>
            <span>{j.status}</span>
            <span>{j.id}</span>
            <button onClick={() => inspect(j)}>Inspect</button>
            <button onClick={() => openJob(j)}>Open</button>
            <button onClick={() => api.post(`/api/agent-jobs/${j.id}/cancel`).then(load).catch((e) => onError(e.message))}>Cancel</button>
          </article>
        ))}
      </div>
      {inspected && <JobInspector job={inspected} />}
    </section>
  );
}

function JobInspector({ job }: { job: AgentJob }) {
  const events = [...(job.transcript?.events ?? []), ...(job.activityLog?.events ?? [])];
  const files = job.outputFiles ?? [];
  const hasFailureDetail = job.errorCode || job.exitCode !== undefined;
  const attachCommand = tmuxAttachCommand(job);
  return (
    <section className="panel job-inspector">
      <h3>{job.role} {job.status}</h3>
      {(attachCommand || job.tmuxSessionName) && (
        <section className="job-session-panel">
          <h4>{job.status === 'running' ? 'Live session' : 'tmux session'}</h4>
          {job.tmuxSessionName && <div className="path-line">{job.tmuxSessionName}</div>}
          {attachCommand && <CommandBlock value={attachCommand} />}
        </section>
      )}
      {hasFailureDetail && (
        <div className="job-status-detail">
          {job.errorCode && <span><strong>errorCode</strong>{job.errorCode}</span>}
          {job.exitCode !== undefined && <span><strong>exitCode</strong>{job.exitCode}</span>}
        </div>
      )}
      <div className="metrics-grid">
        {Object.entries(job.metrics ?? {}).map(([key, value]) => <span key={key}><strong>{key}</strong>{value}</span>)}
        {Object.keys(job.metrics ?? {}).length === 0 && <span><strong>metrics</strong>none yet</span>}
      </div>
      <div className="job-detail-grid">
        <LogBlock title="Prompt" path={job.prompt?.path ?? job.promptPath} content={job.prompt?.content ?? ''} truncated={job.prompt?.truncated} />
        <LogBlock title="Transcript" path={job.transcript?.path ?? job.transcriptPath} content={job.transcript?.content ?? ''} truncated={job.transcript?.truncated} />
        {job.activityLog && <LogBlock title="Live activity" path={job.activityLog.path} content={job.activityLog.content} truncated={job.activityLog.truncated} />}
      </div>
      <div className="job-detail-grid">
        <section>
          <h4>Detected messages and prompts</h4>
          <div className="event-list">
            {events.map((event, index) => <span key={`${event.kind}-${event.line}-${index}`}><strong>{event.kind}</strong><em>line {event.line}</em>{event.text}</span>)}
            {events.length === 0 && <span>No prompt, tool, metric, or error markers detected yet.</span>}
          </div>
        </section>
        <section>
          <h4>Output files</h4>
          <div className="event-list">
            {files.map((file) => <span key={file.path}><strong>{file.path}</strong><em>{file.size} bytes</em></span>)}
            {files.length === 0 && <span>No output files yet.</span>}
          </div>
        </section>
      </div>
    </section>
  );
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

function CommandBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(value).then(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }).catch(() => setCopied(false));
  return (
    <div className="command-block">
      <code>{value}</code>
      <button
        type="button"
        className="command-copy-button"
        onClick={copy}
        aria-label={copied ? 'Copied tmux command' : 'Copy tmux command'}
        title={copied ? 'Copied tmux command' : 'Copy tmux command'}
      >
        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}

function LogBlock({ title, path, content, truncated }: { title: string; path?: string; content: string; truncated?: boolean }) {
  return (
    <section>
      <h4>{title}</h4>
      {path && <div className="path-line">{path}{truncated ? ' (tail shown)' : ''}</div>}
      <pre className="log-block">{content || 'No content captured yet.'}</pre>
    </section>
  );
}

function Header({ title }: { title: string }) {
  return <header className="page-header"><h2>{title}</h2></header>;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="panel"><h3>{title}</h3>{children}</section>;
}

function Table<T extends object>({ rows, columns }: { rows: T[]; columns: string[] }) {
  return <div className="table"><div className="table-head">{columns.map((c) => <span key={c}>{c}</span>)}</div>{rows.map((row, i) => {
    const record = row as Record<string, unknown>;
    return <div className="table-row" key={String(record.id ?? i)}>{columns.map((c) => <span key={c}>{formatCell(record[c])}</span>)}</div>;
  })}</div>;
}

function formatCell(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ModuleNode({ data }: NodeProps<ModuleNodeData>) {
  const inputs = getPorts(data.module, 'inputs');
  const outputs = getPorts(data.module, 'outputs');
  return (
    <div className="module-node">
      <strong>{data.label}</strong>
      <div className="module-node-ports">
        <div>{inputs.map((port, index) => <PortRow key={port.name} port={port} type="target" index={index} total={inputs.length} />)}</div>
        <div>{outputs.map((port, index) => <PortRow key={port.name} port={port} type="source" index={index} total={outputs.length} />)}</div>
      </div>
    </div>
  );
}

function PortRow({ port, type, index, total }: { port: Port; type: 'source' | 'target'; index: number; total: number }) {
  const top = `${((index + 1) / (total + 1)) * 100}%`;
  return (
    <span className={`port-row ${type}`}>
      <Handle id={port.name} type={type} position={type === 'source' ? Position.Right : Position.Left} style={{ top }} />
      {port.name}
      <em>{port.type}{port.required ? ' required' : ''}</em>
    </span>
  );
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
