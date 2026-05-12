import type { ListEnvelope } from './generated/types';

export class APIRequestError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = 'APIRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

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
      throw new APIRequestError(res.status, data?.error?.code ?? String(res.status), message, data?.error?.details);
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
