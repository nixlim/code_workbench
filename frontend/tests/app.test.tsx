import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const body = url.includes('palette') ? { items: [] } : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('renders all primary screens without authentication', async () => {
  render(<App />);
  expect(screen.getAllByText('Registry & Code Extraction').length).toBeGreaterThan(0);
  expect(screen.getByText('Spec Enrichment')).toBeInTheDocument();
  expect(screen.getByText('Freeform Composition')).toBeInTheDocument();
  expect(screen.getByText('Modules')).toBeInTheDocument();
  expect(screen.getByText('Agent Jobs')).toBeInTheDocument();
});

it('blocks registry extraction until a candidate is approved', () => {
  render(<App />);
  expect(screen.getByText('Create extraction plan')).toBeDisabled();
});

it('does not show popup click feedback when enabled buttons are pressed', () => {
  render(<App />);
  fireEvent.click(screen.getAllByText('Spec Enrichment')[0]);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Spec Enrichment' })).toBeInTheDocument();
});

it('blocks composition compile before clarification answers are saved', () => {
  render(<App />);
  fireEvent.click(screen.getAllByText('Freeform Composition')[0]);
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

it('uses the selected registered source for rescan guidance', async () => {
  const repo = { id: 'repo_1', name: 'existing-repo', sourceType: 'local_path', sourceUri: '/allowed/existing-repo', sourceCheckoutPath: '.sources/existing-repo', createdAt: 'now', updatedAt: 'now' };
  vi.mocked(fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/api/repositories') && init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toMatchObject({ sourceUri: repo.sourceUri, rescan: true });
      return Promise.resolve(new Response(JSON.stringify(repo), { status: 201, headers: { 'content-type': 'application/json' } }));
    }
    if (path.includes('/api/sessions') && init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ id: 'sess_1', repositoryId: repo.id, repoName: repo.name, phase: 'awaiting_user_intent', createdAt: 'now', updatedAt: 'now' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    }
    const body = path.includes('/api/repositories') ? { items: [repo] } : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  render(<App />);
  fireEvent.click(await screen.findByText('Use for extraction'));
  expect(await screen.findByText('Rescan existing-repo to refresh .sources, then describe what reusable functionality to extract.')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Rescan source'));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/repositories', expect.objectContaining({ method: 'POST' })));
  expect(await screen.findByText('Describe what reusable functionality to extract, then start candidate scan for existing-repo.')).toBeInTheDocument();
  expect(screen.getByText(/Enter an intent and press Start candidate scan to create an Agent Jobs entry/)).toBeInTheDocument();
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
  fireEvent.click(screen.getByText('Clear previous sessions'));
  expect(await screen.findByText('Cleared 1 previous extraction session.')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('old-paperclip')).not.toBeInTheDocument());
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
  fireEvent.click(screen.getAllByText('Freeform Composition')[0]);
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
  fireEvent.click(screen.getAllByText('Agent Jobs')[0]);
  fireEvent.click(await screen.findByText('Inspect'));
  expect(await screen.findByText('Extract paperclip module')).toBeInTheDocument();
  expect(screen.getAllByText('Do you want to continue?').length).toBeGreaterThan(0);
  expect(screen.getByText('promptBytes')).toBeInTheDocument();
  expect(screen.getByText('manifest.json')).toBeInTheDocument();
});
