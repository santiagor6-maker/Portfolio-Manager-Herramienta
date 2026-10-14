/** Round 6: market-data reads the canonical rename / merger table of @pm/core. Fixtures only. */
import { TICKER_EVENTS } from '@pm/core';
import { describe, expect, it } from 'vitest';
import { findAlias, historicalEventsFrom, TICKER_ALIASES, type YahooChartResult } from '../src/index';
import { createTestService, json } from './helpers';

describe('one source of truth: @pm/core TICKER_EVENTS', () => {
  it('every alias is a core event (same ids, kind, ratio, dates), with Yahoo symbols filled in', () => {
    expect(TICKER_ALIASES).toHaveLength(TICKER_EVENTS.length);
    TICKER_ALIASES.forEach((a, i) => {
      const e = TICKER_EVENTS[i]!;
      expect(a).toMatchObject({ kind: e.kind, fromId: e.fromId, toId: e.toId, ratio: e.ratio });
      expect(a.effective).toBe(e.effective);
      expect(a.fromYahoo).toMatch(/\.(SA|CL)$/);
      expect(a.toYahoo).toMatch(/\.(SA|CL)$/);
    });
  });
});

describe('renames added by the shared table', () => {
  it.each([
    ['TRPL3', 'BVMF:ISAE3', 'ISAE3.SA'],
    ['TRPL4.SA', 'BVMF:ISAE4', 'ISAE4.SA'],
    ['BVMF:TRPL4', 'BVMF:ISAE4', 'ISAE4.SA'],
    ['ELET6', 'BVMF:AXIA6', 'AXIA6.SA'],
    ['ELET6.SA', 'BVMF:AXIA6', 'AXIA6.SA'],
  ])('%s -> %s (same security, history continues)', (sym, id, yahoo) => {
    expect(findAlias(sym)).toMatchObject({ kind: 'rename', toId: id, ratio: 1 });
    const { service } = createTestService();
    const r = service.resolve(sym);
    expect(r.kind).toBe('market');
    expect(r.target).toMatchObject({ instrumentId: id, yahoo });
    expect(r.alias?.toId).toBe(id);
  });
});

/** NATU3.SA as Yahoo has it: Natura Cosméticos until 2019-12-17, then nothing until the code returns in 2025. */
function natu3(): YahooChartResult {
  const day = (iso: string) => Date.parse(`${iso}T15:00:00Z`) / 1000;
  const bars: [string, number, number][] = [
    ['2019-12-16', 36.5, 900_000],
    ['2019-12-17', 36.86, 750_000],
    ['2025-07-02', 10.19, 5_000_000],
    ['2025-07-03', 10.05, 3_000_000],
  ];
  return {
    meta: { symbol: 'NATU3.SA', currency: 'BRL', exchangeName: 'SAO', exchangeTimezoneName: 'America/Sao_Paulo', gmtoffset: -10800, regularMarketTime: day('2025-07-03'), regularMarketPrice: 10.05, priceHint: 2 },
    timestamp: bars.map((b) => day(b[0])),
    indicators: { quote: [{ close: bars.map((b) => b[1]), volume: bars.map((b) => b[2]) }] },
  };
}
const natuRoutes = (u: URL) => (u.pathname.endsWith('/NATU3.SA') && u.searchParams.get('interval') === '1d' ? json({ chart: { result: [natu3()], error: null } }) : undefined);

describe('the 2019 NATU3 -> NTCO3 conversion (the NATU3 code was reused in 2025)', () => {
  it('today NATU3 is a live listing, not "delisted"; NTCO3 is the 2025 conversion into NATU3', () => {
    expect(findAlias('NATU3')).toBeUndefined();
    expect(findAlias('NATU3.SA')).toBeUndefined();
    expect(findAlias('NTCO3')).toMatchObject({ kind: 'conversion', toId: 'BVMF:NATU3', effective: '2025-07-02' });
    expect(historicalEventsFrom('BVMF:NATU3')).toEqual([expect.objectContaining({ kind: 'conversion', toId: 'BVMF:NTCO3', effective: '2019-12-18', lastTradingDay: '2019-12-17', ratio: 1 })]);
    const { service } = createTestService();
    expect(service.resolve('NATU3')).toMatchObject({ kind: 'market', target: { instrumentId: 'BVMF:NATU3' } });
  });

  it('a NATU3 history covering December 2019 carries the conversion into NTCO3 (1:1 on 2019-12-18)', async () => {
    const { service } = createTestService({ routes: natuRoutes });
    const h = await service.history({ symbol: 'NATU3', from: '2019-12-01', to: '2020-01-31' });
    expect(h.series.points.map((p) => p.date)).toEqual(['2019-12-16', '2019-12-17']);
    expect(h.actions).toEqual([
      expect.objectContaining({ instrumentId: 'BVMF:NATU3', date: '2019-12-18', type: 'SPLIT', subtype: 'MERGER', ratio: 1, targetInstrumentId: 'BVMF:NTCO3' }),
    ]);
  });

  it('a NATU3 history after the code came back has no 2019 event', async () => {
    const { service } = createTestService({ routes: natuRoutes });
    const h = await service.history({ symbol: 'NATU3', from: '2025-07-01', to: '2025-07-31' });
    expect(h.actions.filter((a) => a.subtype === 'MERGER')).toEqual([]);
    expect(h.series.points[0]).toEqual({ date: '2025-07-02', close: 10.19 });
  });
});
