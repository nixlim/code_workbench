import type { ListEnvelope } from './generated/types';

export class APIClient {
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {})
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message ?? res.statusText;
      throw new Error(`${data?.error?.code ?? res.status}: ${message}`);
    }
    return data as T;
  }

  list<T>(path: string): Promise<ListEnvelope<T>> {
    return this.request<ListEnvelope<T>>(path);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : '{}' });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }
}

export const api = new APIClient();
