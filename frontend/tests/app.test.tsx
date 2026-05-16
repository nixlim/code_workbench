import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const body = url.includes('palette') ? { items: [] } : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it('renders all primary screens without authentication', async () => {
  render(<App />);
  expect(screen.getByText('Registry & Code Extraction')).toBeInTheDocument();
  expect(screen.getByText('Spec Enrichment')).toBeInTheDocument();
  expect(screen.getByText('Composition')).toBeInTheDocument();
  expect(screen.getByText('Modules')).toBeInTheDocument();
  expect(screen.getByText('Agent Jobs')).toBeInTheDocument();
});

it('blocks registry extraction until a candidate is approved', () => {
  render(<App />);
  expect(screen.getByText('Configure extraction job')).toBeDisabled();
});

it('does not show popup click feedback when enabled buttons are pressed', () => {
  render(<App />);
  fireEvent.click(screen.getByText('Spec Enrichment'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Spec Enrichment' })).toBeInTheDocument();
});

it('blocks composition compile before clarification answers are saved', () => {
  render(<App />);
  fireEvent.click(screen.getByText('Composition'));
  expect(screen.getByText('Compile blueprint and spec')).toBeDisabled();
});

it('shows registered sources so duplicates can be reused', async () => {
  vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
    const path = String(url);
    const body = path.includes('/api/repositories')
      ? { items: [{ id: 'repo_1', name: 'existing-repo', sourceType: 'git_url', sourceUri: 'https://example.test/repo.git', sourceCheckoutPath: '.sources/existing-repo', createdAt: 'now', updatedAt: 'now' }] }
      : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  expect(await screen.findByText('existing-repo')).toBeInTheDocument();
  expect(screen.getByText('.sources/existing-repo')).toBeInTheDocument();
  expect(screen.getByText('Use for extraction')).toBeInTheDocument();
});

it('highlights continue after using a registered source for extraction', async () => {
  const repo = { id: 'repo_1', name: 'existing-repo', sourceType: 'local_path', sourceUri: '/allowed/existing-repo', sourceCheckoutPath: '.sources/existing-repo', createdAt: 'now', updatedAt: 'now' };
  const session = { id: 'sess_1', repositoryId: repo.id, repoName: repo.name, phase: 'awaiting_user_intent', createdAt: 'now', updatedAt: 'now' };
  vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/api/repositories') && init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toMatchObject({ sourceUri: repo.sourceUri });
      return Promise.resolve(new Response(JSON.stringify(repo), { status: 201, headers: { 'content-type': 'application/json' } }));
    }
    if (path.includes('/api/sessions') && init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify(session), { status: 201, headers: { 'content-type': 'application/json' } }));
    }
    const body = path.includes('/api/repositories') ? { items: [repo] } : path.includes('/api/sessions') ? { items: [session] } : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  fireEvent.click(await screen.findByText('Use for extraction'));
  expect(await screen.findByText('Continue the extraction session for existing-repo.')).toBeInTheDocument();
  const continueBtn = screen.getByRole('button', { name: 'Continue' });
  expect(continueBtn.className).toContain('attention');
  fireEvent.click(continueBtn);
  expect(await screen.findByText('Describe what reusable functionality to extract, then start candidate scan for existing-repo.')).toBeInTheDocument();
});

