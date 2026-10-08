/**
 * Regression tests for review round 2 (reviews/market-data-r2.md), gap by gap.
 */
import { describe, expect, it } from 'vitest';
import {
  buildHistory,
  chunkTtl,
  couponDates,
  findAlias,
  HttpClient,
  NTNB_COUPON_FACTOR,
  NTNF_COUPON,
  ntnbVna,
  TesouroProvider,
  TieredCache,
  TTL,
  type ProviderHistory,
  type YahooChartResult,
} from '../src/index';
import { createFakeFetch, createTestService, fixtureJson, json, NOW } from './helpers';

// ------------------------------------------------------------------------------------------ M23
describe('M23 mergers and conversions never serve another company as the old one', () => {
  it('alias table distinguishes renames from mergers with verified ratios and cash', () => {
    expect(findAlias('BRFS3')).toMatchObject({ kind: 'merger', toId: 'BVMF:MBRF3', ratio: 0.8521, effective: '2025-09-23', lastTradingDay: '2025-09-22' });
    expect(findAlias('MRFG3.SA')).toMatchObject({ kind: 'rename', toId: 'BVMF:MBRF3', ratio: 1 });
    expect(findAlias('CPLE6')).toMatchObject({ kind: 'conversion', toId: 'BVMF:CPLE5', ratio: 1, effective: '2025-11-10', lastTradingDay: '2025-11-07' });
    expect(findAlias('CPLE5')).toMatchObject({ kind: 'conversion', toId: 'BVMF:CPLE3', ratio: 1, cashPerShare: 0.7749, cashPayDate: '2025-12-30', effective: '2025-12-22', lastTradingDay: '2025-12-19' });
    expect(findAlias('NTCO3')).toMatchObject({ kind: 'conversion', toId: 'BVMF:NATU3', effective: '2025-07-02' });
  });

  it('BRFS3 history is NOT Marfrig/MBRF history: empty own series + MERGER 0.8521 -> MBRF3', async () => {
    const { service, fetch } = createTestService();
    const h = await service.history({ symbol: 'BRFS3', from: '2024-01-01', to: '2025-12-31', interval: '1mo' });
    expect(h.instrument.id).toBe('BVMF:BRFS3');
    expect(h.series.points).toEqual([]);
    expect(h.series.instrumentId).toBe('BVMF:BRFS3');
    expect(h.delisted).toMatchObject({ kind: 'merger', toId: 'BVMF:MBRF3', ratio: 0.8521 });
    expect(h.actions).toEqual([
      expect.objectContaining({ instrumentId: 'BVMF:BRFS3', date: '2025-09-23', type: 'SPLIT', subtype: 'MERGER', ratio: 0.8521, targetInstrumentId: 'BVMF:MBRF3' }),
    ]);
    expect(fetch.calls.some((u) => u.includes('MBRF3') || u.includes('MRFG3'))).toBe(false);
    expect(h.renamedFrom).toBeUndefined();
  });

  it("when a provider still has the old ticker, only its own prices up to the last trading day are served", async () => {
    const old = fixtureJson('yahoo/chart-CIBEST.CL-1d.json');
    const r = old.chart.result[0];
    r.meta.symbol = 'BRFS3.SA';
    r.meta.currency = 'BRL';
    // shift Jan-2025 bars to Sep-2025 (crossing the 2025-09-22 cutoff)
    r.timestamp = r.timestamp.map((t: number) => t + 243 * 86400);
    const routes = (u: URL) => (u.pathname.endsWith('/BRFS3.SA') && u.searchParams.get('interval') === '1d' ? json(old) : undefined);
    const { service } = createTestService({ routes });
    const h = await service.history({ symbol: 'BVMF:BRFS3', from: '2025-09-01', to: '2025-10-31' });
    expect(h.series.points.length).toBeGreaterThan(5);
    expect(h.series.points.at(-1)!.date <= '2025-09-22').toBe(true);
    expect(h.actions.find((a) => a.subtype === 'MERGER')).toMatchObject({ date: '2025-09-23', ratio: 0.8521 });
  });

  it('Copel chain: CPLE6 -> CPLE5 (2025-11-10), then CPLE5 -> 1 CPLE3 + R$0.7749 (2025-12-22)', async () => {
    const { service } = createTestService();
    const c6 = await service.history({ symbol: 'CPLE6.SA', from: '2025-10-01', to: '2026-01-31' });
    expect(c6.actions).toEqual([expect.objectContaining({ type: 'SPLIT', subtype: 'MERGER', ratio: 1, targetInstrumentId: 'BVMF:CPLE5', date: '2025-11-10' })]);
    const h = await service.history({ symbol: 'CPLE5.SA', from: '2025-12-01', to: '2026-01-31' });
    expect(h.actions).toEqual([
      expect.objectContaining({ type: 'SPLIT', subtype: 'MERGER', ratio: 1, targetInstrumentId: 'BVMF:CPLE3', date: '2025-12-22' }),
      expect.objectContaining({ type: 'DIVIDEND', subtype: 'EXTRAORDINARY', amountPerShare: 0.7749, payDate: '2025-12-30', date: '2025-12-22' }),
    ]);
  });

  it('quote of a merged ticker is 410 DELISTED with the target as suggestion, never the target price', async () => {
    const { service } = createTestService();
    await expect(service.quote('BRFS3.SA')).rejects.toMatchObject({
      code: 'DELISTED',
      status: 410,
      details: { suggest: 'BVMF:MBRF3', delisted: { ratio: 0.8521 } },
    });
  });

  it('MRFG3 (the surviving company) keeps resolving to MBRF3 as a rename', () => {
    const { service } = createTestService();
    expect(service.resolve('MRFG3').target.instrumentId).toBe('BVMF:MBRF3');
  });

  it('search for BRFS3 suggests MBRF3 with an explicit merger note', async () => {
    const { service } = createTestService();
    const r = (await service.search('BRFS3')).results[0]!;
    expect(r).toMatchObject({ id: 'BVMF:MBRF3', origin: 'alias', renamedFrom: { kind: 'merger', ratio: 0.8521 } });
    expect(r.note).toMatch(/0.8521.*no es la de/);
  });
});

