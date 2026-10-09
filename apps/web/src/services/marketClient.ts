/**
 * Adapter over `@pm/market-data/client` (HTTP API served by apps/server). The rest of the app
 * only talks to `MarketClient`, so tests can inject a fake.
 */
import { MarketDataClient } from '@pm/market-data/client';
import type { BatchRequest, BatchResponse, HealthResponse, SearchResult } from '@pm/market-data/client';

export type { BatchRequest, BatchResponse, FxRequest, HistoryRequest, Quote, SearchResult } from '@pm/market-data/client';

export interface MarketClient {
  health(): Promise<HealthResponse>;
  batch(req: BatchRequest): Promise<BatchResponse>;
  search(q: string, limit?: number): Promise<SearchResult[]>;
}

let override: MarketClient | undefined;

/** Test hook. */
export function setMarketClientOverride(c: MarketClient | undefined): void {
  override = c;
}

/** `serverUrl` empty → same origin (Vite dev/preview proxies `/api` to :8787). */
export function createHttpMarketClient(serverUrl: string, timeoutMs = 25_000, apiToken?: string): MarketClient {
  if (override) return override;
  const api = new MarketDataClient({ baseUrl: serverUrl.trim(), timeoutMs, apiToken: apiToken?.trim() || undefined });
  return {
    health: () => api.health(),
    batch: (req) => api.batch(req),
    search: async (q, limit = 12) => (await api.search(q, { limit })).results,
  };
}
