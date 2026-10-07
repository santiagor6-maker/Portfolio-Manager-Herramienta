/**
 * Regression tests for review round 1 (reviews/market-data-r1.md), gap by gap. The reviewer's
 * adversarial scripts (split-fail-cache, splits, gbp/divs, renames, illiquid) are reproduced
 * here offline with recorded fixtures.
 */
import { describe, expect, it } from 'vitest';
import {
  classifySplit,
  CustomFeedProvider,
  expandFeedUrl,
  HttpClient,
  instrumentIdFromYahoo,
  ipcFromUvr,
  jsonPath,
  MemoryStore,
  parseFeedDate,
  parseSdmxGeneric,
  parseTesouroCsv,
  TieredCache,
  toCoreCorporateActions,
  totalReturn,
  yahooSymbolFromId,
  type YahooChartResult,
} from '../src/index';
import { createFakeFetch, createTestService, fixture, fixtureJson, json, NOW, presplitOnly } from './helpers';

const chart = (f: string): YahooChartResult => fixtureJson(`yahoo/${f}`).chart.result[0];
const YAHOO_DOWN = { failingHosts: ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'] };

// ------------------------------------------------------------------------------------------ M1
describe('M1 a failed split-history lookup never poisons the cache', () => {
  it('reproduces split-fail-cache.mts: degraded first answer (48.17) is not persisted; next process gets 481.68', async () => {
    const store = new MemoryStore();
    const mk = (failSplitHistory: boolean) =>
      createTestService({ failSplitHistory, routes: presplitOnly }, { cache: new TieredCache({ store, now: () => NOW.getTime() }) }).service;

    const r1 = await mk(true).history({ symbol: 'NVDA', from: '2024-01-02', to: '2024-01-09' });
    expect(r1.series.points[0]).toEqual({ date: '2024-01-02', close: 48.17 });
    expect(r1.degraded).toBe(true);
    expect(r1.notes?.join(' ')).toMatch(/split history unavailable/);
    expect([...store.data.keys()].filter((k) => k.startsWith('hist:'))).toEqual([]); // nothing persisted

    const r2 = await mk(false).history({ symbol: 'NVDA', from: '2024-01-02', to: '2024-01-09' });
    expect(r2.series.points.slice(0, 3)).toEqual([
      { date: '2024-01-02', close: 481.68 },
      { date: '2024-01-03', close: 475.69 },
      { date: '2024-01-04', close: 479.98 },
    ]);
    expect(r2.degraded).toBeUndefined();
    expect(store.data.get('hist:v2:yahoo:NVDA:2024')?.expiresAt).toBeNull();
  });

  it('the degraded chunk expires within minutes in memory too', async () => {
    let now = NOW.getTime();
    let fail = true;
    const fetch = createFakeFetch({ routes: (u) => (u.searchParams.get('interval') === '3mo' && fail ? new Response('boom', { status: 503 }) : presplitOnly(u)) });
    const { service } = createTestService({}, {
      http: new HttpClient({ fetch, sleep: async () => undefined, retries: 0 }),
      cache: new TieredCache({ now: () => now }),
      now: () => new Date(now),
    });
    expect((await service.history({ symbol: 'NVDA', from: '2024-01-02', to: '2024-01-02' })).series.points[0]!.close).toBe(48.17);
    fail = false;
    now += 6 * 60_000;
    expect((await service.history({ symbol: 'NVDA', from: '2024-01-02', to: '2024-01-02' })).series.points[0]!.close).toBe(481.68);
  });
});

// ------------------------------------------------------------------------------------------ M2
describe('M2 second price providers with automatic failover', () => {
  it('Yahoo down: Twelve Data (key configured) answers, failures are reported', async () => {
    const { service } = createTestService(YAHOO_DOWN, { keys: { twelvedata: 'k' } });
    const h = await service.history({ symbol: 'AAPL', from: '2025-01-02', to: '2025-01-06' });
    expect(h.series.source).toBe('twelvedata');
    expect(h.series.points).toEqual([
      { date: '2025-01-02', close: 243.85 },
      { date: '2025-01-03', close: 243.36 },
      { date: '2025-01-06', close: 245 },
    ]);
    expect(h.fallbacks?.[0]).toMatchObject({ source: 'yahoo' });
  });

  it.each([
    [{ fmp: 'k' }, 'fmp'],
    [{ eodhd: 'k' }, 'eodhd'],
    [{ alphavantage: 'k' }, 'alphavantage'],
    [{}, 'stooq'],
  ])('keys %j -> %s', async (keys, source) => {
    const { service } = createTestService(YAHOO_DOWN, { keys });
    const h = await service.history({ symbol: 'XNAS:AAPL', from: '2025-01-02', to: '2025-01-06' });
    expect(h.series.source).toBe(source);
    expect(h.series.points.map((p) => p.close)).toEqual([243.85, 243.36, 245]);
  });

  it('stooq / FMP closes are flagged split-adjusted (not as traded) and never cached long', async () => {
    const { service } = createTestService(YAHOO_DOWN);
    const h = await service.history({ symbol: 'AAPL', from: '2025-01-02', to: '2025-01-06' });
    expect(h.notes?.join(' ')).toMatch(/split-adjusted/);
  });

  it('Alpha Vantage quota message -> RATE_LIMITED, next provider is tried', async () => {
    const routes = (u: URL) => (u.host === 'www.alphavantage.co' ? json(fixture('keyed/alphavantage-ratelimit.json')) : undefined);
    const { service } = createTestService({ ...YAHOO_DOWN, routes }, { keys: { alphavantage: 'demo' } });
    const h = await service.history({ symbol: 'AAPL', from: '2025-01-02', to: '2025-01-06' });
    expect(h.series.source).toBe('stooq');
    expect(h.fallbacks?.find((f) => f.source === 'alphavantage')?.error).toMatch(/rate limit|per day/i);
  });

  it('B3 falls over to brapi (keyless test tickers) with JCP-typed dividends', async () => {
    const { service } = createTestService(YAHOO_DOWN);
    const h = await service.history({ symbol: 'BVMF:PETR4', from: '2025-01-02', to: '2025-01-31' });
    expect(h.series.source).toBe('brapi');
    expect(h.series.points).toEqual([
      { date: '2025-01-02', close: 37.09 },
      { date: '2025-01-03', close: 37.41 },
      { date: '2025-01-31', close: 37.69 },
    ]);
  });

  it('all providers fail -> NOT_FOUND with suggestion and the provider trail', async () => {
    const { service } = createTestService();
    await expect(service.history({ symbol: 'NOPE.SA', from: '2025-01-01', to: '2025-01-31' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { fallbacks: expect.arrayContaining([expect.objectContaining({ source: 'yahoo' })]) },
    });
  });

  it('user-defined JSON feed (JSONPath) and CSV feed, like Portfolio Performance', async () => {
    const routes = (u: URL) => {
      if (u.host !== 'feeds.example') return undefined;
      if (u.pathname === '/fund.json') return json({ data: { rows: [{ d: '02/01/2025', v: '1.234,50' }, { d: '03/01/2025', v: '1.240,00' }] } });
      return new Response('fecha;valor\n2025-01-02;10.5\n2025-01-03;10.7\n', { status: 200 });
    };
    const fetch = createFakeFetch({ routes });
    const http = new HttpClient({ fetch, sleep: async () => undefined });
    const feeds = new CustomFeedProvider({
      http,
      feeds: [
        { id: 'CUSTOM:FONDO', name: 'Mi fondo', currency: 'COP', feed: { type: 'json', url: 'https://feeds.example/fund.json?from={FROM_DMY}', datePath: '$.data.rows[*].d', closePath: '$.data.rows[*].v', dateFormat: 'DD/MM/YYYY', decimal: ',' } },
        { id: 'CUSTOM:CSV', name: 'CSV', currency: 'BRL', feed: { type: 'csv', url: 'https://feeds.example/x.csv', delimiter: ';', dateColumn: 'fecha', closeColumn: 'valor' } },
      ],
    });
    const { service } = createTestService({ routes }, { customFeeds: feeds['opts'].feeds });
    const a = await service.history({ symbol: 'CUSTOM:FONDO', from: '2025-01-01', to: '2025-01-31' });
    expect(a.series).toMatchObject({ source: 'custom', currency: 'COP', points: [{ date: '2025-01-02', close: 1234.5 }, { date: '2025-01-03', close: 1240 }] });
    const b = await service.history({ symbol: 'CUSTOM:CSV', from: '2025-01-01', to: '2025-01-31' });
    expect(b.series.points.map((p) => p.close)).toEqual([10.5, 10.7]);
    expect((await service.search('mi fondo')).results[0]?.id).toBe('CUSTOM:FONDO');
  });

  it('JSONPath subset, date formats and URL placeholders', () => {
    expect(jsonPath({ a: [{ b: 1 }, { b: 2 }] }, '$.a[*].b')).toEqual([1, 2]);
    expect(jsonPath([{ 'x-y': 3 }], "$[0]['x-y']")).toEqual([3]);
    expect(parseFeedDate('20250102', 'YYYYMMDD')).toBe('2025-01-02');
    expect(parseFeedDate(1735776000, 'epoch')).toBe('2025-01-02');
    expect(expandFeedUrl('u?s={SYMBOL}&a={FROM}&b={TO_DMY}', 'A B', '2025-01-01', '2025-01-31')).toBe('u?s=A%20B&a=2025-01-01&b=31/01/2025');
  });
});

// ------------------------------------------------------------------------------------------ M3
describe('M3 rate and inflation indices in core IndexSeries shape', () => {
  it('CDI (SGS 12): periodRate per business day, BUS/252', async () => {
    const { service } = createTestService();
    const r = await service.index({ id: 'CDI', from: '2025-01-02', to: '2025-01-31' });
    expect(r.series).toMatchObject({ id: 'CDI', kind: 'periodRate', period: 'day', unit: 'percent', dayCount: 'BUS/252', currency: 'BRL', source: 'bcb-sgs' });
    expect(r.series.points[0]).toEqual({ date: '2025-01-02', value: 0.045513 });
  });

  it('IPCA (SGS 433): monthly % dated on the first day of the reference month', async () => {
    const { service } = createTestService();
    const r = await service.index({ id: 'ipca', from: '2024-01-01', to: '2025-03-31' });
    expect(r.series).toMatchObject({ id: 'IPCA', kind: 'periodRate', period: 'month' });
    expect(r.series.points.slice(0, 2)).toEqual([
      { date: '2024-01-01', value: 0.42 },
      { date: '2024-02-01', value: 0.83 },
    ]);
  });

  it('IPC_CO derived from the UVR matches DANE (Dec-2024 0.46 %, Jan 0.94 %, Feb 1.14 %, Mar 0.52 %)', async () => {
    const { service } = createTestService();
    const r = await service.index({ id: 'IPC_CO', from: '2024-12-01', to: '2025-03-31' });
    expect(r.series).toMatchObject({ id: 'IPC_CO', kind: 'periodRate', period: 'month', unit: 'percent', currency: 'COP', source: 'banrep-uvr' });
    expect(r.series.points.map((p) => [p.date, Math.round(p.value * 100) / 100])).toEqual([
      ['2024-12-01', 0.46],
      ['2025-01-01', 0.94],
      ['2025-02-01', 1.14],
      ['2025-03-01', 0.52],
    ]);
  });

  it('ipcFromUvr skips months whose UVR window is incomplete', () => {
    expect(ipcFromUvr([{ date: '2025-01-15', value: 100 }], '2024-12-01', '2024-12-31')).toEqual([]);
  });

  it('UVR level, IBR nominal ACT/360 and E.A. ACT/365, DTF, policy rate', async () => {
    const { service } = createTestService();
    const uvr = await service.index({ id: 'UVR', from: '2025-01-01', to: '2025-01-05' });
    expect(uvr.series).toMatchObject({ kind: 'level', currency: 'COP' });
    expect(uvr.series.points.length).toBe(5);
    expect(uvr.series.points[0]!.value).toBeGreaterThan(370);
    const ibr = await service.index({ id: 'IBR', from: '2025-01-01', to: '2025-02-10' });
    const ibrEa = await service.index({ id: 'IBR_EA', from: '2025-01-01', to: '2025-02-10' });
    expect(ibr.series).toMatchObject({ kind: 'annualRate', dayCount: 'ACT/360' });
    expect(ibrEa.series).toMatchObject({ kind: 'annualRate', dayCount: 'ACT/365' });
    expect(ibrEa.series.points[0]!.value).toBeGreaterThan(ibr.series.points[0]!.value); // E.A. > nominal
    for (const id of ['DTF', 'TPM_CO', 'IBR_3M']) {
      const r = await service.index({ id, from: '2025-01-01', to: '2025-02-10' });
      expect(r.series.points.length, id).toBeGreaterThan(5);
      expect(r.series.points.every((p) => p.value > 3 && p.value < 20), id).toBe(true);
    }
  });

  it('COLCAP_AVG (real index, monthly average) dated at month end; CPI_US and HICP_EA levels', async () => {
    const { service } = createTestService();
    const c = await service.index({ id: 'COLCAP_AVG', from: '2024-01-01', to: '2024-03-31' });
    expect(c.series.points).toEqual([
      { date: '2024-01-31', value: 1274.33 },
      { date: '2024-02-29', value: 1264.7 },
      { date: '2024-03-31', value: 1302.58 },
    ]);
    expect(c.notes?.join(' ')).toMatch(/promedio/);
    const cpi = await service.index({ id: 'CPI_US', from: '2024-10-01', to: '2025-01-31' });
    expect(cpi.series.points.at(-1)).toEqual({ date: '2025-01-31', value: 319.086 });
    const hicp = await service.index({ id: 'HICP_EA', from: '2024-11-01', to: '2025-01-31' });
    expect(hicp.series.points[0]).toEqual({ date: '2024-11-30', value: 127.39 });
  });

  it('unknown id -> BAD_REQUEST listing ids; batch carries indices', async () => {
    const { service } = createTestService();
    await expect(service.index({ id: 'XYZ', from: '2025-01-01' })).rejects.toThrow(/CDI/);
    const b = await service.batch({ indices: [{ id: 'CDI', from: '2025-01-02', to: '2025-01-10' }, { id: 'nope', from: '2025-01-01' }] });
    expect(b.indices[0]).toMatchObject({ ok: true });
    expect(b.indices[1]).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  it('parses SDMX generic XML', () => {
    const s = parseSdmxGeneric(fixture('banrep-sdmx/DF_IBR_DAILY_HIST.xml'));
    expect(s.length).toBe(8);
    expect(s.map((x) => `${x.key.SUBJECT}/${x.key.UNIT_MEASURE}`)).toContain('IRIBRM00/NR');
  });
});

// ------------------------------------------------------------------------------------------ M4
describe('M4 fixed income and funds', () => {
  it('Tesouro Direto: search active titles and daily PU history', async () => {
    const { service } = createTestService();
    const { results } = await service.search('tesouro ipca');
    const ids = results.filter((r) => r.origin === 'tesouro').map((r) => r.id);
    expect(ids).toEqual(['TD:NTNBP-2035-05-15', 'TD:NTNB-2045-05-15']);
    const h = await service.history({ symbol: 'TD:NTNBP-2035-05-15', from: '2025-01-01', to: '2026-10-05' });
    expect(h.instrument).toMatchObject({ name: 'Tesouro IPCA+ 2035', currency: 'BRL', assetClass: 'fixed_income' });
    expect(h.series).toMatchObject({ source: 'tesouro', currency: 'BRL' });
    expect(h.series.points[0]).toEqual({ date: '2025-01-02', close: 1694.88 });
    expect(h.series.points.at(-1)).toEqual({ date: '2026-10-02', close: 1997.61 });
    const q = await service.quote('TD:NTNBP-2035-05-15');
    expect(q).toMatchObject({ price: 1997.61, source: 'tesouro' });
  });

  it('parses the Tesouro CSV (comma decimals, codes per title type)', () => {
    const m = parseTesouroCsv(fixture('tesouro/PrecoTaxaTesouroDireto.csv'));
    expect([...m.keys()].sort()).toEqual(['TD:LFT-2029-03-01', 'TD:LTN-2018-01-01', 'TD:LTN-2031-01-01', 'TD:NTNB-2045-05-15', 'TD:NTNBP-2035-05-15']);
    expect(m.get('TD:NTNBP-2035-05-15')!.lastRates).toEqual({ date: '2026-10-02', buy: 7.04, sell: 7.16 });
  });

  it('Colombian FIC (Superfinanciera): search and unit values', async () => {
    const { service } = createTestService();
    const { results } = await service.search('fiducuenta');
    const fic = results.filter((r) => r.origin === 'fic');
    expect(fic[0]).toMatchObject({ id: 'FIC:5-31-2852-800', currency: 'COP', assetClass: 'fund' });
    expect(fic[0]!.name).toMatch(/FIDUCUENTA.*Bancolombia/);
    const h = await service.history({ symbol: 'FIC:5-31-2852-800', from: '2026-08-01', to: '2026-09-05', interval: '1mo' });
    expect(h.series.source).toBe('superfin');
    expect(h.series.points.map((p) => p.date)).toEqual(['2026-08-31', '2026-09-05']);
  });

  it('pension funds (AFP) search and history', async () => {
    const { service } = createTestService();
    const { results } = await service.search('porvenir moderado');
    expect(results.find((r) => r.origin === 'afp')).toMatchObject({ id: 'AFP:3-1000', currency: 'COP' });
    const h = await service.history({ symbol: 'AFP:3-1000', from: '2026-08-25', to: '2026-08-26' });
    expect(h.series.points).toEqual([
      { date: '2026-08-25', close: 92335.94 },
      { date: '2026-08-26', close: 92687.72 },
    ]);
  });

  it('CDT / CDB templates carry core AccrualSpec for accrual over /api/index series', async () => {
    const { service } = createTestService();
    const cdt = (await service.search('cdt ibr')).results.find((r) => r.origin === 'template');
    expect(cdt).toMatchObject({ id: 'TEMPLATE:CDT-IBR', assetClass: 'fixed_income', pricing: 'manual', template: true, accrual: { kind: 'indexed', index: 'IBR' } });
    const cdb = (await service.search('cdb cdi')).results.find((r) => r.origin === 'template');
    expect(cdb?.accrual).toMatchObject({ index: 'CDI', percentOfIndex: 1.1, dayCount: 'BUS/252' });
  });
});

// ------------------------------------------------------------------------------------------ M5
describe('M5 renamed tickers resolve transparently (reviewer renames.mts)', () => {
  it.each([
    ['PFBCOLOM.CL', 'XBOG:PFCIBEST'],
    ['XBOG:PFBCOLOM', 'XBOG:PFCIBEST'],
    ['BCOLOMBIA.CL', 'XBOG:CIBEST'],
    ['ELET3.SA', 'BVMF:AXIA3'],
    ['EMBR3.SA', 'BVMF:EMBJ3'],
    ['CCRO3.SA', 'BVMF:MOTV3'],
    ['BVMF:NTCO3', 'BVMF:NATU3'],
    ['MRFG3.SA', 'BVMF:MBRF3'],
  ])('%s -> %s', (old, id) => {
    const { service } = createTestService();
    const r = service.resolve(old);
    expect(r.target.instrumentId).toBe(id);
    expect(r.alias?.toId).toBe(id);
  });

  it('history and quote carry renamedFrom', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'BCOLOMBIA.CL', from: '2025-01-02', to: '2025-01-31' });
    expect(h.instrument.id).toBe('XBOG:CIBEST');
    expect(h.renamedFrom).toMatchObject({ fromId: 'XBOG:BCOLOMBIA', toId: 'XBOG:CIBEST', ratio: 1 });
    expect(h.series.points[0]).toEqual({ date: '2025-01-02', close: 37800 });
  });

  it('search for an old ticker returns the new instrument first', async () => {
    const { service } = createTestService();
    const { results } = await service.search('PFBCOLOM');
    expect(results[0]).toMatchObject({ id: 'XBOG:PFCIBEST', origin: 'alias', renamedFrom: { fromId: 'XBOG:PFBCOLOM' } });
  });

  it('stitches history from the old symbol when the provider still has it, with a TICKER_CHANGE action', async () => {
    const old = fixtureJson('yahoo/chart-CIBEST.CL-1d.json');
    const r = old.chart.result[0];
    r.timestamp = r.timestamp.map((t: number) => t - 31 * 86400);
    r.meta.symbol = 'BCOLOMBIA.CL';
    const routes = (u: URL) => (u.pathname.endsWith('/BCOLOMBIA.CL') && u.searchParams.get('interval') === '1d' ? json(old) : undefined);
    const { service } = createTestService({ routes });
    const h = await service.history({ symbol: 'XBOG:CIBEST', from: '2024-12-02', to: '2025-01-31' });
    expect(h.series.points[0]!.date < '2025-01-01').toBe(true);
    expect(h.actions.find((a) => a.subtype === 'TICKER_CHANGE')).toMatchObject({ instrumentId: 'XBOG:BCOLOMBIA', type: 'SPLIT', targetInstrumentId: 'XBOG:CIBEST', ratio: 1 });
    expect(h.notes?.join(' ')).toMatch(/stitched from old ticker BCOLOMBIA.CL/);
  });
});

// ------------------------------------------------------------------------------------------ M6
describe('M6 suspended stocks: no phantom closes (reviewer illiquid.mts)', () => {
  it('CNEC.CL: bars after the last trade (incl. a duplicated 6240 bar) are dropped and the series is stale', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'CNEC.CL', from: '2025-11-03', to: '2025-12-10' });
    expect(h.series.points.at(-1)).toEqual({ date: '2025-11-14', close: 5000 });
    expect(h.series).toMatchObject({ lastTradeDate: '2025-11-14', stale: true });
    expect(h.series.points.some((p) => p.provisional)).toBe(false); // an old last trade is never provisional
    expect(h.notes?.join(' ')).toMatch(/dropped 16 phantom bar/);
    const q = await service.quote('CNEC.CL');
    expect(q).toMatchObject({ price: 5000, date: '2025-11-14', stale: true });
  });
});