// ------------------------------------------------------------------------------------------ M20
describe('M20 the last session with a null close is completed from regularMarketPrice', () => {
  it('fills the bar dated at the last trade from meta', () => {
    const r: YahooChartResult = fixtureJson('yahoo/chart-PETR4.SA-live-1d.json').chart.result[0];
    r.indicators!.quote![0]!.close![r.indicators!.quote![0]!.close!.length - 1] = null;
    const h = buildHistory(r, 'PETR4.SA', '2026-09-28', '2026-10-05', []);
    expect(h.points.at(-1)).toEqual({ date: '2026-10-05', close: 55.36 });
    expect(h.notes.join(' ')).toMatch(/completed from regularMarketPrice/);
  });

  it('a null close on another day is reported as missing, not invented', () => {
    const r: YahooChartResult = fixtureJson('yahoo/chart-PETR4.SA-live-1d.json').chart.result[0];
    r.indicators!.quote![0]!.close![1] = null;
    const h = buildHistory(r, 'PETR4.SA', '2026-09-28', '2026-10-05', []);
    expect(h.missingCloseDates).toEqual(['2026-09-30']);
  });

  it('a closed year is frozen only once settled (trailing null closes wait until Jan 15)', () => {
    const base = { points: [{ date: '2025-12-30', close: 1 }], dividends: [], splits: [], notes: [], basis: 'as-traded', providerSymbol: 'X', currency: 'USD', source: 'yahoo' } as ProviderHistory;
    expect(chunkTtl(base, 2025, '2026-01-02', '2025-12-31')).toBe(12 * 3_600_000);
    expect(chunkTtl(base, 2025, '2026-01-05', '2025-12-31')).toBe(TTL.IMMUTABLE);
    const trailing = { ...base, missingCloseDates: ['2025-12-31'] };
    expect(chunkTtl(trailing, 2025, '2026-01-05', '2025-12-31')).toBe(12 * 3_600_000);
    expect(chunkTtl(trailing, 2025, '2026-01-20', '2025-12-31')).toBe(TTL.IMMUTABLE);
  });
});

// ------------------------------------------------------------------------------------------ M22
describe('M22 custom JSON feeds stay aligned when a row omits the value (datos.gov.co style)', () => {
  const rows = [
    { fecha: '2025-09-28', valor: '100' },
    { fecha: '2025-09-29' },
    { fecha: '2025-09-30', valor: '102' },
    { fecha: '2025-10-01', valor: '103' },
  ];
  const routes = (u: URL) => (u.host === 'feeds.example' ? json(rows) : undefined);
  const expected = [
    { date: '2025-09-28', close: 100 },
    { date: '2025-09-30', close: 102 },
    { date: '2025-10-01', close: 103 },
  ];

  it('rowsPath + fields mode', async () => {
    const { service } = createTestService(
      { routes },
      { customFeeds: [{ id: 'CUSTOM:F1', name: 'F1', currency: 'COP', feed: { type: 'json', url: 'https://feeds.example/a', rowsPath: '$[*]', dateField: 'fecha', closeField: 'valor' } }] },
    );
    expect((await service.history({ symbol: 'CUSTOM:F1', from: '2025-09-01', to: '2025-10-05' })).series.points).toEqual(expected);
  });

  it('parallel-paths mode keeps holes instead of shifting', async () => {
    const { service } = createTestService(
      { routes },
      { customFeeds: [{ id: 'CUSTOM:F2', name: 'F2', currency: 'COP', feed: { type: 'json', url: 'https://feeds.example/b', datePath: '$[*].fecha', closePath: '$[*].valor' } }] },
    );
    expect((await service.history({ symbol: 'CUSTOM:F2', from: '2025-09-01', to: '2025-10-05' })).series.points).toEqual(expected);
  });
});

