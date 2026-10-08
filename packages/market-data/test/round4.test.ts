/**
 * Regression tests for review round 3 (reviews/market-data-r3.md).
 */
import { describe, expect, it } from 'vitest';
import { couponDates, dropStaleZeroVolume, findAlias, nextBusinessDayBR, type YahooChartResult, buildHistory } from '../src/index';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestService, FIXTURES, json } from './helpers';

/** NATU3-like chart: real 2019 trades, then a 5.5-year gap, four zero-volume 36.86 bars, then real 2025 trades. */
function natuChart(): YahooChartResult {
  const day = (iso: string) => Date.parse(`${iso}T13:00:00Z`) / 1000;
  const bars: [string, number, number][] = [
    ['2019-12-16', 36.5, 900000],
    ['2019-12-17', 36.7, 800000],
    ['2019-12-18', 36.86, 750000],
    ['2025-06-26', 36.86, 0],
    ['2025-06-27', 36.86, 0],
    ['2025-06-30', 36.86, 0],
    ['2025-07-01', 36.86, 0],
    ['2025-07-02', 10.19, 5_000_000],
    ['2025-07-03', 10.05, 3_000_000],
    ['2025-07-04', 10.05, 0], // ordinary quiet day: kept
  ];
  return {
    meta: { symbol: 'NATU3.SA', currency: 'BRL', exchangeName: 'SAO', exchangeTimezoneName: 'America/Sao_Paulo', gmtoffset: -10800, regularMarketTime: day('2025-07-04'), regularMarketPrice: 10.05, priceHint: 2 },
    timestamp: bars.map((b) => day(b[0])),
    indicators: { quote: [{ close: bars.map((b) => b[1]), volume: bars.map((b) => b[2]) }] },
  };
}

describe('M28 zero-volume bars repeating a stale close are dropped anywhere in the series', () => {
  it('long fetch: bars repeating the 2019 close after a 5-year gap are removed (rule A)', () => {
    const h = buildHistory(natuChart(), 'NATU3.SA', '2019-12-01', '2025-07-31', []);
    expect(h.points.map((p) => p.date)).toEqual(['2019-12-16', '2019-12-17', '2019-12-18', '2025-07-02', '2025-07-03', '2025-07-04']);
    expect(h.notes.join(' ')).toMatch(/dropped 4 zero-volume bar/);
  });

  it('short fetch starting in 2025: leading stale bars far from the first trade are removed (rule B)', () => {
    const h = buildHistory(natuChart(), 'NATU3.SA', '2025-06-01', '2025-07-31', []);
    expect(h.points[0]).toEqual({ date: '2025-07-02', close: 10.19 });
  });

  it('the June-2025 month-end is not overvalued', async () => {
    const routes = (u: URL) => (u.pathname.endsWith('/NATU3.SA') && u.searchParams.get('interval') === '1d' ? json({ chart: { result: [natuChart()], error: null } }) : undefined);
    const { service } = createTestService({ routes });
    const h = await service.history({ symbol: 'BVMF:NATU3', from: '2025-01-01', to: '2025-07-31', interval: '1mo' });
    expect(h.series.points).toEqual([{ date: '2025-07-04', close: 10.05 }]);
  });

  it('quiet illiquid days (zero volume, previous close, days after a trade) are kept', () => {
    const pts = [
      { date: '2025-01-02', close: 100 },
      { date: '2025-01-03', close: 100 },
      { date: '2025-01-06', close: 101 },
    ];
    const vol = new Map([['2025-01-02', 10], ['2025-01-03', 0], ['2025-01-06', 5]]);
    expect(dropStaleZeroVolume(pts, vol).points).toEqual(pts);
  });

  it('series without volume (indices, FX) are untouched', () => {
    const pts = [{ date: '2019-01-02', close: 5 }, { date: '2025-01-02', close: 5 }];
    expect(dropStaleZeroVolume(pts, new Map()).points).toEqual(pts);
  });

  it('NTCO3 is a conversion (no provider history), not a rename stitched to NATU3', async () => {
    expect(findAlias('NTCO3')).toMatchObject({ kind: 'conversion', toId: 'BVMF:NATU3', ratio: 1, effective: '2025-07-02' });
    const { service, fetch } = createTestService();
    const h = await service.history({ symbol: 'NTCO3', from: '2019-06-01', to: '2025-12-31', interval: '1mo' });
    expect(h.instrument.id).toBe('BVMF:NTCO3');
    expect(h.series.points).toEqual([]);
    expect(h.actions).toEqual([expect.objectContaining({ subtype: 'MERGER', ratio: 1, targetInstrumentId: 'BVMF:NATU3', date: '2025-07-02' })]);
    expect(fetch.calls.some((u) => u.includes('NATU3'))).toBe(false);
  });
});

describe('M29 Copel chain with real dates, CPLE11 units', () => {
  it('CPLE11 (1 CPLE3 + 4 CPLE6) dissolved on 2023-12-26, both components flagged for review', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'CPLE11', from: '2023-12-01', to: '2024-01-31' });
    expect(h.delisted).toMatchObject({ kind: 'conversion', lastTradingDay: '2023-12-22' });
    expect(h.actions).toEqual([
      expect.objectContaining({ subtype: 'MERGER', ratio: 1, targetInstrumentId: 'BVMF:CPLE3', reviewRequired: true, date: '2023-12-26' }),
      expect.objectContaining({ subtype: 'SPINOFF', ratio: 4, targetInstrumentId: 'BVMF:CPLE6', reviewRequired: true, date: '2023-12-26' }),
    ]);
  });

  it('CPLE6 last trading day 2025-11-07, CPLE5 2025-12-19', () => {
    expect(findAlias('CPLE6.SA')).toMatchObject({ lastTradingDay: '2025-11-07', effective: '2025-11-10', toId: 'BVMF:CPLE5' });
    expect(findAlias('BVMF:CPLE5')).toMatchObject({ lastTradingDay: '2025-12-19', effective: '2025-12-22', toId: 'BVMF:CPLE3', cashPerShare: 0.7749 });
  });
});

