/** Regression tests for review R4 (M32-M34). Fixtures only, no network. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarketDataError, MemoryStore, TieredCache, type YahooChartResult } from '../src/index';
import { createTestService, FIXTURES, json, NOW } from './helpers';

describe('M33 bare symbols from Colombian broker statements resolve through the catalog first', () => {
  it.each(['ECOPETROL', 'PFAVAL', 'GEB', 'ISA', 'NUTRESA', 'ICOLCAP', 'CEMARGOS', 'PFCIBEST', 'ecopetrol'])('%s -> XBOG', (sym) => {
    const { service } = createTestService();
    const r = service.resolve(sym);
    expect(r.target.instrumentId).toBe(`XBOG:${sym.toUpperCase()}`);
    expect(r.target.yahoo).toBe(`${sym.toUpperCase()}.CL`);
    expect(r.target.currency).toBe('COP');
  });

  it('a 6+ letter plain word outside the catalog is a BVC nemotécnico, never a US ticker', () => {
    const { service } = createTestService();
    expect(service.resolve('CORFIXYZ').target).toMatchObject({ instrumentId: 'XBOG:CORFIXYZ', yahoo: 'CORFIXYZ.CL' });
  });

  it('US tickers and dual listings keep resolving to the US listing', () => {
    const { service } = createTestService();
    expect(service.resolve('AAPL').target.instrumentId).toBe('XNAS:AAPL');
    expect(service.resolve('ASML').target.instrumentId).toBe('XNAS:ASML'); // also XAMS:ASML in the catalog
    expect(service.resolve('BRK-B').target.yahoo).toBe('BRK-B');
    expect(service.resolve('PETR4').target.instrumentId).toBe('BVMF:PETR4');
  });

  it('quote ECOPETROL (bare) is served from the BVC', async () => {
    const { service, fetch } = createTestService();
    const [q] = await service.quotes(['ECOPETROL']);
    expect(q).toMatchObject({ ok: true, data: { instrumentId: 'XBOG:ECOPETROL', currency: 'COP' } });
    expect(fetch.calls.some((u) => /chart\/ECOPETROL(\?|$)/.test(u))).toBe(false);
  });

  it('a symbol every provider lacks is NOT_FOUND (404), not UPSTREAM_ERROR, even if a backup is blocked', async () => {
    const { service } = createTestService({ blockedHosts: ['stooq.com'] });
    const err = await service.history({ symbol: 'QQXZ', from: '2025-01-01', to: '2025-03-31' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketDataError);
    expect((err as MarketDataError).code).toBe('NOT_FOUND');
  });

  it('a real outage of a backup with Yahoo down is still an UPSTREAM_ERROR', async () => {
    const { service } = createTestService({ failingHosts: ['query2.finance.yahoo.com', 'query1.finance.yahoo.com', 'stooq.com'] });
    const err = await service.history({ symbol: 'AAPL', from: '2025-01-01', to: '2025-03-31' }).catch((e: unknown) => e);
    expect((err as MarketDataError).code).toBe('UPSTREAM_ERROR');
  });
});

/** An illiquid BVC stock: trades in March and June 2023 only. */
function thinChart(firstTradeDate?: string): YahooChartResult {
  const day = (iso: string) => Date.parse(`${iso}T15:00:00Z`) / 1000;
  const bars: [string, number, number][] = [
    ['2023-03-29', 1000, 120],
    ['2023-03-30', 1020, 80],
    ['2023-06-14', 1050, 300],
    ['2023-06-15', 1060, 50],
  ];
  return {
    meta: {
      symbol: 'THIN.CL',
      currency: 'COP',
      exchangeName: 'BVC',
      exchangeTimezoneName: 'America/Bogota',
      gmtoffset: -18000,
      regularMarketTime: day('2026-10-02'),
      regularMarketPrice: 1060,
      priceHint: 2,
      ...(firstTradeDate ? { firstTradeDate: day(firstTradeDate) } : {}),
    },
    timestamp: bars.map((b) => day(b[0])),
    indicators: { quote: [{ close: bars.map((b) => b[1]), volume: bars.map((b) => b[2]) }] },
  };
}