// ------------------------------------------------------------------------------------------ M24
describe('M24 closed historical ranges of non-Yahoo sources are not "stale"', () => {
  it('FIC history for a past range is not flagged as suspended', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'FIC:5-31-2852-800', from: '2026-08-01', to: '2026-08-31' });
    expect(h.series.points.length).toBeGreaterThan(5);
    expect(h.series.stale).toBeUndefined();
    expect((h.notes ?? []).join(' ')).not.toMatch(/suspended/);
  });
});

// ------------------------------------------------------------------------------------------ M25
describe('M25 index failures map to proper errors; IPCA has a second source; last-good is served', () => {
  it('SGS blocked -> UPSTREAM_ERROR (502), never INTERNAL', async () => {
    const { service } = createTestService({ blockedHosts: ['api.bcb.gov.br'] });
    await expect(service.index({ id: 'CDI', from: '2025-01-02', to: '2025-01-10' })).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', status: 502 });
  });

  it('IPCA falls back to IBGE SIDRA when SGS fails', async () => {
    const { service } = createTestService({ blockedHosts: ['api.bcb.gov.br'] });
    const r = await service.index({ id: 'IPCA', from: '2024-01-01', to: '2024-04-30' });
    expect(r.series).toMatchObject({ id: 'IPCA', kind: 'periodRate', period: 'month', source: 'ibge-sidra' });
    expect(r.series.points).toEqual([
      { date: '2024-01-01', value: 0.42 },
      { date: '2024-02-01', value: 0.83 },
      { date: '2024-03-01', value: 0.16 },
    ]);
    expect(r.fallbacks?.[0]?.source).toBe('bcb-sgs');
  });

  it('when every source fails, the last cached observations are served with stale=true', async () => {
    const cache = new TieredCache({ now: () => NOW.getTime() });
    const ok = createTestService({}, { cache }).service;
    await ok.index({ id: 'CDI', from: '2025-01-02', to: '2025-01-31' });
    const down = createTestService({ blockedHosts: ['api.bcb.gov.br'] }, { cache }).service;
    const r = await down.index({ id: 'CDI', from: '2025-01-06', to: '2025-01-10' });
    expect(r.stale).toBe(true);
    expect(r.series.source).toMatch(/cache/);
    expect(r.series.points.map((p) => p.date)).toEqual(['2025-01-06', '2025-01-07', '2025-01-08', '2025-01-09', '2025-01-10']);
  });
});

