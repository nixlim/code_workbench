import { Boxes, FileText, GitBranch, PlaySquare, WandSparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentJob, Candidate, Composition, ModuleRecord, Repository, Session, SpecEnrichment } from '../api/generated/types';
import { api } from '../api/client';

type Screen = 'registry' | 'spec' | 'composition' | 'modules' | 'jobs';

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
  const [repo, setRepo] = useState<Repository | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [intent, setIntent] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [reason, setReason] = useState('approved for extraction');
  const [planId, setPlanId] = useState('');
  const approvedIds = useMemo(() => candidates.filter((c) => c.status === 'approved').map((c) => c.id), [candidates]);

  const loadCandidates = (sessionId = session?.id) => {
    if (!sessionId) return Promise.resolve();
    return api.list<Candidate>(`/api/candidates?sessionId=${encodeURIComponent(sessionId)}`).then((r) => setCandidates(r.items)).catch((e) => onError(e.message));
  };
  const begin = async () => {
    const saved = await api.post<Repository>('/api/repositories', { sourceType, sourceUri });
    setRepo(saved);
    const created = await api.post<Session>('/api/sessions', { repositoryId: saved.id });
    setSession(created);
    setCandidates([]);
  };
  const scan = async () => {
    if (!session) return;
    const updated = await api.post<Session>(`/api/sessions/${session.id}/intent`, { specificFunctionality: intent, allowAgentDiscovery: true, expectedUpdatedAt: session.updatedAt });
    setSession(updated);
    await api.post<AgentJob>(`/api/sessions/${session.id}/analysis-jobs`, {});
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
          </div>
          {repo && <div className="notice">{repo.name} stored at {repo.sourceCheckoutPath}</div>}
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
  const [selected, setSelected] = useState<string[]>([]);
  const [intent, setIntent] = useState('');
  const [composition, setComposition] = useState<Composition | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => { api.list<ModuleRecord>('/api/workbench/palette').then((r) => setModules(r.items)).catch((e) => onError(e.message)); }, []);
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const create = () => {
    const flowLayout = { nodes: selected.map((id, index) => ({ id, position: { x: 80 + index * 180, y: 120 }, data: { moduleId: id } })), edges: [] };
    return api.post<Composition>('/api/compositions', { intent, selectedModuleIds: selected, flowLayout }).then(setComposition).catch((e) => onError(e.message));
  };
  const refresh = () => composition && api.get<Composition>(`/api/compositions/${composition.id}`).then(setComposition).catch((e) => onError(e.message));
  const questions = Array.isArray(composition?.questionsJson) ? composition.questionsJson : [];
  const allAnswered = questions.length > 0 && questions.every((q) => q.id && answers[q.id]);
  return (
    <section>
      <Header title="Freeform Composition" />
      <div className="wizard-grid">
        <Panel title="1. Select components">
          <div className="module-list">
            {modules.map((module) => (
              <label key={module.id}>
                <input type="checkbox" checked={selected.includes(module.id)} onChange={() => toggle(module.id)} />
                <span>{module.name}@{module.version}</span>
              </label>
            ))}
          </div>
        </Panel>
        <Panel title="2. Clarify intent">
          <div className="toolbar">
            <input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Composition intent" />
            <button disabled={selected.length === 0 || !intent} onClick={create}>Create composition</button>
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
  const [attachCommand, setAttachCommand] = useState('');
  const load = () => api.list<AgentJob>('/api/agent-jobs').then((r) => setItems(r.items)).catch((e) => onError(e.message));
  useEffect(() => { load(); }, []);
  return <section><Header title="Agent Jobs" />{attachCommand && <div className="notice">{attachCommand}</div>}<Table rows={items} columns={['role', 'provider', 'status', 'subjectType', 'subjectId', 'tmuxSessionName', 'createdAt', 'finishedAt']} />{items.map((j) => <article className="row-card" key={j.id}><button onClick={() => api.post<{ attachCommand: string }>(`/api/agent-jobs/${j.id}/open`).then((r) => setAttachCommand(r.attachCommand)).catch((e) => onError(e.message))}>Open</button><button onClick={() => api.post(`/api/agent-jobs/${j.id}/cancel`).then(load).catch((e) => onError(e.message))}>Cancel</button></article>)}</section>;
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