const thinRoutes = (first?: string) => (u: URL) =>
  u.pathname.endsWith('/THIN.CL') && u.searchParams.get('interval') === '1d' ? json({ chart: { result: [thinChart(first)], error: null } }) : undefined;

describe('M32 a window without trades is seeded with the last real trade before `from`', () => {
  it('daily: April-May 2023 had no trades -> one carried point (2023-03-30, 1020)', async () => {
    const { service } = createTestService({ routes: thinRoutes() });
    const h = await service.history({ symbol: 'THIN.CL', from: '2023-04-01', to: '2023-05-31' });
    expect(h.series.points).toEqual([{ date: '2023-03-30', close: 1020, carried: true }]);
    expect(h.notes?.join(' ')).toMatch(/last trade before 2023-04-01/);
  });

  it('monthly: the window starts with the carried March close, then June', async () => {
    const { service } = createTestService({ routes: thinRoutes() });
    const h = await service.history({ symbol: 'THIN.CL', from: '2023-04-01', to: '2023-06-30', interval: '1mo' });
    expect(h.series.points).toEqual([
      { date: '2023-03-30', close: 1020, carried: true },
      { date: '2023-06-15', close: 1060 },
    ]);
  });

  it('no seed when the window starts with a trade, or before the first trade ever', async () => {
    const a = createTestService({ routes: thinRoutes() }).service;
    const h = await a.history({ symbol: 'THIN.CL', from: '2023-03-29', to: '2023-06-30' });
    expect(h.series.points.some((p) => p.carried)).toBe(false);
    const b = createTestService({ routes: thinRoutes('2023-03-29') }).service;
    const h2 = await b.history({ symbol: 'THIN.CL', from: '2023-01-01', to: '2023-03-31' });
    expect(h2.series.points[0]).toEqual({ date: '2023-03-29', close: 1000 });
  });

  it('split-adjusted output keeps the carried flag', async () => {
    const { service } = createTestService({ routes: thinRoutes() });
    const h = await service.history({ symbol: 'THIN.CL', from: '2023-04-01', to: '2023-05-31', adjust: 'splits' });
    expect(h.series.points).toEqual([{ date: '2023-03-30', close: 1020, carried: true }]);
  });
});

describe('M34 the snapshot fallback flags partial coverage', () => {
  it('only 2026 recorded, 2025-06 requested with every provider down -> partial, coverageFrom', async () => {
    const store = new MemoryStore();
    const live = JSON.parse(readFileSync(join(FIXTURES, 'yahoo/chart-PETR4.SA-live-1d.json'), 'utf8')) as unknown;
    const rec = createTestService(
      { routes: (u) => (u.pathname.endsWith('/PETR4.SA') && u.searchParams.get('interval') === '1d' ? json(live) : undefined) },
      { cache: new TieredCache({ store, now: () => NOW.getTime() }) },
    ).service;
    await rec.recordSnapshot(['BVMF'], { from: '2026-09-28' });
    const later = NOW.getTime() + 2 * 86_400_000;
    const down = createTestService(
      { failingHosts: ['query2.finance.yahoo.com', 'query1.finance.yahoo.com', 'brapi.dev'] },
      { cache: new TieredCache({ store, now: () => later }), now: () => new Date(later) },
    ).service;
    const h = await down.history({ symbol: 'PETR4.SA', from: '2025-06-01', to: '2026-10-05' });
    expect(h.series.source).toBe('snapshot');
    expect(h.series.partial).toBe(true);
    expect(h.series.coverageFrom! > '2025-06-01').toBe(true);
    expect(h.series.coverageTo).toBe('2026-10-05');
    expect(h.notes?.join(' ')).toMatch(/PARTIAL/);
    // A range the snapshot fully covers is not flagged.
    const full = await down.history({ symbol: 'PETR4.SA', from: h.series.coverageFrom!, to: '2026-10-05' });
    expect(full.series.partial).toBeUndefined();
  });
});