describe('M30 bare B3 tickers are looked up on B3, never as US symbols', () => {
  it.each([
    ['CPLE3', 'CPLE3.SA', 'BVMF:CPLE3'],
    ['TAEE11', 'TAEE11.SA', 'BVMF:TAEE11'],
    ['SAPR11', 'SAPR11.SA', 'BVMF:SAPR11'],
    ['RAPT4', 'RAPT4.SA', 'BVMF:RAPT4'],
  ])('%s -> %s', (sym, yahoo, id) => {
    const { service } = createTestService();
    const r = service.resolve(sym);
    expect(r.target.yahoo).toBe(yahoo);
    expect(r.target.instrumentId).toBe(id);
  });

  it('bare old B3 tickers still resolve through the alias table (CPLE11 -> delisted units)', () => {
    const { service } = createTestService();
    expect(service.resolve('CPLE11').kind).toBe('delisted');
  });

  it('US tickers are unaffected', () => {
    const { service } = createTestService();
    expect(service.resolve('AAPL').target.instrumentId).toBe('XNAS:AAPL');
    expect(service.resolve('BRK-B').target.yahoo).toBe('BRK-B');
  });
});

describe('M31 coupon dates and B3 ex-dates follow the B3/ANBIMA holiday calendar (core calendars)', () => {
  it('cross-checks known holidays', () => {
    expect(nextBusinessDayBR('2024-11-15')).toBe('2024-11-18'); // Republic Day (Friday)
    expect(nextBusinessDayBR('2025-11-20')).toBe('2025-11-21'); // Black Consciousness Day
    expect(nextBusinessDayBR('2026-02-16')).toBe('2026-02-18'); // Carnival Mon+Tue
    expect(nextBusinessDayBR('2025-01-01')).toBe('2025-01-02');
    expect(nextBusinessDayBR('2025-06-19')).toBe('2025-06-20'); // Corpus Christi
    expect(nextBusinessDayBR('2025-11-17')).toBe('2025-11-17');
  });

  it('NTN-B November coupon of 2024 is paid on 2024-11-18, NTN-F January coupon on 2 January', () => {
    expect(couponDates('2035-05-15')).toContain('2024-11-18');
    expect(couponDates('2035-05-15')).not.toContain('2024-11-15');
    expect(couponDates('2033-01-01').filter((d) => d.startsWith('2026'))).toEqual(['2026-01-02', '2026-07-01']);
  });

  it('brapi ex-dates skip B3 holidays (data com on the eve of Carnival)', async () => {
    const { parseBrapiDividends } = await import('../src/index');
    const ev = parseBrapiDividends({ symbol: 'X', dividendsData: { cashDividends: [{ rate: 1, label: 'JCP', lastDatePrior: '2026-02-13T00:00:00.000Z' }] } });
    expect(ev[0]!.date).toBe('2026-02-18');
  });
});



describe('M2 local price snapshot: a keyless fallback independent of the live providers', () => {
  it('recordSnapshot persists current-year chunks; with every provider down they are served as source "snapshot"', async () => {
    const { MemoryStore, TieredCache } = await import('../src/index');
    const store = new MemoryStore();
    const NOW_MS = Date.parse('2026-10-05T15:00:00Z');
    const live = (u: URL) => (u.pathname.endsWith('/PETR4.SA') && u.searchParams.get('interval') === '1d' ? json(fixtureJsonLive()) : undefined);
    const a = createTestService({ routes: live }, { cache: new TieredCache({ store, now: () => NOW_MS }) }).service;
    const rec = await a.recordSnapshot(['BVMF'], { from: '2026-09-28' });
    expect(rec.ok).toBeGreaterThan(0);
    expect(store.data.has('hist:v2:yahoo:PETR4.SA:2026')).toBe(true); // current year persisted despite its 10-min TTL
    // New process, 2 days later: every live provider is down and the 10-min chunk has expired.
    const later = NOW_MS + 2 * 86_400_000;
    const down = createTestService(
      { failingHosts: ['query2.finance.yahoo.com', 'query1.finance.yahoo.com', 'brapi.dev'] },
      { cache: new TieredCache({ store, now: () => later }), now: () => new Date(later) },
    ).service;
    const h = await down.history({ symbol: 'PETR4.SA', from: '2026-09-28', to: '2026-10-05' });
    expect(h.series.source).toBe('snapshot');
    expect(h.series.points.at(-1)).toMatchObject({ date: '2026-10-05', close: 55.36 });
    expect(h.notes?.join(' ')).toMatch(/recorded locally by this server/);
    expect(h.fallbacks?.map((f) => f.source)).toEqual(expect.arrayContaining(['yahoo', 'brapi']));
  });
});

function fixtureJsonLive(): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, 'yahoo/chart-PETR4.SA-live-1d.json'), 'utf8'));
}