it('clears previous extraction sessions while keeping the selected session', async () => {
  const current = { id: 'sess_1', repositoryId: 'repo_1', repoName: 'paperclip', phase: 'awaiting_user_intent', createdAt: 'now', updatedAt: 'now' };
  const previous = { id: 'sess_old', repositoryId: 'repo_1', repoName: 'old-paperclip', phase: 'awaiting_user_intent', createdAt: 'then', updatedAt: 'then' };
  let cleared = false;
  vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/api/sessions') && init?.method === 'DELETE') {
      expect(path).toBe('/api/sessions?keepSessionId=sess_1');
      cleared = true;
      return Promise.resolve(new Response(JSON.stringify({ deleted: 1, retained: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (path.includes('/api/sessions')) {
      return Promise.resolve(new Response(JSON.stringify({ items: cleared ? [current] : [current, previous] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  expect(await screen.findByText('old-paperclip')).toBeInTheDocument();
  fireEvent.click(screen.getAllByText('Continue')[0]);
  fireEvent.click(screen.getByText('Clear'));
  fireEvent.click(await screen.findByRole('button', { name: 'Clear sessions' }));
  expect(await screen.findByText('Cleared 1 previous extraction session.')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('old-paperclip')).not.toBeInTheDocument());
});

it('keeps sessions when the clear confirmation is dismissed', async () => {
  const current = { id: 'sess_1', repositoryId: 'repo_1', repoName: 'paperclip', phase: 'awaiting_user_intent', createdAt: 'now', updatedAt: 'now' };
  const previous = { id: 'sess_old', repositoryId: 'repo_1', repoName: 'old-paperclip', phase: 'awaiting_user_intent', createdAt: 'then', updatedAt: 'then' };
  let deleteCalled = false;
  vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/api/sessions') && init?.method === 'DELETE') {
      deleteCalled = true;
      return Promise.resolve(new Response(JSON.stringify({ deleted: 1, retained: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (path.includes('/api/sessions')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [current, previous] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  expect(await screen.findByText('old-paperclip')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Clear'));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear sessions' })).not.toBeInTheDocument());
  expect(screen.getByText('old-paperclip')).toBeInTheDocument();
  expect(deleteCalled).toBe(false);
});

it('surfaces candidates from the latest completed analysis session', async () => {
  const repo = { id: 'repo_1', name: 'paperclip', sourceType: 'git_url', sourceUri: 'https://example.test/paperclip.git', sourceCheckoutPath: '.sources/paperclip', createdAt: 'now', updatedAt: 'now' };
  const session = { id: 'sess_1', repositoryId: repo.id, repoName: repo.name, phase: 'awaiting_approval', createdAt: 'now', updatedAt: 'now' };
  const candidate = {
    id: 'sess_1.cand.001',
    sessionId: session.id,
    repositoryId: repo.id,
    proposedName: 'telemetry-client',
    description: 'Reusable telemetry client module.',
    moduleKind: 'library',
    targetLanguage: 'TypeScript',
    confidence: 'high',
    extractionRisk: 'low',
    status: 'proposed',
    registryDecision: 'add'
  };
  vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
    const path = String(url);
    const body = path.includes('/api/repositories')
      ? { items: [repo] }
      : path.includes('/api/sessions')
        ? { items: [session] }
        : path.includes('/api/candidates')
          ? { items: [candidate] }
          : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  expect(await screen.findByText('paperclip analysis succeeded. Review proposed candidates.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review candidates' })).toBeInTheDocument();
  expect(screen.getByText('telemetry-client')).toBeInTheDocument();
  expect(screen.getByText('Reusable telemetry client module.')).toBeInTheDocument();
});

it('configures target output language before creating an extraction plan', async () => {
  const repo = { id: 'repo_1', name: 'paperclip', sourceType: 'git_url', sourceUri: 'https://example.test/paperclip.git', sourceCheckoutPath: '.sources/paperclip', createdAt: 'now', updatedAt: 'now' };
  const session = { id: 'sess_1', repositoryId: repo.id, repoName: repo.name, phase: 'awaiting_approval', createdAt: 'now', updatedAt: 'now' };
  const candidate = {
    id: 'sess_1.cand.001',
    sessionId: session.id,
    repositoryId: repo.id,
    proposedName: 'telemetry-client',
    description: 'Reusable telemetry client module.',
    moduleKind: 'library',
    targetLanguage: 'TypeScript',
    confidence: 'high',
    extractionRisk: 'low',
    status: 'approved',
    registryDecision: 'add'
  };
  const patchBodies: unknown[] = [];
  let planBody: unknown;
  vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/api/candidates/') && init?.method === 'PATCH') {
      patchBodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify({ ...candidate, targetLanguage: 'go' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (path.endsWith('/api/extraction-plans') && init?.method === 'POST') {
      planBody = JSON.parse(String(init.body));
      return Promise.resolve(new Response(JSON.stringify({ id: 'plan_1' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    }
    const body = path.includes('/api/repositories')
      ? { items: [repo] }
      : path.includes('/api/sessions')
        ? { items: [session] }
        : path.includes('/api/candidates')
          ? { items: [candidate] }
          : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  expect(await screen.findByText('telemetry-client')).toBeInTheDocument();
  expect(screen.getByText('Agent language hint')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Configure extraction job'));
  expect(await screen.findByRole('dialog', { name: 'Configure extraction job' })).toBeInTheDocument();
  expect(screen.getByLabelText('Default output language')).toHaveValue('go');
  expect(screen.getByLabelText('telemetry-client output language')).toHaveValue('go');
  fireEvent.click(screen.getByText('Save configuration and create plan'));
  await waitFor(() => expect(patchBodies).toEqual([{ targetLanguage: 'go' }]));
  expect(planBody).toMatchObject({ sessionId: 'sess_1', approvedCandidateIds: ['sess_1.cand.001'] });
  expect(await screen.findByText('Extraction plan plan_1 configured for Go output.')).toBeInTheDocument();
});

it('lets users place modules on a composition canvas before intent is entered', async () => {
  vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
    const path = String(url);
    const body = path.includes('/api/workbench/palette')
      ? { items: [{ id: 'mod_1', name: 'registry-helper', version: '0.1.0', sourceRepositoryId: 'repo', sourceCandidateId: 'cand', language: 'go', moduleKind: 'library', capabilitiesJson: ['registry'], portsJson: { inputs: [{ name: 'in', type: 'Message' }], outputs: [{ name: 'out', type: 'Message' }] }, testStatus: 'passing', docsPath: 'docs', availableInWorkbench: 1 }] }
      : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  fireEvent.click(screen.getByText('Composition'));
  fireEvent.click(await screen.findByText('registry-helper'));
  expect(screen.getByLabelText('Composition canvas')).toBeInTheDocument();
  expect(screen.getByText('registry-helper@0.1.0')).toBeInTheDocument();
  expect(screen.getByText('Create composition')).toBeDisabled();
});

it('surfaces agent job prompts transcripts metrics and detected events', async () => {
  vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
    const path = String(url);
    const job = {
      id: 'job_1',
      role: 'extraction',
      provider: 'fake',
      status: 'running',
      subjectType: 'extraction_plan',
      subjectId: 'plan_1',
      promptPath: '/tmp/job_1/prompt.md',
      transcriptPath: '/tmp/job_1/output/transcript.txt',
      outputArtifactPath: '/tmp/job_1/output',
      timeoutSeconds: 3600,
      exitCode: 134,
      errorCode: 'job.interrupted',
      createdAt: 'now'
    };
    const body = path.endsWith('/api/agent-jobs/job_1')
      ? { ...job, prompt: { path: job.promptPath, content: 'Extract paperclip module', bytes: 24, truncated: false }, transcript: { path: job.transcriptPath, content: 'Do you want to continue?', bytes: 24, truncated: false, events: [{ kind: 'prompt', line: 1, text: 'Do you want to continue?' }] }, metrics: { promptBytes: 24, transcriptBytes: 24, detectedEvents: 1 }, outputFiles: [{ path: 'manifest.json', size: 12 }] }
      : path.includes('/api/agent-jobs')
        ? { items: [job] }
        : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  fireEvent.click(screen.getByText('Agent Jobs'));
  fireEvent.click(await screen.findByText('Inspect'));
  expect(await screen.findByText('Extract paperclip module')).toBeInTheDocument();
  expect(screen.getAllByText('Do you want to continue?').length).toBeGreaterThan(0);
  expect(screen.getByText('promptBytes')).toBeInTheDocument();
  expect(screen.getByText('errorCode')).toBeInTheDocument();
  expect(screen.getByText('job.interrupted')).toBeInTheDocument();
  expect(screen.getByText('exitCode')).toBeInTheDocument();
  expect(screen.getByText('134')).toBeInTheDocument();
  expect(screen.getByText('manifest.json')).toBeInTheDocument();
});

it('shows a copyable tmux command when inspecting a job with a tmux session', async () => {
  vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
    const path = String(url);
    const job = {
      id: 'job_1',
      role: 'repo_analysis',
      provider: 'claude_code_tmux',
      status: 'succeeded',
      subjectType: 'session',
      subjectId: 'sess_1',
      tmuxSessionName: 'code-workbench-job_1',
      promptPath: '/tmp/job_1/prompt.md',
      timeoutSeconds: 1800,
      createdAt: 'now'
    };
    const body = path.endsWith('/api/agent-jobs/job_1')
      ? job
      : path.includes('/api/agent-jobs')
        ? { items: [job] }
        : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  fireEvent.click(screen.getByText('Agent Jobs'));
  fireEvent.click(await screen.findByText('Inspect'));
  expect(await screen.findByText("tmux -S '/tmp/job_1/tmux.sock' attach -t 'code-workbench-job_1'")).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
});

it('copies the tmux attach command from an agent job', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText }
  });
  const command = 'tmux -S /tmp/job_1/tmux.sock attach -t code-workbench-job_1';
  vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    const job = {
      id: 'job_1',
      role: 'wiring',
      provider: 'claude_code_tmux',
      status: 'running',
      subjectType: 'blueprint',
      subjectId: 'bp_1',
      tmuxSessionName: 'code-workbench-job_1',
      promptPath: '/tmp/job_1/prompt.md',
      timeoutSeconds: 3600,
      createdAt: 'now'
    };
    if (path.endsWith('/api/agent-jobs/job_1/open') && init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ tmuxSessionName: job.tmuxSessionName, attachCommand: command }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    const body = path.endsWith('/api/agent-jobs/job_1')
      ? job
      : path.includes('/api/agent-jobs')
        ? { items: [job] }
        : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  fireEvent.click(screen.getByText('Agent Jobs'));
  fireEvent.click(await screen.findByText('Open'));
  expect(await screen.findAllByText(command)).toHaveLength(2);
  const copyButtons = screen.getAllByRole('button', { name: 'Copy command' });
  fireEvent.click(copyButtons[0]);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
  expect(await screen.findAllByRole('button', { name: 'Copied' })).toHaveLength(1);
});

it('surfaces the next action and wires in the Workbench canvas screen', async () => {
  render(<App />);
  expect(screen.getByText('Import a repository or choose a registered source.')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Workbench'));
  expect(await screen.findByRole('heading', { name: 'Workbench' })).toBeInTheDocument();
  expect(screen.getByText('Wire modules into a blueprint')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Generate code' })).toBeDisabled();
});

it('humanizes module table headers and offers a path forward when empty', async () => {
  render(<App />);
  fireEvent.click(screen.getByText('Modules'));
  expect(await screen.findByText('Registry decision')).toBeInTheDocument();
  expect(screen.getByText('Superseded by')).toBeInTheDocument();
  expect(screen.queryByText('registryDecision')).not.toBeInTheDocument();
  expect(screen.queryByText('REGISTRYDECISION')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Go to Registry/ })).toBeInTheDocument();
});

it('flags failed extraction sessions with a danger badge', async () => {
  const failed = { id: 'sess_f', repositoryId: 'repo_1', repoName: 'paperclip', phase: 'failed_analysis', createdAt: 'now', updatedAt: '2026-05-16T10:00:00Z' };
  vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
    const path = String(url);
    const body = path.includes('/api/sessions') ? { items: [failed] } : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  const badge = await screen.findByText('failed_analysis');
  expect(badge.className).toContain('danger');
});

it('unescapes agent transcript logs and exposes a copy control', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
    const path = String(url);
    const job = { id: 'job_1', role: 'extraction', provider: 'fake', status: 'succeeded', subjectType: 'extraction_plan', subjectId: 'plan_1', createdAt: 'now' };
    const body = path.endsWith('/api/agent-jobs/job_1')
      ? { ...job, transcript: { path: '/tmp/t.txt', content: 'line1\\nline2\\tindented', bytes: 20, truncated: false } }
      : path.includes('/api/agent-jobs')
        ? { items: [job] }
        : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  fireEvent.click(screen.getByText('Agent Jobs'));
  fireEvent.click(await screen.findByText('Inspect'));
  const pre = await screen.findByText((_, el) => el?.tagName === 'PRE' && /line1\nline2/.test(el.textContent || ''));
  expect(pre.textContent).not.toContain('\\n');
  const copyTranscript = screen.getByRole('button', { name: 'Copy transcript' });
  fireEvent.click(copyTranscript);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('line1\nline2\tindented'));
});

it('confirms before dropping a candidate', async () => {
  const repo = { id: 'repo_1', name: 'paperclip', sourceType: 'git_url', sourceUri: 'https://example.test/paperclip.git', sourceCheckoutPath: '.sources/paperclip', createdAt: 'now', updatedAt: 'now' };
  const session = { id: 'sess_1', repositoryId: repo.id, repoName: repo.name, phase: 'awaiting_approval', createdAt: 'now', updatedAt: 'now' };
  const candidate = { id: 'sess_1.cand.001', sessionId: session.id, repositoryId: repo.id, proposedName: 'telemetry-client', description: 'Reusable telemetry client module.', moduleKind: 'library', targetLanguage: 'TypeScript', confidence: 'high', extractionRisk: 'low', status: 'proposed', registryDecision: 'add' };
  let rejectBody: unknown;
  vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/api/candidates/sess_1.cand.001/reject') && init?.method === 'POST') {
      rejectBody = JSON.parse(String(init.body));
      return Promise.resolve(new Response(JSON.stringify({ ...candidate, status: 'rejected' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    const body = path.includes('/api/repositories')
      ? { items: [repo] }
      : path.includes('/api/sessions')
        ? { items: [session] }
        : path.includes('/api/candidates')
          ? { items: [candidate] }
          : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  fireEvent.click(await screen.findByText('Drop'));
  expect(await screen.findByText('Drop telemetry-client?')).toBeInTheDocument();
  expect(rejectBody).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Drop candidate' }));
  await waitFor(() => expect(rejectBody).toMatchObject({ reason: 'approved for extraction' }));
});
