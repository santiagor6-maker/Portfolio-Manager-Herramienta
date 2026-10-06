/**
 * Typed HTTP client for the Portafolio Pro market-data API (apps/server).
 * Browser-safe: only uses fetch/URL; import via `@pm/market-data/client`.
 *
 *   const api = new MarketDataClient({ baseUrl: 'http://localhost:8787' });
 *   const { series } = await api.history({ symbol: 'BVMF:PETR4', from: '2024-01-01', interval: '1mo' });
 */
import type { CurrencyCode, ISODate } from '@pm/core';
import type {
  ApiErrorBody,
  BatchRequest,
  BatchResponse,
  Catalog,
  FxRequest,
  FxResponse,
  HealthResponse,
  HistoryRequest,
  HistoryResponse,
  IndexInfo,
  IndexRequest,
  IndexResponse,
  Quote,
  SearchResult,
  Settled,
} from './types';

export type * from './types';

export class MarketDataApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MarketDataApiError';
  }
}

export interface MarketDataClientOptions {
  /** Server origin, e.g. 'http://localhost:8787' or '' for same-origin. */
  baseUrl?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Abort requests after this many ms (default 30 s). */
  timeoutMs?: number;
  /** Optional API token (server started with API_TOKEN). Sent as `Authorization: Bearer`. */
  apiToken?: string;
}

type Query = Record<string, string | number | undefined | null>;

export class MarketDataClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly apiToken?: string;

  constructor(opts: MarketDataClientOptions = {}) {
    this.apiToken = opts.apiToken;
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private url(path: string, query?: Query): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    return `${this.baseUrl}${path}${s ? `?${s}` : ''}`;
  }

  private async request<T>(path: string, init: { query?: Query; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    init.signal?.addEventListener('abort', onAbort);
    try {
      const res = await this.fetchImpl(this.url(path, init.query), {
        method: init.body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (!res.ok) {
        const err = (json as ApiErrorBody | undefined)?.error;
        throw new MarketDataApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `HTTP ${res.status}`, err?.details);
      }
      return json as T;
    } catch (e) {
      if (e instanceof MarketDataApiError) throw e;
      if (controller.signal.aborted) throw new MarketDataApiError(0, 'TIMEOUT', `Request to ${path} timed out or was aborted`);
      throw new MarketDataApiError(0, 'NETWORK', e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }
  }

  health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.request('/api/health', { signal });
  }

  search(q: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<{ results: SearchResult[]; warnings?: string[] }> {
    return this.request('/api/search', { query: { q, limit: opts.limit }, signal: opts.signal });
  }

  /** Quotes for instrument ids or provider symbols; failures are reported per item. */
  quotes(ids: string[], signal?: AbortSignal): Promise<{ quotes: Settled<Quote>[] }> {
    return this.request('/api/quote', { query: { ids: ids.join(',') }, signal });
  }

  history(req: HistoryRequest, signal?: AbortSignal): Promise<HistoryResponse> {
    return this.request('/api/history', {
      query: { symbol: req.symbol, from: req.from, to: req.to, interval: req.interval, adjust: req.adjust },
      signal,
    });
  }

  fx(req: FxRequest, signal?: AbortSignal): Promise<FxResponse> {
    return this.request('/api/fx', {
      query: { base: req.base, quote: req.quote, from: req.from, to: req.to, interval: req.interval, source: req.source, side: req.side },
      signal,
    });
  }

  /** Rate / inflation index (CDI, SELIC, IPCA, IPC_CO, IBR, UVR, DTF, CPI_US...) in core's IndexSeries shape. */
  index(req: IndexRequest, signal?: AbortSignal): Promise<IndexResponse> {
    return this.request('/api/index', { query: { id: req.id, from: req.from, to: req.to }, signal });
  }

  /** Available index ids with descriptions. */
  indexList(signal?: AbortSignal): Promise<{ indices: IndexInfo[] }> {
    return this.request('/api/index', { signal });
  }

  catalog(signal?: AbortSignal): Promise<Catalog> {
    return this.request('/api/catalog', { signal });
  }

  /** Many histories + FX pairs + quotes in one round trip (ideal for the monthly table). */
  batch(req: BatchRequest, signal?: AbortSignal): Promise<BatchResponse> {
    return this.request('/api/batch', { body: req, signal });
  }

  /**
   * Convenience for the monthly table: month-end closes for instruments and month-end FX for
   * every currency into `baseCurrency`, in a single batch call.
   */
  monthEndData(
    instrumentIds: string[],
    currencies: CurrencyCode[],
    baseCurrency: CurrencyCode,
    from: ISODate,
    to?: ISODate,
    signal?: AbortSignal,
    indexIds: string[] = [],
  ): Promise<BatchResponse> {
    const fx = [...new Set(currencies.filter((c) => c !== baseCurrency))].map((c) => ({
      base: c,
      quote: baseCurrency,
      from,
      to,
      interval: '1mo' as const,
      source: 'auto' as const,
    }));
    return this.batch(
      {
        histories: instrumentIds.map((symbol) => ({ symbol, from, to, interval: '1mo' as const })),
        fx,
        indices: indexIds.map((id) => ({ id, from, to })),
      },
      signal,
    );
  }
}
