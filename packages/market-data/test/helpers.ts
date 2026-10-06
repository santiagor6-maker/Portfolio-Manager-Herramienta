/**
 * Test helpers: a fake `fetch` that serves recorded fixtures by URL, with switches to simulate
 * blocked hosts / 429s / a failing split-history endpoint, plus a service factory with a fixed
 * clock (2026-10-05 15:00 UTC, a Monday during the B3 session).
 */
import { existsSync, readFileSync } from 'node:fs';
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
  /** Hosts that answer 403 (like the sandbox egress proxy). */
  blockedHosts?: string[];
  /** Hosts that answer 503. */
  failingHosts?: string[];
  /** Respond 429 to the first N Yahoo requests. */
  rateLimitFirst?: number;
  /** Yahoo's full split-history call (interval=3mo&events=splits) answers 503. */
  failSplitHistory?: boolean;
  /** Custom routes tried first; return undefined to fall through. */
  routes?: (url: URL) => Response | undefined;
}

export interface FakeFetch extends FetchLike {
  calls: string[];
}

export function json(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function text(body: string, type = 'text/plain'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': type } });
}

function emptySplits(symbol: string): unknown {
  return { chart: { result: [{ meta: { symbol, currency: 'USD', exchangeTimezoneName: 'America/New_York', gmtoffset: -14400 }, timestamp: [], indicators: { quote: [{ close: [] }] } }], error: null } };
}

/** NVDA: one response with the Jan-2024 window and the June-2024 split window. */
function nvdaMerged(): unknown {
  const a = fixtureJson('yahoo/chart-NVDA-presplit-1d.json');
  const b = fixtureJson('yahoo/chart-NVDA-split-1d.json');
  const ra = a.chart.result[0];
  const rb = b.chart.result[0];
  rb.timestamp = [...ra.timestamp, ...rb.timestamp];
  for (const k of Object.keys(rb.indicators.quote[0])) rb.indicators.quote[0][k] = [...(ra.indicators.quote[0][k] ?? ra.timestamp.map(() => null)), ...rb.indicators.quote[0][k]];
  delete rb.indicators.adjclose;
  return b;
}

const exists = (p: string) => existsSync(join(FIXTURES, p));

export function createFakeFetch(opts: FakeFetchOptions = {}): FakeFetch {
  let limited = 0;
  const calls: string[] = [];
  const f = (async (input: string) => {
    const url = new URL(input);
    calls.push(input);
    const custom = opts.routes?.(url);
    if (custom) return custom;
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
        return exists(p) ? json(fixture(p)) : json({ quotes: [] });
      }
      const m = /^\/v8\/finance\/chart\/(.+)$/.exec(url.pathname);
      if (m) {
        const symbol = decodeURIComponent(m[1]!);
        if (symbol === '^COLCAP' || symbol === 'NOPE.SA') return json(fixture('yahoo/chart-notfound.json'), 404);
        if (url.searchParams.get('interval') === '3mo') {
          if (opts.failSplitHistory) return new Response('boom', { status: 503 });
          const p = `yahoo/splits-${symbol}.json`;
          return exists(p) ? json(fixture(p)) : json(emptySplits(symbol));
        }
        if (url.searchParams.get('range') === '1d') {
          const p = `yahoo/quote-${symbol}.json`;
          return exists(p) ? json(fixture(p)) : json(fixture('yahoo/chart-notfound.json'), 404);
        }
        if (symbol === 'NVDA') return json(nvdaMerged());
        const p = `yahoo/chart-${symbol}-1d.json`;
        if (exists(p)) return json(fixture(p));
        return json(fixture('yahoo/chart-notfound.json'), 404);
      }
    }
    if (url.host === 'www.datos.gov.co') {
      if (url.pathname.includes('32sa-8pi3')) return json(fixture('banrep/trm-2025-01-04.json'));
      if (url.pathname.includes('qhpu-8ixx')) {
        const sel = url.searchParams.get('$select') ?? '';
        return json(fixture(sel.includes('max(fecha_corte)') ? 'superfin/fic-search-fiducuenta.json' : 'superfin/fic-history-5-31-2852-800.json'));
      }
      if (url.pathname.includes('uawh-cjvi')) {
        const sel = url.searchParams.get('$select') ?? '';
        return json(fixture(sel.includes('max(fecha)') ? 'superfin/afp-funds.json' : 'superfin/afp-history-3-1000.json'));
      }
      return json([]);
    }
    if (url.host === 'totoro.banrep.gov.co') {
      const df = /ESTAT,(DF_[A-Z_]+),/.exec(url.pathname)?.[1];
      const p = `banrep-sdmx/${df}.xml`;
      return df && exists(p) ? text(fixture(p), 'application/xml') : new Response('not found', { status: 404 });
    }
    if (url.host === 'olinda.bcb.gov.br') {
      if (url.pathname.includes('CotacaoDolarPeriodo')) return json(fixture('bcb/ptax-usd-2025-01.json'));
      if (url.pathname.includes('CotacaoMoedaPeriodo') && decodeURIComponent(url.search).includes("'EUR'")) return json(fixture('bcb/ptax-eur-2025-01.json'));
      return json({ value: [] });
    }
    if (url.host === 'api.bcb.gov.br') {
      const code = /bcdata\.sgs\.(\d+)\//.exec(url.pathname)?.[1];
      const file = ['bcb/sgs-1-2025-01.json', 'bcb/sgs-10813-2025-01.json', 'bcb/sgs-21619-2025-01.json', 'bcb/sgs-12-2025-01.json', 'bcb/sgs-11-2025-01.json', 'bcb/sgs-4389-2025-01.json', 'bcb/sgs-433-2024-2025.json'].find(
        (x) => x.startsWith(`bcb/sgs-${code}-`),
      );
      return file ? json(fixture(file)) : json([]);
    }
    if (url.host === 'data-api.ecb.europa.eu') {
      if (url.pathname.includes('/ICP/')) return text(fixture('ecb/icp-hicp.csv'), 'text/csv');
      const csv = fixture('ecb/exr-d-2025-01.csv');
      const key = url.pathname.split('/').pop() ?? '';
      const wanted = (key.split('.')[1] ?? '').split('+');
      const lines = csv.split('\r\n');
      const filtered = [lines[0], ...lines.slice(1).filter((l) => wanted.some((c) => l.startsWith(`EXR.D.${c}.`)))];
      return text(filtered.join('\r\n'), 'text/csv');
    }
    if (url.host === 'fred.stlouisfed.org') return text(fixture('fred/CPIAUCSL.csv'), 'text/csv');
    if (url.host === 'www.tesourotransparente.gov.br') return text(fixture('tesouro/PrecoTaxaTesouroDireto.csv'), 'text/csv');
    if (url.host === 'brapi.dev') {
      return url.pathname.endsWith('/PETR4') ? json(fixture('keyed/brapi-PETR4.json')) : json({ error: true, message: 'not found' }, 404);
    }
    if (url.host === 'stooq.com') return text(fixture('keyed/stooq-aapl.us.csv'), 'text/csv');
    if (url.host === 'financialmodelingprep.com') return json(fixture('keyed/fmp-AAPL.json'));
    if (url.host === 'eodhd.com') return json(fixture('keyed/eodhd-AAPL.US.json'));
    if (url.host === 'www.alphavantage.co') return json(fixture('keyed/alphavantage-AAPL.json'));
    if (url.host === 'api.twelvedata.com') return json(fixture('keyed/twelvedata-AAPL.json'));
    if (url.host === 'api.coingecko.com') return json(fixture('coingecko/market_chart-bitcoin-usd-30.json'));
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