// ------------------------------------------------------------------------------------------ M26
describe('M26 Tesouro Direto coupons', () => {
  it('coupon dates follow the maturity month (NTN-B May/Nov, Aug/Feb; NTN-F Jan/Jul), next B3 business day', () => {
    const b35 = couponDates('2035-05-15');
    expect(b35).toContain('2025-05-15');
    expect(b35).toContain('2025-11-17'); // 15-Nov-2025 is a Saturday
    expect(b35.at(-1)).toBe('2035-05-15');
    expect(couponDates('2030-08-15').filter((d) => d.startsWith('2026'))).toEqual(['2026-02-18', '2026-08-17']); // Carnival 16-17 Feb 2026
    expect(couponDates('2031-01-01').filter((d) => d.startsWith('2025'))).toEqual(['2025-01-02', '2025-07-01']); // 1-Jan holiday
  });

  it('NTN-B VNA from the IPCA (R$1000 on 2000-07-15, updated each 15th)', () => {
    const ipca = [] as { date: string; value: number }[];
    for (let y = 2000, m = 7; y < 2001 || m <= 6; ) {
      ipca.push({ date: `${y}-${String(m).padStart(2, '0')}-01`, value: 1 });
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
    expect(ntnbVna(ipca, '2000-07-15')).toBe(1000);
    expect(ntnbVna(ipca, '2000-08-14')).toBe(1000);
    expect(ntnbVna(ipca, '2000-08-15')).toBe(1010);
    expect(ntnbVna(ipca, '2001-07-15')).toBeCloseTo(1000 * 1.01 ** 12, 4);
    expect(ntnbVna(ipca, '2001-09-15')).toBeUndefined(); // missing IPCA months
  });

  it('history of NTN-F / NTN-B titles carries COUPON events; NTN-B amount = VNA x 2.956301 %', async () => {
    const csv = [
      'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha',
      'Tesouro Prefixado com Juros Semestrais;01/01/2035;30/12/2024;13,0;13,1;890,10;885,20;885,20',
      'Tesouro Prefixado com Juros Semestrais;01/01/2035;02/01/2025;13,0;13,1;850,10;845,20;845,20',
      'Tesouro Prefixado com Juros Semestrais;01/01/2035;01/07/2025;13,0;13,1;860,10;855,20;855,20',
      'Tesouro IPCA+ com Juros Semestrais;15/05/2045;02/01/2025;7,0;7,1;4000,10;3990,20;3990,20',
      'Tesouro IPCA+ com Juros Semestrais;15/05/2045;15/05/2025;7,0;7,1;3990,10;3980,20;3980,20',
    ].join('\n');
    const fetch = createFakeFetch({ routes: (u) => (u.host === 'www.tesourotransparente.gov.br' ? new Response(csv) : undefined) });
    const ipca = Array.from({ length: 300 }, (_, i) => {
      const d = new Date(Date.UTC(2000, 6 + i, 1));
      return { date: d.toISOString().slice(0, 10), value: 0.5 };
    });
    const td = new TesouroProvider({ http: new HttpClient({ fetch, sleep: async () => undefined }), now: () => NOW, ipca: async () => ipca });
    const f = await td.dailyHistory({ instrumentId: 'TD:NTNF-2035-01-01', exchange: 'TD', symbol: 'NTNF-2035', yahoo: '' }, '2025-01-01', '2025-12-31');
    expect(f.dividends).toEqual([
      { date: '2025-01-02', payDate: '2025-01-02', amount: NTNF_COUPON, kind: 'COUPON' },
      { date: '2025-07-01', payDate: '2025-07-01', amount: NTNF_COUPON, kind: 'COUPON' },
    ]);
    const b = await td.dailyHistory({ instrumentId: 'TD:NTNB-2045-05-15', exchange: 'TD', symbol: 'NTNB-2045', yahoo: '' }, '2025-01-01', '2025-12-31');
    const vna = ntnbVna(ipca, '2025-05-15')!;
    expect(b.dividends[0]).toMatchObject({ date: '2025-05-15', kind: 'COUPON', amount: Math.round(vna * NTNB_COUPON_FACTOR * 1e6) / 1e6 });
    expect(b.dividends.map((d) => d.date)).toEqual(['2025-05-15', '2025-11-17']);
  });

  it('through the service the coupon is a DIVIDEND/COUPON action; without IPCA history it is reviewRequired without amount', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'TD:NTNB-2045-05-15', from: '2025-01-01', to: '2026-10-05' });
    const c = h.actions.filter((a) => a.subtype === 'COUPON');
    expect(c.map((a) => a.date)).toEqual(['2025-05-15', '2025-11-17', '2026-05-15']);
    expect(c[0]).toMatchObject({ type: 'DIVIDEND', reviewRequired: true });
    expect(c[0]!.amountPerShare).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------ M2
describe('M2 resilience without API keys', () => {
  it('a query2 outage is served by the second Yahoo host (query1)', async () => {
    const { service, fetch } = createTestService({ failingHosts: ['query2.finance.yahoo.com'] });
    const h = await service.history({ symbol: 'ECOPETROL.CL', from: '2025-01-02', to: '2025-01-31' });
    expect(h.series.source).toBe('yahoo');
    expect(h.series.points.length).toBeGreaterThan(10);
    expect(fetch.calls.some((u) => u.startsWith('https://query1.finance.yahoo.com/'))).toBe(true);
  });

  it('split-adjusted backups are converted to as-traded with the cached split history', async () => {
    const cache = new TieredCache({ now: () => NOW.getTime() });
    await cache.set('yahoo:splits:AAPL', [{ date: '2025-06-01', ratio: 2 }], TTL.SPLITS);
    const { service } = createTestService({ failingHosts: ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'] }, { cache });
    const h = await service.history({ symbol: 'AAPL', from: '2025-01-02', to: '2025-01-06' });
    expect(h.series.source).toBe('stooq');
    expect(h.series.points.map((p) => p.close)).toEqual([487.7, 486.72, 490]);
    expect(h.notes?.join(' ')).toMatch(/un-adjusted with the cached split history/);
  });
});

// ------------------------------------------------------------------------------------------ M18
describe('M18 Colombian ISIN of a renamed security', () => {
  it('COB07PA00078 (Bancolombia preferencial) resolves to Grupo Cibest preferencial', async () => {
    const { service } = createTestService();
    expect((await service.search('COB07PA00078')).results[0]).toMatchObject({ id: 'XBOG:PFCIBEST', origin: 'alias' });
    expect(service.resolve('COB07PA00078').target.instrumentId).toBe('XBOG:PFCIBEST');
  });
});