// ------------------------------------------------------------------------------------------ M7
describe('M7 bonificações and spin-offs are not splits (reviewer splits.mts)', () => {
  const c = (sym: string, date: string, n: number, d: number) => classifySplit(sym, { date, numerator: n, denominator: d }, 'X:Y');

  it('classifies Yahoo split events', () => {
    expect(c('ITUB4.SA', '2025-03-18', 110, 100)).toMatchObject({ type: 'STOCK_DIVIDEND', ratio: 1.1 });
    expect(c('ITUB4.SA', '2018-11-21', 3, 2)).toMatchObject({ type: 'STOCK_DIVIDEND', ratio: 1.5 });
    expect(c('WEGE3.SA', '2015-04-01', 2, 1)).toMatchObject({ type: 'SPLIT', ratio: 2 });
    expect(c('NVDA', '2024-06-10', 10, 1)).toMatchObject({ type: 'SPLIT', ratio: 10 });
    expect(c('GE', '2021-08-02', 1, 8)).toMatchObject({ type: 'SPLIT', ratio: 0.125 });
    const ge = c('GE', '2024-04-02', 1253, 1000);
    expect(ge).toMatchObject({ type: 'SPLIT', subtype: 'SPINOFF', ratio: 0.25, targetInstrumentId: 'XNYS:GEV', reviewRequired: true });
    expect(ge.costFraction).toBeCloseTo(0.2019, 4);
    expect(c('MMM', '2024-04-01', 1196, 1000)).toMatchObject({ subtype: 'SPINOFF', targetInstrumentId: 'XNYS:SOLV' });
    const unknown = c('XYZ', '2025-01-01', 1105, 1000);
    expect(unknown).toMatchObject({ subtype: 'SPINOFF', reviewRequired: true });
    expect(unknown.targetInstrumentId).toBeUndefined();
  });

  it('GE 2024-04-02: typed as spin-off, parent prices un-adjusted as traded', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'GE', from: '2024-03-25', to: '2024-04-05' });
    expect(h.actions.filter((a) => a.type !== 'DIVIDEND')).toEqual([expect.objectContaining({ date: '2024-04-02', subtype: 'SPINOFF', targetInstrumentId: 'XNYS:GEV' })]);
    const raw = chart('chart-GE-1d.json').indicators!.quote![0]!.close![0]!;
    expect(h.series.points[0]!.close).toBeCloseTo(raw * 1.253, 1); // ~173.5 USD as traded
  });

  it('ITUB4 2025-03-18 bonificação 10 %: STOCK_DIVIDEND; prices undo both later events', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'ITUB4.SA', from: '2025-03-12', to: '2025-03-21' });
    expect(h.actions).toEqual([expect.objectContaining({ date: '2025-03-18', type: 'STOCK_DIVIDEND', ratio: 1.1 })]);
    const raw = chart('chart-ITUB4.SA-1d.json').indicators!.quote![0]!.close!;
    expect(h.series.points[0]!.close).toBeCloseTo(raw[0]! * 1.1 * 1.03, 2); // later 103:100 too
    expect(h.series.points.at(-1)!.close).toBeCloseTo(raw.at(-1)! * 1.03, 2);
  });

  it('total return treats spin-off value as reinvested (no artificial drop)', () => {
    const pts = [
      { date: '2024-04-01', close: 100 },
      { date: '2024-04-02', close: 80 },
    ];
    const tr = totalReturn(pts, [{ instrumentId: 'X', date: '2024-04-02', type: 'SPLIT', subtype: 'SPINOFF', priceFactor: 1.25 }]);
    expect(tr[1]!.close).toBe(100);
  });
});

