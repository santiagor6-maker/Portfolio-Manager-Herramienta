/**
 * Adapter over the market-data HTTP API (apps/server). The rest of the app only talks to
 * `MarketClient`, so the transport can be swapped for `@pm/market-data/client`.
 */
import type { BatchRequest, BatchResponse, HealthResponse, SearchResult } from './marketTypes';

export interface MarketClient {
  health(): Promise<HealthResponse>;
  batch(req: BatchRequest): Promise<BatchResponse>;
  search(q: string, limit?: number): Promise<SearchResult[]>;
}

export class MarketHttpError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  return `${b}${path}`;
}

/** `serverUrl` empty → same-origin `/api` (Vite dev/preview proxy to :8787). */
export function createHttpMarketClient(serverUrl: string, timeoutMs = 20_000): MarketClient {
  const base = serverUrl.trim() ? joinUrl(serverUrl.trim(), '/api') : '/api';
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(joinUrl(base, path), {
        ...init,
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json')) throw new MarketHttpError('not_json', res.status);
      const body = (await res.json()) as T & { error?: { message: string } };
      if (!res.ok) throw new MarketHttpError(body.error?.message ?? `HTTP ${res.status}`, res.status);
      return body;
    } catch (e) {
      if (e instanceof MarketHttpError) throw e;
      throw new MarketHttpError(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    health: () => req<HealthResponse>('/health'),
    batch: (body) => req<BatchResponse>('/batch', { method: 'POST', body: JSON.stringify(body) }),
    search: async (q, limit = 12) => {
      const r = await req<{ results: SearchResult[] } | SearchResult[]>(
        `/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      );
      return Array.isArray(r) ? r : r.results;
    },
  };
}
