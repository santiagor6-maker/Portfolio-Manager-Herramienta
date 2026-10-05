/**
 * Test helpers: a fake `fetch` that serves recorded fixtures by URL, with switches to simulate
 * blocked hosts / 429s, plus a service factory with a fixed clock (2026-10-05).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient, MarketDataService, TieredCache, type FetchLike, type MarketDataServiceOptions } from '../src/index';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

export function fixtureJson<T = any>(path: string): T {
  return JSON.parse(fixture(path)) as T;
}

export const NOW = new Date('2026-10-05T15:00:00Z');

export interface FakeFetchOptions {
  /** Hosts that answer 403 (like the sandbox egress proxy) or 503. */
  blockedHosts?: string[];
  failingHosts?: string[];
  /** Respond 429 to the first N Yahoo requests. */
  rateLimitFirst?: number;
}

export interface FakeFetch extends FetchLike {
  calls: string[];
}

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptySplits(symbol: string): unknown {
  return { chart: { result: [{ meta: { symbol, currency: 'USD', exchangeTimezoneName: 'America/New_York', gmtoffset: -14400 }, timestamp: [], indicators: { quote: [{ close: [] }] } }], error: null } };
}

export function createFakeFetch(opts: FakeFetchOptions = {}): FakeFetch {
  let limited = 0;
  const calls: string[] = [];
  const f = (async (input: string) => {
    const url = new URL(input);
    calls.push(input);
    if (opts.blockedHosts?.includes(url.host)) return new Response(`Host not in allowlist: ${url.host}`, { status: 403 });
    if (opts.failingHosts?.includes(url.host)) return new Response('unavailable', { status: 503 });

    if (url.host.endsWith('finance.yahoo.com')) {
      if (opts.rateLimitFirst && limited < opts.rateLimitFirst) {
        limited++;
        return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '0' } });
      }
      if (url.pathname.startsWith('/v1/finance/search')) {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const p = `yahoo/search-${q}.json`;
        return existsSync(join(FIXTURES, p)) ? json(fixture(p)) : json({ quotes: [] });
      }
      const m = /^\/v8\/finance\/chart\/(.+)$/.exec(url.pathname);
      if (m) {
        const symbol = decodeURIComponent(m[1]!);
        if (symbol === '^COLCAP' || symbol === 'NOPE.SA') return json(fixture('yahoo/chart-notfound.json'), 404);
        if (url.searchParams.get('interval') === '3mo') {
          const p = `yahoo/splits-${symbol}.json`;
          return existsSync(join(FIXTURES, p)) ? json(fixture(p)) : json(emptySplits(symbol));
        }
        if (url.searchParams.get('range') === '1d') {
          const p = `yahoo/quote-${symbol}.json`;
          return existsSync(join(FIXTURES, p)) ? json(fixture(p)) : json(fixture('yahoo/chart-notfound.json'), 404);
        }
        if (symbol === 'NVDA') {
          const p1 = Number(url.searchParams.get('period1'));
          return json(fixture(p1 < Date.UTC(2024, 3, 1) / 1000 ? 'yahoo/chart-NVDA-presplit-1d.json' : 'yahoo/chart-NVDA-split-1d.json'));
        }
        const fx: Record<string, string> = { 'COP=X': 'COP=X', 'BRL=X': 'BRL=X', 'EURUSD=X': 'EURUSD=X' };
        const p = `yahoo/chart-${fx[symbol] ?? symbol}-1d.json`;
        if (existsSync(join(FIXTURES, p))) return json(fixture(p));
        return json(fixture('yahoo/chart-notfound.json'), 404);
      }
    }
    if (url.host === 'www.datos.gov.co') return json(fixture('banrep/trm-2025-01-04.json'));
    if (url.host === 'olinda.bcb.gov.br') {
      if (url.pathname.includes('CotacaoDolarPeriodo')) return json(fixture('bcb/ptax-usd-2025-01.json'));
      if (url.pathname.includes('CotacaoMoedaPeriodo') && url.search.includes("'EUR'")) return json(fixture('bcb/ptax-eur-2025-01.json'));
      return json({ value: [] });
    }
    if (url.host === 'api.bcb.gov.br') {
      if (url.pathname.includes('sgs.1/')) return json(fixture('bcb/sgs-1-2025-01.json'));
      if (url.pathname.includes('sgs.21619/')) return json(fixture('bcb/sgs-21619-2025-01.json'));
      return json([]);
    }
    if (url.host === 'data-api.ecb.europa.eu') {
      const csv = fixture('ecb/exr-d-2025-01.csv');
      const key = url.pathname.split('/').pop() ?? '';
      const wanted = (key.split('.')[1] ?? '').split('+');
      const lines = csv.split('\r\n');
      const filtered = [lines[0], ...lines.slice(1).filter((l) => wanted.some((c) => l.startsWith(`EXR.D.${c}.`)))];
      return new Response(filtered.join('\r\n'), { status: 200, headers: { 'content-type': 'text/csv' } });
    }
    return new Response('not found', { status: 404 });
  }) as FakeFetch;
  f.calls = calls;
  return f;
}

export function createTestService(
  fetchOpts: FakeFetchOptions = {},
  serviceOpts: Partial<MarketDataServiceOptions> = {},
): { service: MarketDataService; fetch: FakeFetch } {
  const fetch = createFakeFetch(fetchOpts);
  const http = new HttpClient({ fetch, sleep: async () => undefined, retries: 2, defaultPolicy: { concurrency: 8, minIntervalMs: 0 } });
  const service = new MarketDataService({
    http,
    now: () => NOW,
    cache: new TieredCache({ now: () => NOW.getTime() }),
    ...serviceOpts,
  });
  return { service, fetch };
}
