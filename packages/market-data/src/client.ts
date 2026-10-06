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
  /** Max items per batch request (server cap: 100). */
  batchChunkSize?: number;
  /** Max ids per /api/quote request (server cap: 50). */
  quoteChunkSize?: number;
  /** Chunk requests in flight at once (default 3). */
  chunkConcurrency?: number;
}

/** Run `fn` over `items` with at most `limit` promises in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Turn a failed chunk request into one failed Settled per item of that chunk. */
function failAll<T>(n: number, e: unknown): Settled<T>[] {
  const error =
    e instanceof MarketDataApiError
      ? { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) }
      : { code: 'NETWORK', message: e instanceof Error ? e.message : String(e) };
  return Array.from({ length: n }, () => ({ ok: false as const, error }));
}

type Query = Record<string, string | number | undefined | null>;

export class MarketDataClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly apiToken?: string;
  private readonly batchChunkSize: number;
  private readonly quoteChunkSize: number;
  private readonly chunkConcurrency: number;

  constructor(opts: MarketDataClientOptions = {}) {
    this.apiToken = opts.apiToken;
    this.batchChunkSize = Math.max(1, Math.min(100, opts.batchChunkSize ?? 100));
    this.quoteChunkSize = Math.max(1, Math.min(50, opts.quoteChunkSize ?? 50));
    this.chunkConcurrency = Math.max(1, opts.chunkConcurrency ?? 3);
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
  /**
   * Quotes for instrument ids or provider symbols; failures are reported per item. Any number of
   * ids: requests are split into chunks of `quoteChunkSize` (server cap 50) run with limited
   * concurrency; a failed chunk marks each of its ids as failed, the rest still succeed.
   */
  async quotes(ids: string[], signal?: AbortSignal): Promise<{ quotes: Settled<Quote>[] }> {
    // The server de-duplicates ids, so send unique ids and map results back to every position.
    const unique = [...new Set(ids.map((i) => i.trim()))];
    const parts = await mapLimit(chunk(unique, this.quoteChunkSize), this.chunkConcurrency, async (part) => {
      try {
        return (await this.request<{ quotes: Settled<Quote>[] }>('/api/quote', { query: { ids: part.join(',') }, signal })).quotes;
      } catch (e) {
        return failAll<Quote>(part.length, e);
      }
    });
    const byId = new Map(unique.map((id, i) => [id, parts.flat()[i]!]));
    return { quotes: ids.map((id) => byId.get(id.trim())!) };
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
  /**
   * Many histories + FX pairs + quotes + indices in one logical call (ideal for the monthly
   * table). Requests above the server cap are split transparently into chunks of
   * `batchChunkSize` items (server cap 100), sent with limited concurrency and merged back in the
   * original order; a chunk that fails as a whole marks its items as failed.
   */
  async batch(req: BatchRequest, signal?: AbortSignal): Promise<BatchResponse> {
    const started = Date.now();
    type Item = { kind: 'histories' | 'fx' | 'quotes' | 'indices'; value: unknown };
    const items: Item[] = [
      ...(req.histories ?? []).map((value) => ({ kind: 'histories' as const, value })),
      ...(req.fx ?? []).map((value) => ({ kind: 'fx' as const, value })),
      ...(req.quotes ?? []).map((value) => ({ kind: 'quotes' as const, value })),
      ...(req.indices ?? []).map((value) => ({ kind: 'indices' as const, value })),
    ];
    if (items.length <= this.batchChunkSize) return this.request('/api/batch', { body: req, signal });
    const parts = await mapLimit(chunk(items, this.batchChunkSize), this.chunkConcurrency, async (part) => {
      const body: Record<Item['kind'], unknown[]> = { histories: [], fx: [], quotes: [], indices: [] };
      for (const it of part) body[it.kind].push(it.value);
      try {
        return await this.request<BatchResponse>('/api/batch', { body, signal });
      } catch (e) {
        return {
          histories: failAll(body.histories.length, e),
          fx: failAll(body.fx.length, e),
          quotes: failAll(body.quotes.length, e),
          indices: failAll(body.indices.length, e),
          tookMs: 0,
        } as BatchResponse;
      }
    });
    return {
      histories: parts.flatMap((p) => p.histories ?? []),
      fx: parts.flatMap((p) => p.fx ?? []),
      quotes: parts.flatMap((p) => p.quotes ?? []),
      indices: parts.flatMap((p) => p.indices ?? []),
      tookMs: Date.now() - started,
    };
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
