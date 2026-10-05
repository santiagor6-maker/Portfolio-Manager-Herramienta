import { describe, expect, it } from 'vitest';
import {
  HttpClient,
  MarketDataError,
  repairHundredfoldGlitches,
  splitFactorAfter,
  YahooProvider,
} from '../src/index';
import { createFakeFetch, NOW } from './helpers';

function provider(opts: Parameters<typeof createFakeFetch>[0] = {}) {
  const fetch = createFakeFetch(opts);
  const http = new HttpClient({ fetch, sleep: async () => undefined, retries: 2, defaultPolicy: { concurrency: 4, minIntervalMs: 0 } });
  return { yahoo: new YahooProvider({ http, now: () => NOW }), fetch };
}

describe('Yahoo history: split un-adjustment', () => {
  it('returns as-traded closes around the NVDA 10:1 split (2024-06-10)', async () => {
    const { yahoo } = provider();
    const h = await yahoo.dailyHistory('NVDA', '2024-06-05', '2024-06-12');
    expect(h.points).toEqual([
      { date: '2024-06-05', close: 1224.4 },
      { date: '2024-06-06', close: 1209.98 },
      { date: '2024-06-07', close: 1208.88 },
      { date: '2024-06-10', close: 121.79 }, // split effective: first post-split session
      { date: '2024-06-11', close: 120.91 },
      { date: '2024-06-12', close: 125.2 },
    ]);
    expect(h.splits).toEqual([{ date: '2024-06-10', ratio: 10 }]);
    expect(h.dividends).toEqual([{ date: '2024-06-11', amount: 0.01 }]);
  });

  it('un-adjusts a range that ends BEFORE the split using the full split history', async () => {
    const { yahoo, fetch } = provider();
    const h = await yahoo.dailyHistory('NVDA', '2024-01-02', '2024-01-05');
    // Yahoo shows 48.168 (adjusted for the 2024 10:1 split); NVDA actually traded ~481.68.
    expect(h.points[0]).toEqual({ date: '2024-01-02', close: 481.68 });
    expect(h.splits).toEqual([]); // no split inside the range
    expect(fetch.calls.some((u) => u.includes('interval=3mo') && u.includes('events=splits'))).toBe(true);
  });

  it('adjust=splits keeps Yahoo split-adjusted closes', async () => {
    const { yahoo } = provider();
    const h = await yahoo.dailyHistory('NVDA', '2024-01-02', '2024-01-02', { adjust: 'splits' });
    expect(h.points).toEqual([{ date: '2024-01-02', close: 48.17 }]);
  });

  it('splitFactorAfter multiplies only later splits (incl. reverse splits)', () => {
    const s = [
      { date: '2014-02-24', ratio: 6 / 11 },
      { date: '2021-07-20', ratio: 4 },
      { date: '2024-06-10', ratio: 10 },
    ];
    expect(splitFactorAfter(s, '2024-06-10')).toBe(1);
    expect(splitFactorAfter(s, '2024-06-07')).toBe(10);
    expect(splitFactorAfter(s, '2020-01-01')).toBe(40);
    expect(splitFactorAfter(s, '2010-01-01')).toBeCloseTo((40 * 6) / 11, 10);
  });
});

describe('Yahoo history: London GBp', () => {
  it('converts pence to pounds for prices and dividends', async () => {
    const { yahoo } = provider();
    const h = await yahoo.dailyHistory('VOD.L', '2025-06-02', '2025-06-30');
    expect(h.currency).toBe('GBP');
    expect(h.points.at(-1)).toEqual({ date: '2025-06-30', close: 0.7778 });
    expect(h.dividends).toEqual([{ date: '2025-06-05', amount: 0.019542 }]);
    expect(h.notes.join(' ')).toMatch(/GBp normalized to GBP/);
  });

  it('VOD 6:11 share consolidation (2014) is undone with a fractional factor', async () => {
    const { yahoo } = provider();
    const splits = await yahoo.splits('VOD.L');
    expect(splits.find((s) => s.date.startsWith('2014'))?.ratio).toBeCloseTo(6 / 11, 10);
  });

  it('repairs isolated 100x unit glitches', () => {
    const pts = [75, 74, 76, 0.75, 75, 7600, 76, 77].map((close, i) => ({ date: `2025-01-${String(i + 1).padStart(2, '0')}`, close }));
    const r = repairHundredfoldGlitches(pts);
    expect(r.fixed).toBe(2);
    expect(r.points.map((p) => p.close)).toEqual([75, 74, 76, 75, 75, 76, 76, 77]);
  });
});

