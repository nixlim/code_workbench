import ReactFlow, { Background, Controls, Handle, Position, addEdge, useEdgesState, useNodesState, type Connection, type NodeProps } from 'reactflow';
import { Boxes, FileText, GitBranch, PlaySquare, Plus, RefreshCw, WandSparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { AgentJob, Candidate, Composition, ModuleRecord, Repository, Session, SpecEnrichment } from '../api/generated/types';
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

export function App() {
  const [screen, setScreen] = useState<Screen>('registry');
  const [error, setError] = useState('');
  const [clickFeedback, setClickFeedback] = useState<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!clickFeedback) return;
    const timeout = window.setTimeout(() => setClickFeedback(null), 650);
    return () => window.clearTimeout(timeout);
  }, [clickFeedback]);

  const showButtonClick = (event: MouseEvent<HTMLDivElement>) => {
    const button = (event.target as Element | null)?.closest('button');
    if (!button || button.disabled || !event.currentTarget.contains(button)) return;
    const rect = button.getBoundingClientRect();
    setClickFeedback({
      id: Date.now(),
      x: rect.left + rect.width / 2,
      y: Math.max(12, rect.top - 10)
    });
  };

  return (
    <div className="shell" onClickCapture={showButtonClick}>
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
      {clickFeedback && (
        <div
          key={clickFeedback.id}
          className="click-feedback"
          role="status"
          aria-live="polite"
          style={{ left: clickFeedback.x, top: clickFeedback.y }}
        >
          click
        </div>
      )}
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
  const [intent, setIntent] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [reason, setReason] = useState('approved for extraction');
  const [planId, setPlanId] = useState('');
  const [message, setMessage] = useState('');
  const approvedIds = useMemo(() => candidates.filter((c) => c.status === 'approved').map((c) => c.id), [candidates]);

  const loadRepositories = () => api.list<Repository>('/api/repositories').then((r) => setRepositories(r.items)).catch((e) => onError(e.message));
  const loadSessions = () => api.list<Session>('/api/sessions').then((r) => setSessions(r.items)).catch((e) => onError(e.message));
  useEffect(() => {
    void loadRepositories();
    void loadSessions();
  }, []);

  const loadCandidates = (sessionId = session?.id) => {
    if (!sessionId) return Promise.resolve();
    return api.list<Candidate>(`/api/candidates?sessionId=${encodeURIComponent(sessionId)}`).then((r) => setCandidates(r.items)).catch((e) => onError(e.message));
  };
  const startSession = async (target: Repository) => {
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
    }
    setRepo(usable);
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
    setSession(created);
    setCandidates([]);
    setPlanId('');
    setMessage(`${usable.name} is ready for candidate scanning.`);
    await loadSessions();
  };
  const begin = async () => {
    try {
      const saved = await api.post<Repository>('/api/repositories', { sourceType, sourceUri });
      await loadRepositories();
      await startSession(saved);
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
    }
  };
  const rescan = async () => {
    const saved = await api.post<Repository>('/api/repositories', { sourceType, sourceUri, rescan: true });
    await loadRepositories();
    await startSession(saved);
    setMessage(`${saved.name} was rescanned into .sources.`);
  };
  const scan = async () => {
    if (!session) return;
    const updated = await api.post<Session>(`/api/sessions/${session.id}/intent`, { specificFunctionality: intent, allowAgentDiscovery: true, expectedUpdatedAt: session.updatedAt });
    setSession(updated);
    await api.post<AgentJob>(`/api/sessions/${session.id}/analysis-jobs`, {});
    await loadSessions();
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
            <button onClick={() => begin().catch((e) => onError(e.message))}>Import to .sources</button>
            <button onClick={() => rescan().catch((e) => onError(e.message))}>Rescan source</button>
            <button onClick={() => { void loadRepositories(); void loadSessions(); }} aria-label="Refresh registered sources"><RefreshCw size={16} /></button>
          </div>
          {message && <div className="notice">{message}</div>}
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
                    <button onClick={() => startSession(item).catch((e) => onError(e.message))}>Use for extraction</button>
                  </article>
                ))}
                {repositories.length === 0 && <div className="notice">No registered sources.</div>}
              </div>
            </div>
            <div>
              <h4>Recent extraction sessions</h4>
              <div className="stack">
                {sessions.slice(0, 6).map((item) => (
                  <article className={session?.id === item.id ? 'row-card selected' : 'row-card'} key={item.id}>
                    <strong>{item.repoName}</strong>
                    <span>{item.phase}</span>
                    <button onClick={() => { setSession(item); setRepo(repositories.find((r) => r.id === item.repositoryId) ?? repo); void loadCandidates(item.id); }}>Continue</button>
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
            <button disabled={!session} onClick={() => scan().catch((e) => onError(e.message))}>Start candidate scan</button>
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
  const load = () => api.list<AgentJob>('/api/agent-jobs').then((r) => setItems(r.items)).catch((e) => onError(e.message));
  const inspect = (job: AgentJob) => api.get<AgentJob>(`/api/agent-jobs/${job.id}`).then(setInspected).catch((e) => onError(e.message));
  useEffect(() => { load(); }, []);
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
            <button onClick={() => api.post<{ attachCommand: string }>(`/api/agent-jobs/${j.id}/open`).then((r) => setAttachCommand(r.attachCommand)).catch((e) => onError(e.message))}>Open</button>
            <button onClick={() => api.post(`/api/agent-jobs/${j.id}/cancel`).then(load).catch((e) => onError(e.message))}>Cancel</button>
          </article>
        ))}
      </div>
      {inspected && <JobInspector job={inspected} />}
    </section>
  );
}

function JobInspector({ job }: { job: AgentJob }) {
  const events = job.transcript?.events ?? [];
  const files = job.outputFiles ?? [];
  return (
    <section className="panel job-inspector">
      <h3>{job.role} {job.status}</h3>
      <div className="metrics-grid">
        {Object.entries(job.metrics ?? {}).map(([key, value]) => <span key={key}><strong>{key}</strong>{value}</span>)}
        {Object.keys(job.metrics ?? {}).length === 0 && <span><strong>metrics</strong>none yet</span>}
      </div>
      <div className="job-detail-grid">
        <LogBlock title="Prompt" path={job.prompt?.path ?? job.promptPath} content={job.prompt?.content ?? ''} truncated={job.prompt?.truncated} />
        <LogBlock title="Transcript" path={job.transcript?.path ?? job.transcriptPath} content={job.transcript?.content ?? ''} truncated={job.transcript?.truncated} />
      </div>
      <div className="job-detail-grid">
        <section>
          <h4>Detected messages and prompts</h4>
          <div className="event-list">
            {events.map((event) => <span key={`${event.kind}-${event.line}`}><strong>{event.kind}</strong><em>line {event.line}</em>{event.text}</span>)}
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
