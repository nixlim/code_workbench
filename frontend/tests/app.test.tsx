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

it('blocks composition compile before clarification answers are saved', () => {
  render(<App />);
  fireEvent.click(screen.getAllByText('Freeform Composition')[0]);
  expect(screen.getByText('Compile blueprint and spec')).toBeDisabled();
});