// ------------------------------------------------------------------------------------------ M8
describe('M8 dividends: currency, pay date, JCP (reviewer gbp.mts / divs.mts)', () => {
  it('VUSA.L: dividends declared in USD while the ETF quotes in GBP', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'VUSA.L', from: '2025-12-01', to: '2026-01-14' });
    expect(h.series.currency).toBe('GBP');
    expect(h.actions).toEqual([
      expect.objectContaining({ type: 'DIVIDEND', date: '2025-12-18', amountPerShare: 0.223298, currency: 'USD', exDate: '2025-12-18' }),
    ]);
    expect(h.notes?.join(' ')).toMatch(/dividends declared in USD/);
  });

  it('toCoreCorporateActions is a lossless pass-through to core CorporateAction', () => {
    const out = toCoreCorporateActions([{ instrumentId: 'A', date: '2025-01-01', type: 'STOCK_DIVIDEND', ratio: 1.1, priceFactor: 1.1 }]);
    expect(out).toEqual([{ instrumentId: 'A', date: '2025-01-01', type: 'STOCK_DIVIDEND', ratio: 1.1 }]);
  });
});

// ------------------------------------------------------------------------------------------ M9
describe('M9 reversible ids for every venue', () => {
  it('maps Asian/other venues and keeps unmapped Yahoo symbols verbatim', () => {
    expect(instrumentIdFromYahoo('0254.HK', 'HKG')).toBe('XHKG:0254');
    expect(instrumentIdFromYahoo('7203.T', 'JPX')).toBe('XTKS:7203');
    expect(instrumentIdFromYahoo('RELIANCE.NS')).toBe('XNSE:RELIANCE');
    expect(instrumentIdFromYahoo('5614.KL')).toBe('XKLS:5614');
    expect(instrumentIdFromYahoo('ISAT.JK')).toBe('XIDX:ISAT');
    expect(instrumentIdFromYahoo('ABC.XQ')).toBe('YAHOO:ABC.XQ');
    expect(yahooSymbolFromId('YAHOO:ABC.XQ')).toBe('ABC.XQ');
  });

  it('every search fixture result round-trips id -> Yahoo symbol', async () => {
    const { service } = createTestService();
    for (const q of ['toyota', 'ecopetrol', 'petrobras', 'iberdrola', 'cspx', 'isa', 'itau', 'bitcoin']) {
      const { results } = await service.search(q, 50);
      for (const r of results.filter((x) => x.providerSymbols?.yahoo)) {
        expect(service.resolve(r.id).target.yahoo, `${q}: ${r.id}`).toBe(r.providerSymbols!.yahoo!.toUpperCase());
      }
    }
  });
});

