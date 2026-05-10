import { BriefcaseBusiness, Boxes, GitBranch, LayoutDashboard, Network, PlaySquare, Workflow } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AgentJob, Blueprint, Candidate, ModuleRecord, RegistryComparison, Repository, Session } from '../api/generated/types';
import { api } from '../api/client';
import { WorkbenchView } from '../components/workbench/WorkbenchView';

type Screen = 'repositories' | 'sessions' | 'candidates' | 'modules' | 'workbench' | 'blueprints' | 'jobs';

const screens: Array<{ id: Screen; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'repositories', label: 'Repositories', icon: GitBranch },
  { id: 'sessions', label: 'Sessions', icon: Workflow },
  { id: 'candidates', label: 'Candidates', icon: BriefcaseBusiness },
  { id: 'modules', label: 'Modules', icon: Boxes },
  { id: 'workbench', label: 'Workbench', icon: Network },
  { id: 'blueprints', label: 'Blueprints', icon: LayoutDashboard },
  { id: 'jobs', label: 'Agent Jobs', icon: PlaySquare }
];

export function App() {
  const [screen, setScreen] = useState<Screen>('repositories');
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
        {screen === 'repositories' && <Repositories onError={setError} />}
        {screen === 'sessions' && <Sessions onError={setError} />}
        {screen === 'candidates' && <Candidates onError={setError} />}
        {screen === 'modules' && <Modules onError={setError} />}
        {screen === 'workbench' && <WorkbenchView onError={setError} />}
        {screen === 'blueprints' && <Blueprints onError={setError} />}
        {screen === 'jobs' && <Jobs onError={setError} />}
      </main>
    </div>
  );
}

function Repositories({ onError }: { onError: (value: string) => void }) {
  const [items, setItems] = useState<Repository[]>([]);
  const [sourceUri, setSourceUri] = useState('');
  const [sourceType, setSourceType] = useState<'local_path' | 'git_url'>('local_path');
  const load = () => api.list<Repository>('/api/repositories').then((r) => setItems(r.items)).catch((e) => onError(String(e.message)));
  useEffect(() => { void load(); }, []);
  return (
    <section>
      <Header title="Repositories" />
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); api.post('/api/repositories', { sourceType, sourceUri }).then(load).catch((err) => onError(err.message)); }}>
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value as 'local_path' | 'git_url')}>
          <option value="local_path">Local path</option>
          <option value="git_url">Git URL</option>
        </select>
        <input value={sourceUri} onChange={(e) => setSourceUri(e.target.value)} placeholder="Repository path or URL" />
        <button type="submit">Register</button>
      </form>
      <Table rows={items} columns={['name', 'sourceType', 'sourceUri', 'createdAt']} />
    </section>
  );
}

