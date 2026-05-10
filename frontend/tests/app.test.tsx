import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const body = url.includes('palette') ? { items: [] } : { items: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('renders all primary screens without authentication', async () => {
  render(<App />);
  expect(screen.getAllByText('Repositories').length).toBeGreaterThan(0);
  expect(screen.getByText('Sessions')).toBeInTheDocument();
  expect(screen.getByText('Candidates')).toBeInTheDocument();
  expect(screen.getByText('Modules')).toBeInTheDocument();
  expect(screen.getByText('Workbench')).toBeInTheDocument();
  expect(screen.getByText('Blueprints')).toBeInTheDocument();
  expect(screen.getByText('Agent Jobs')).toBeInTheDocument();
});
