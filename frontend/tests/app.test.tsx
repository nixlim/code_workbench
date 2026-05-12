import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

it('shows visible click feedback when enabled buttons are pressed', () => {
  render(<App />);
  fireEvent.click(screen.getAllByText('Spec Enrichment')[0]);
  expect(screen.getByRole('status')).toHaveTextContent('click');
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