function Sessions({ onError }: { onError: (value: string) => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [repoId, setRepoId] = useState('');
  const [intent, setIntent] = useState('');
  const load = () => {
    api.list<Session>('/api/sessions').then((r) => setSessions(r.items)).catch((e) => onError(e.message));
    api.list<Repository>('/api/repositories').then((r) => { setRepos(r.items); setRepoId((prev) => prev || r.items[0]?.id || ''); }).catch(() => undefined);
  };
  useEffect(() => { void load(); }, []);
  const nextAction = (s: Session) => s.phase === 'awaiting_user_intent' ? 'Record intent' : s.phase === 'ready_for_analysis' ? 'Queue analysis' : 'Review status';
  return (
    <section>
      <Header title="Sessions" />
      <div className="toolbar">
        <select value={repoId} onChange={(e) => setRepoId(e.target.value)}>{repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <button onClick={() => api.post('/api/sessions', { repositoryId: repoId }).then(load).catch((e) => onError(e.message))}>Create</button>
        <input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Extraction intent" />
      </div>
      <div className="stack">
        {sessions.map((s) => {
          const canSaveIntent = s.phase === 'awaiting_user_intent' || s.phase === 'needs_user_input';
          const canQueueAnalysis = s.phase === 'ready_for_analysis';
          return (
            <article className="row-card" key={s.id}>
              <strong>{s.repoName}</strong><span>{s.phase}</span><span>{s.activeJobRole ?? 'No active job'}</span><span>{nextAction(s)}</span><span>{s.updatedAt}</span>
              <button disabled={!canSaveIntent} onClick={() => api.post(`/api/sessions/${s.id}/intent`, { specificFunctionality: intent, allowAgentDiscovery: true, expectedUpdatedAt: s.updatedAt }).then(load).catch((e) => onError(e.message))}>Save Intent</button>
              <button disabled={!canQueueAnalysis} onClick={() => api.post(`/api/sessions/${s.id}/analysis-jobs`, {}).then(load).catch((e) => onError(e.message))}>Queue Analysis</button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Candidates({ onError }: { onError: (value: string) => void }) {
  const [items, setItems] = useState<Candidate[]>([]);
  const [status, setStatus] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [risk, setRisk] = useState('');
  const [confidence, setConfidence] = useState('');
  const [capability, setCapability] = useState('');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState<{ path: string; content: string } | null>(null);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (sessionId) params.set('sessionId', sessionId);
    if (repositoryId) params.set('repositoryId', repositoryId);
    if (status) params.set('status', status);
    if (risk) params.set('extractionRisk', risk);
    if (confidence) params.set('confidence', confidence);
    if (capability) params.set('capability', capability);
    const value = params.toString();
    return value ? `?${value}` : '';
  }, [sessionId, repositoryId, status, risk, confidence, capability]);
  const load = () => api.list<Candidate>(`/api/candidates${query}`).then((r) => setItems(r.items)).catch((e) => onError(e.message));
  useEffect(() => { void load(); }, [query]);
  const grouped = useMemo(() => {
    const result = new Map<string, Candidate[]>();
    for (const item of items) {
      result.set(item.sessionId, [...(result.get(item.sessionId) ?? []), item]);
    }
    return result;
  }, [items]);
  const sourcePath = (c: Candidate) => Array.isArray(c.sourcePathsJson) ? c.sourcePathsJson[0] : String(c.sourcePathsJson ?? '').replace(/^\[?"?|"?\]?$/g, '');
  const viewSource = (c: Candidate) => {
    const path = sourcePath(c);
    if (!path) return;
    api.get<{ path: string; content: string }>(`/api/sessions/${c.sessionId}/files?path=${encodeURIComponent(path)}`).then(setSource).catch((e) => onError(e.message));
  };
  const action = (id: string, name: string) => api.post(`/api/candidates/${id}/${name}`, { reason }).then(load).catch((e) => onError(e.message));
  return (
    <section>
      <Header title="Candidates" />
      <div className="toolbar">
        <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} placeholder="Session" />
        <input value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)} placeholder="Repository" />
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option>proposed</option><option>approved</option><option>rejected</option><option>duplicate_detected</option></select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)}><option value="">All risks</option><option>low</option><option>medium</option><option>high</option></select>
        <select value={confidence} onChange={(e) => setConfidence(e.target.value)}><option value="">All confidence</option><option>low</option><option>medium</option><option>high</option></select>
        <input value={capability} onChange={(e) => setCapability(e.target.value)} placeholder="Capability" />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Decision reason" />
      </div>
      {[...grouped.entries()].map(([sessionId, candidates]) => (
        <div key={sessionId}><h2>{sessionId}</h2>{candidates.map((c) => <article className="row-card" key={c.id}><strong>{c.proposedName}</strong><span>{c.status}</span><span>{c.extractionRisk}</span><span>{c.confidence}</span><p>{c.description}</p><button onClick={() => action(c.id, 'approve')}>Approve</button><button onClick={() => action(c.id, 'reject')}>Reject</button><button onClick={() => action(c.id, 'defer')}>Defer</button><button onClick={() => action(c.id, 'duplicate')}>Duplicate</button><button onClick={() => action(c.id, 'rescan')}>Rescan</button><button onClick={() => viewSource(c)}>Source</button><button onClick={() => api.patch(`/api/candidates/${c.id}`, { description: `${c.description} ` }).then(load).catch((e) => onError(e.message))}>Modify</button></article>)}</div>
      ))}
      {source && <pre className="source-view">{source.path}{'\n\n'}{source.content}</pre>}
    </section>
  );
}

function Modules({ onError }: { onError: (value: string) => void }) {
  const [items, setItems] = useState<ModuleRecord[]>([]);
  const [classification, setClassification] = useState('');
  useEffect(() => { api.list<ModuleRecord>('/api/modules').then((r) => setItems(r.items)).catch((e) => onError(e.message)); }, []);
  return <section><Header title="Modules" />{classification && <div className="notice">{classification}</div>}<Table rows={items} columns={['name', 'version', 'sourceRepositoryId', 'sourceCandidateId', 'language', 'moduleKind', 'capabilitiesJson', 'portsJson', 'testStatus', 'docsPath', 'availableInWorkbench']} />{items.map((m) => <button key={m.id} onClick={() => api.post<RegistryComparison>(`/api/modules/${m.id}/compare`, {}).then((r) => setClassification(r.classification)).catch((e) => onError(e.message))}>Compare {m.name}</button>)}</section>;
}

function Blueprints({ onError }: { onError: (value: string) => void }) {
  const [items, setItems] = useState<Blueprint[]>([]);
  const [validationReport, setValidationReport] = useState<unknown>(null);
  const [wiringJob, setWiringJob] = useState<AgentJob | null>(null);
  const load = () => api.list<Blueprint>('/api/blueprints').then((r) => setItems(r.items)).catch((e) => onError(e.message));
  useEffect(() => { void load(); }, []);
  return <section><Header title="Blueprints" /><Table rows={items} columns={['name', 'validationStatus', 'targetLanguage', 'outputKind', 'packageName']} />{validationReport !== null && <pre className="source-view">{JSON.stringify(validationReport, null, 2)}</pre>}{wiringJob && <div className="notice">{wiringJob.role} {wiringJob.status}</div>}{items.map((b) => <article className="row-card" key={b.id}><button onClick={() => api.post<Blueprint & { validationReport?: unknown }>(`/api/blueprints/${b.id}/validate`).then((result) => { setValidationReport(result.validationReport ?? null); return load(); }).catch((e) => onError(e.message))}>Validate</button><button onClick={() => api.post<AgentJob>(`/api/blueprints/${b.id}/wiring-jobs`).then(setWiringJob).catch((e) => onError(e.message))}>Generate Code</button></article>)}</section>;
}

function Jobs({ onError }: { onError: (value: string) => void }) {
  const [items, setItems] = useState<AgentJob[]>([]);
  const [attachCommand, setAttachCommand] = useState('');
  const load = () => api.list<AgentJob>('/api/agent-jobs').then((r) => setItems(r.items)).catch((e) => onError(e.message));
  const runningIds = useMemo(() => items.filter((j) => j.status === 'running').map((j) => j.id).sort().join(','), [items]);
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!runningIds) return;
    const id = window.setInterval(() => {
      void Promise.all(runningIds.split(',').map((jobId) => api.get<AgentJob>(`/api/agent-jobs/${jobId}`))).then((fresh) => {
        setItems((current) => current.map((job) => fresh.find((item) => item.id === job.id) ?? job));
      }).catch((e) => onError(e.message));
    }, 5000);
    return () => window.clearInterval(id);
  }, [runningIds]);
  return <section><Header title="Agent Jobs" />{attachCommand && <div className="notice">{attachCommand}</div>}<Table rows={items} columns={['role', 'provider', 'status', 'subjectType', 'subjectId', 'tmuxSessionName', 'createdAt', 'startedAt', 'finishedAt']} />{items.map((j) => <article className="row-card" key={j.id}><button onClick={() => api.post<{ attachCommand: string }>(`/api/agent-jobs/${j.id}/open`).then((r) => setAttachCommand(r.attachCommand)).catch((e) => onError(e.message))}>Open</button><button onClick={() => api.post(`/api/agent-jobs/${j.id}/cancel`).then(load).catch((e) => onError(e.message))}>Cancel</button></article>)}</section>;
}

function Header({ title }: { title: string }) {
  return <header className="page-header"><h2>{title}</h2></header>;
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
