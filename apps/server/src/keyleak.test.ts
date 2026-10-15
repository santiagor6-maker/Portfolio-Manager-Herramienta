/** Review R6, M38: provider API keys never appear in API responses (errors included). */
import { describe, expect, it } from 'vitest';
import { HttpClient, MarketDataService, sanitizeUrl, TieredCache, type FetchLike } from '@pm/market-data';
import { createApp } from './app';

const KEYS = {
  fmp: 'FMP-SECRET-456',
  eodhd: 'EOD-SECRET-789',
  alphavantage: 'AV-SECRET-000',
  stooq: 'STOOQ-SECRET-222',
  brapi: 'BRAPI-SECRET-111',
  twelvedata: 'TD-SECRET-333',
  coingecko: 'CG-SECRET-444',
};
const SECRETS = Object.values(KEYS);

/** Yahoo down (503); every keyed provider answers 429 with a body echoing the request URL, or hangs. */
const sent: string[] = [];
function fakeFetch(mode: '429' | 'timeout'): FetchLike {
  return (async (input: string, init?: { signal?: AbortSignal }) => {
    sent.push(input);
    const url = new URL(input);
    if (url.host.endsWith('finance.yahoo.com')) return new Response('unavailable', { status: 503 });
    if (mode === 'timeout') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new DOMException('aborted', 'AbortError')));
      });
    }
    return new Response(`Too Many Requests for ${input}`, { status: 429, headers: { 'retry-after': '0' } });
  }) as FetchLike;
}

function app(mode: '429' | 'timeout') {
  const http = new HttpClient({ fetch: fakeFetch(mode), sleep: async () => undefined, retries: 1, timeoutMs: 30, defaultPolicy: { concurrency: 8, minIntervalMs: 0 } });
  const service = new MarketDataService({ http, keys: KEYS, cache: new TieredCache(), now: () => new Date('2026-10-05T15:00:00Z') });
  return createApp({ service, log: null, rateLimit: false });
}

describe('M38 provider keys never leak in error bodies', () => {
  it.each(['429', 'timeout'] as const)('every keyed provider failing with %s: no key in any response', async (mode) => {
    const a = app(mode);
    const paths = [
      '/api/history?symbol=AAPL&from=2025-01-01&to=2025-03-31', // twelvedata, fmp, eodhd, alphavantage, stooq
      '/api/history?symbol=PETR4.SA&from=2025-01-01&to=2025-03-31', // brapi + the keyed ones
      '/api/history?symbol=BTC-USD&from=2025-01-01&to=2025-03-31', // coingecko
      '/api/quote?ids=AAPL,PETR4.SA',
    ];
    for (const p of paths) {
      const res = await a.request(p);
      const text = await res.text();
      expect(res.status === 200 || res.status >= 500).toBe(true);
      for (const k of SECRETS) expect(text, `${p} leaks ${k}`).not.toContain(k);
    }
    // The keys really went upstream in the URL (so they could have leaked back). CoinGecko sends its
    // key in a header (x-cg-demo-api-key), never in the URL.
    for (const k of SECRETS.filter((x) => x !== KEYS.coingecko)) expect(sent.some((u) => u.includes(k)), `${k} never sent`).toBe(true);
    const batch = await a.request('/api/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ histories: [{ symbol: 'AAPL', from: '2025-01-01' }], quotes: ['PETR4.SA'] }) });
    const text = await batch.text();
    for (const k of SECRETS) expect(text).not.toContain(k);
  });

  it('the failures are still reported (which provider, what happened), just without the key', async () => {
    const res = await app('429').request('/api/history?symbol=AAPL&from=2025-01-01&to=2025-03-31');
    const body = (await res.json()) as { error: { details: { fallbacks: { source: string; error: string }[] } } };
    const sources = body.error.details.fallbacks.map((f) => f.source);
    expect(sources).toEqual(expect.arrayContaining(['yahoo', 'fmp', 'eodhd', 'alphavantage']));
    expect(body.error.details.fallbacks.find((f) => f.source === 'fmp')!.error).toMatch(/429/);
    expect(JSON.stringify(body)).toMatch(/\*\*\*/);
  });

  it('sanitizeUrl masks every credential parameter name, user-info, and unknown keys by value', () => {
    const s = sanitizeUrl('https://u:pw@x.example/a?symbol=AAPL&apikey=A1&api_token=B2&token=C3&apiKey=D4&key=E5&x_cg_demo_api_key=F6&$$app_token=G7&api_key=H8');
    for (const v of ['pw', 'A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8']) expect(s).not.toMatch(new RegExp(`=${v}(&|$)|:${v}@`));
    expect(s).toContain('symbol=AAPL');
    expect(sanitizeUrl('not a url ?apikey=Z9&q=1')).not.toContain('Z9');
  });
});