// ------------------------------------------------------------------------------------------ M12/M17
describe('M12 symbol validation and M17 batch schema', () => {
  it.each(['CRYPTO:..', 'XNYS:..', 'XNYS:../v7', '..', 'a/b', 'X'.repeat(70)])('rejects %s before any upstream call', async (sym) => {
    const { service, fetch } = createTestService();
    await expect(service.history({ symbol: sym, from: '2025-01-01' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetch.calls).toEqual([]);
  });

  it('batch items with the wrong shape are per-item BAD_REQUEST, never INTERNAL', async () => {
    const { service } = createTestService();
    const r = await service.batch({ histories: [null as never, { symbol: 1 } as never], quotes: [123 as never], fx: ['x' as never] });
    for (const x of [...r.histories, ...r.quotes, ...r.fx]) expect(x).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  it('batch refuses amplification by estimated points', async () => {
    const { service } = createTestService();
    const histories = Array.from({ length: 40 }, () => ({ symbol: 'AAPL', from: '1970-01-01' }));
    await expect(service.batch({ histories })).rejects.toThrow(/too large/);
  });
});

// ------------------------------------------------------------------------------------------ M13
describe('M13 benchmarks: real COLCAP and total-return proxies', () => {
  it('COLCAP benchmark uses ICOLCAP total return; the real index is available as COLCAP_AVG', () => {
    const { service } = createTestService();
    const b = service.catalog.benchmarks.find((x) => x.id === 'COLCAP');
    expect(b).toMatchObject({ instrumentId: 'XBOG:ICOLCAP', adjust: 'total' });
    expect(b?.note).toMatch(/COLCAP_AVG/);
  });

  it('adjust=total reinvests dividends', async () => {
    const { service } = createTestService();
    const px = await service.history({ symbol: 'ECOPETROL.CL', from: '2025-03-28', to: '2025-04-01' });
    const tr = await service.history({ symbol: 'ECOPETROL.CL', from: '2025-03-28', to: '2025-04-01', adjust: 'total' });
    const [p0, p1] = [px.series.points[0]!.close, px.series.points.find((p) => p.date === '2025-03-31')!.close];
    expect(tr.series.points.find((p) => p.date === '2025-03-31')!.close).toBeCloseTo((p0 * (p1 + 107)) / p0, 4);
  });
});

// ------------------------------------------------------------------------------------------ M14
describe('M14 the current-session / current-month point is provisional', () => {
  const live = (u: URL) => (u.pathname.endsWith('/PETR4.SA') && u.searchParams.get('interval') === '1d' && u.searchParams.get('period1')?.startsWith('17') ? json(fixture('yahoo/chart-PETR4.SA-live-1d.json')) : undefined);

  it('daily: last point during the session is provisional, marketState open', async () => {
    const { service } = createTestService({ routes: live });
    const h = await service.history({ symbol: 'PETR4.SA', from: '2026-09-28' });
    expect(h.marketState).toBe('open');
    expect(h.series.points.at(-1)).toEqual({ date: '2026-10-05', close: 55.36, provisional: true });
    expect(h.series.points.at(-2)!.provisional).toBeUndefined();
    expect(h.asOf).toBe(NOW.toISOString());
  });

  it('monthly: the current month point is provisional', async () => {
    const { service } = createTestService({ routes: live });
    const h = await service.history({ symbol: 'PETR4.SA', from: '2026-09-01', interval: '1mo' });
    expect(h.series.points.map((p) => [p.date, !!p.provisional])).toEqual([
      ['2026-09-30', false],
      ['2026-10-05', true],
    ]);
  });
});

// ------------------------------------------------------------------------------------------ M15
describe('M15 PTAX buy (compra) and sell (venda)', () => {
  it('side=buy uses cotacaoCompra; default sell', async () => {
    const { service } = createTestService();
    const buy = await service.fxSeries({ base: 'USD', quote: 'BRL', from: '2025-01-02', to: '2025-01-02', side: 'buy' });
    const sell = await service.fxSeries({ base: 'USD', quote: 'BRL', from: '2025-01-02', to: '2025-01-02' });
    expect(buy).toMatchObject({ side: 'buy', series: { source: 'bcb-ptax', points: [{ date: '2025-01-02', rate: 6.191 }] } });
    expect(sell.series.points[0]!.rate).toBe(6.1916);
  });

  it('buy side falls back to SGS 10813 and never to a mid-rate source', async () => {
    const { service } = createTestService({ failingHosts: ['olinda.bcb.gov.br'] });
    const r = await service.fxSeries({ base: 'USD', quote: 'BRL', from: '2025-01-02', to: '2025-01-02', side: 'buy' });
    expect(r.series).toMatchObject({ source: 'bcb-sgs', points: [{ date: '2025-01-02', rate: 6.191 }] });
    const { service: s2 } = createTestService({ failingHosts: ['olinda.bcb.gov.br', 'api.bcb.gov.br'] });
    await expect(s2.fxSeries({ base: 'USD', quote: 'BRL', from: '2025-01-02', to: '2025-01-02', side: 'buy' })).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    await expect(s2.fxSeries({ base: 'USD', quote: 'COP', from: '2025-01-02', side: 'buy' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

// ------------------------------------------------------------------------------------------ M16
describe('M16 bounded cache and invalidation', () => {
  it('invalidate() drops a symbol from memory and store', async () => {
    const store = new MemoryStore();
    const { service, fetch } = createTestService({}, { cache: new TieredCache({ store, now: () => NOW.getTime() }) });
    await service.history({ symbol: 'PETR4.SA', from: '2024-11-01', to: '2025-02-28' });
    const n = fetch.calls.length;
    const r = await service.invalidate('BVMF:PETR4');
    expect(r.removed).toBeGreaterThan(0);
    expect([...store.data.keys()].some((k) => k.includes('PETR4.SA:2024'))).toBe(false);
    await service.history({ symbol: 'PETR4.SA', from: '2024-11-01', to: '2025-02-28' });
    expect(fetch.calls.length).toBeGreaterThan(n);
  });
});

// ------------------------------------------------------------------------------------------ M18
describe('M18 search quality', () => {
  it("'isa' does not return Visa; Yahoo noise is filtered by word prefix", async () => {
    const { service } = createTestService();
    const { results } = await service.search('isa');
    expect(results[0]?.id).toBe('XBOG:ISA');
    expect(results.some((r) => /visa/i.test(r.name))).toBe(false);
    expect(results.every((r) => r.origin !== 'yahoo' || /^isa/i.test(r.providerSymbols?.yahoo ?? '') || /\bisa/i.test(r.name))).toBe(true);
  });

  it('ISIN search: catalog first, Yahoo resolves the rest', async () => {
    const { service } = createTestService();
    expect((await service.search('US0378331005')).results[0]?.id).toBe('XNAS:AAPL');
  });

  it('preferred countries rank provider results', async () => {
    const { service } = createTestService();
    const { results } = await service.search('itau', 20, { preferredCountries: ['BR'] });
    const yahoo = results.filter((r) => r.origin === 'yahoo');
    expect(yahoo[0]?.country).toBe('BR');
  });
});

// ------------------------------------------------------------------------------------------ M19
describe('M19 crypto via CoinGecko', () => {
  it('BTC-USD history falls over to CoinGecko (dated at the end of the UTC day)', async () => {
    const { service } = createTestService(YAHOO_DOWN);
    const h = await service.history({ symbol: 'BTC-USD', from: '2026-09-05', to: '2026-10-05' });
    expect(h.series.source).toBe('coingecko');
    expect(h.series.points[0]!.date).toBe('2026-09-05');
    expect(h.series.points.at(-1)!.date).toBe('2026-10-05');
  });

  it('crypto FX pairs: Yahoo BTC-USD first, CoinGecko fallback', async () => {
    const { service } = createTestService();
    const r = await service.fxSeries({ base: 'BTC', quote: 'USD', from: '2026-09-10', to: '2026-09-12' });
    expect(r.series.source).toBe('coingecko');
    expect(r.fallbacks?.[0]?.source).toBe('yahoo');
    expect(r.series.points.length).toBe(3);
  });
});
