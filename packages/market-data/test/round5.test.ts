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

/** A COTAHIST quote record, field by field as in B3's layout (245 chars). */
function cotahistLine(o: { date: string; ticker: string; market?: string; closeCents: number; factor?: number; isin?: string }): string {
  const n = (v: number, w: number) => String(v).padStart(w, '0');
  const a = (v: string, w: number) => v.padEnd(w, ' ');
  const price = n(o.closeCents, 13);
  const line =
    '01' + o.date.replaceAll('-', '') + '02' + a(o.ticker, 12) + (o.market ?? '010') + a('BRF SA', 12) + a('ON NM', 10) + a('', 3) + 'R$  ' +
    price + price + price + price + price + price + price + // PREABE PREMAX PREMIN PREMED PREULT PREOFC PREOFV
    n(150, 5) + n(1_000_000, 18) + n(2_000_000_000, 18) + n(0, 13) + '0' + '99991231' + n(o.factor ?? 1, 7) + n(0, 13) + a(o.isin ?? 'BRBRFSACNOR8', 12) + '102';
  expect(line).toHaveLength(245);
  return line;
}

describe('M29 frozen histories from B3 official COTAHIST files', () => {
  it('reads the cash-market closes of the exact ticker (factor applied, odd lots and other tickers ignored)', async () => {
    const { pointsFromCotahist, parseCotahistLine } = await import('../scripts/record-frozen');
    const text = [
      '00COTAHIST.2025BOVESPA 20251231'.padEnd(245, ' '),
      cotahistLine({ date: '2025-09-19', ticker: 'BRFS3', closeCents: 2150 }),
      cotahistLine({ date: '2025-09-19', ticker: 'BRFS3F', market: '020', closeCents: 2151 }), // odd lot
      cotahistLine({ date: '2025-09-19', ticker: 'BRFS3', market: '020', closeCents: 2152 }),
      cotahistLine({ date: '2025-09-22', ticker: 'BRFS3', closeCents: 2110 }),
      cotahistLine({ date: '2025-09-22', ticker: 'MRFG3', closeCents: 1500 }),
      cotahistLine({ date: '2003-01-02', ticker: 'BRFS3', closeCents: 4_500_000, factor: 1000 }), // quoted per 1000 shares
      '99COTAHIST.2025BOVESPA 20251231000000004'.padEnd(245, ' '),
    ].join('\r\n');
    expect(pointsFromCotahist(text, 'brfs3')).toEqual([
      { date: '2025-09-19', close: 21.5 },
      { date: '2025-09-22', close: 21.1 },
      { date: '2003-01-02', close: 45 },
    ]);
    expect(parseCotahistLine(cotahistLine({ date: '2025-09-22', ticker: 'BRFS3', closeCents: 2110 }))).toMatchObject({ isin: 'BRBRFSACNOR8', volume: 1_000_000, market: '010' });
    expect(parseCotahistLine('00header')).toBeUndefined();
  });
});

describe('M2 the snapshot also covers instruments requested outside the catalog', () => {
  it('a BVC stock requested once (not in the catalog) is recorded by later snapshot runs, across restarts', async () => {
    const store = new MemoryStore();
    const opts = () => ({ cache: new TieredCache({ store, now: () => NOW.getTime() }) });
    const a = createTestService({ routes: thinRoutes() }, opts()).service;
    await a.history({ symbol: 'THIN.CL', from: '2023-03-01', to: '2023-06-30' });
    const tracked = store.data.get('snapshot:tracked:v1')?.value;
    expect(tracked).toEqual(['XBOG:THIN']);
    const b = createTestService({ routes: thinRoutes() }, opts()).service; // restarted server, same store
    const withTracked = await b.recordSnapshot(['XBOG'], { from: '2023-01-01' });
    const c = createTestService({ routes: thinRoutes() }, { cache: new TieredCache({ store: new MemoryStore(), now: () => NOW.getTime() }) }).service;
    const catalogOnly = await c.recordSnapshot(['XBOG'], { from: '2023-01-01' });
    expect(withTracked.ok).toBe(catalogOnly.ok + 1);
    expect(store.data.get('snapshot:tracked:v1')?.value).toEqual(['XBOG:THIN']); // catalog ids are not tracked
  });
});

describe('M8 declared-dividend calendar: BVC payment dates and installments', () => {
  const calendar = [
    { instrumentId: 'XBOG:ECOPETROL', exDate: '2025-04-01', payDate: '2025-04-08', amount: 107, note: 'cuota 1 de 3' },
    { instrumentId: 'xbog:ecopetrol', exDate: '2025-04-23', payDate: '2025-04-30', amount: 107, note: 'cuota 2 de 3' },
    { instrumentId: 'XBOG:ECOPETROL', exDate: '2025-04-28', payDate: '2025-05-15', amount: 50, note: 'cuota 3 de 3' },
    { instrumentId: 'XBOG:ECOPETROL', exDate: '2025-08-01', payDate: '2025-08-15', amount: 10 }, // outside the range
  ];

  it('payment dates are added to the provider dividends, a missing installment is added, ex-dates stay the provider\'s', async () => {
    const { service } = createTestService({}, { dividendCalendar: calendar as never });
    const h = await service.history({ symbol: 'ECOPETROL', from: '2025-01-01', to: '2025-04-30' });
    const divs = h.actions.filter((a) => a.type === 'DIVIDEND');
    expect(divs).toHaveLength(3);
    expect(divs[0]).toMatchObject({ amountPerShare: 107, payDate: '2025-04-08', note: 'cuota 1 de 3' });
    expect(divs[0]!.date).toBe(divs[0]!.exDate);
    expect(divs[0]!.date >= '2025-03-29' && divs[0]!.date <= '2025-04-01').toBe(true);
    expect(divs[1]).toMatchObject({ amountPerShare: 107, payDate: '2025-04-30' });
    expect(divs[2]).toMatchObject({ date: '2025-04-28', amountPerShare: 50, payDate: '2025-05-15', note: expect.stringMatching(/cuota 3 de 3; declared/) });
  });

  it('invalid calendars are rejected at startup', async () => {
    const { validateDeclaredDividends } = await import('../src/index');
    expect(() => validateDeclaredDividends({})).toThrow(/array/);
    expect(() => validateDeclaredDividends([{ instrumentId: 'XBOG:ECOPETROL', exDate: '2025-04-01', payDate: '2025-03-01', amount: 1 }])).toThrow(/entry 0/);
    expect(() => validateDeclaredDividends([{ instrumentId: 'XBOG:ECOPETROL', exDate: '2025-04-01', amount: 0 }])).toThrow(/entry 0/);
  });
});