describe('Yahoo history: BVC (.CL)', () => {
  it('skips holiday null bars and keeps local dates despite the America/New_York zone', async () => {
    const { yahoo } = provider();
    const h = await yahoo.dailyHistory('ECOPETROL.CL', '2025-01-02', '2025-01-08');
    expect(h.currency).toBe('COP');
    expect(h.points.map((p) => p.date)).toEqual(['2025-01-02', '2025-01-03', '2025-01-07', '2025-01-08']); // 6-Jan Reyes holiday
    expect(h.points[0]).toEqual({ date: '2025-01-02', close: 1795 });
  });
});

describe('Yahoo quote (chart meta, no crumb)', () => {
  it('AAPL', async () => {
    const { yahoo } = provider();
    const q = await yahoo.quote('AAPL');
    expect(q).toMatchObject({ currency: 'USD', price: 333.69, previousClose: 330.32, change: 3.37, source: 'yahoo', date: '2026-10-02' });
    expect(q.changePct).toBeCloseTo(0.010202, 5);
  });
  it('VOD.L in GBP', async () => {
    const { yahoo } = provider();
    const q = await yahoo.quote('VOD.L');
    expect(q).toMatchObject({ currency: 'GBP', price: 1.2765, previousClose: 1.268 });
  });
  it('unknown symbol -> NOT_FOUND', async () => {
    const { yahoo } = provider();
    await expect(yahoo.quote('NOPE.SA')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(yahoo.dailyHistory('^COLCAP', '2025-01-01', '2025-01-31')).rejects.toBeInstanceOf(MarketDataError);
  });
});

describe('Yahoo search mapping', () => {
  it('maps exchanges to MICs and infers currency/country', async () => {
    const { yahoo } = provider();
    const r = await yahoo.search('ecopetrol');
    const by = Object.fromEntries(r.map((x) => [x.providerSymbols!.yahoo!, x]));
    expect(by['ECOPETROL.CL']).toMatchObject({ id: 'XBOG:ECOPETROL', currency: 'COP', country: 'CO', assetClass: 'equity', sector: 'Energy' });
    expect(by['EC']).toMatchObject({ id: 'XNYS:EC', currency: 'USD', country: 'US' });
    expect(by['ECHA.MU']).toMatchObject({ id: 'XMUN:ECHA', currency: 'EUR' });
    expect(by['E1CO34.SA']).toMatchObject({ id: 'BVMF:E1CO34', currency: 'BRL' });
  });
  it('ETFs on several venues', async () => {
    const { yahoo } = provider();
    const r = await yahoo.search('cspx');
    expect(r.find((x) => x.providerSymbols?.yahoo === 'CSPX.L')).toMatchObject({ id: 'XLON:CSPX', assetClass: 'etf' });
    expect(r.find((x) => x.providerSymbols?.yahoo === 'CSPX.AS')).toMatchObject({ id: 'XAMS:CSPX', currency: 'EUR' });
  });
});

describe('Yahoo 429 handling', () => {
  it('retries after 429 and succeeds', async () => {
    const { yahoo, fetch } = provider({ rateLimitFirst: 2 });
    const q = await yahoo.quote('AAPL');
    expect(q.price).toBe(333.69);
    expect(fetch.calls.length).toBe(3);
  });
});
