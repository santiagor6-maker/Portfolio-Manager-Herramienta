/**
 * Regression tests from the round-7 external review (reviews/core-r7.md), scripts r7-a/b/c.
 * Finding ids C52 (recorded split without a close on the ex-date), C53, C54, C55 (unit
 * dissolution order), C56 (ticker renames, merger cash pay date) and the split-label fix.
 */
import { describe, expect, it } from 'vitest';
import { applyCorporateActions, createMarketData, ledgerDiagnostics, monthlyPerformance, performanceSummary, validateTransactions, valuePortfolio } from './api';
import type { EngineInput } from './api';
import { createDemoData } from './demo';
import type { FxSeries, Instrument, PriceSeries, Transaction } from './types';

const pf = (base = 'COP') => ({ id: 'p', name: 'p', baseCurrency: base, costMethod: 'FIFO' as const, createdAt: '2020-01-01' });
let n = 0;
const tx = (t: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>): Transaction => ({ id: `r7-${++n}`, portfolioId: 'p', currency: 'COP', ...t });
const inst = (id: string, currency: string, extra: Partial<Instrument> = {}): Instrument => ({ id, symbol: id, name: id, exchange: 'X', currency, country: 'US', assetClass: 'equity', ...extra });
const ps = (instrumentId: string, currency: string, pts: [string, number][]): PriceSeries => ({ instrumentId, currency, source: 'manual', points: pts.map(([date, close]) => ({ date, close })) });
const fxs = (base: string, quote: string, pts: [string, number][]): FxSeries => ({ base, quote, source: 'manual', points: pts.map(([date, rate]) => ({ date, rate })) });
const mkt = (prices: PriceSeries[] = [], fx: FxSeries[] = []) => createMarketData({ prices, fx });
const codes = (inp: EngineInput) => ledgerDiagnostics(inp).map((d) => d.code);

describe('C52 — a recorded split adjusts the last pre-split price', () => {
  it('F: 2:1 split mid-month with month-end closes: value and flat TWR', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('S', 'COP')],
      market: mkt([ps('S', 'COP', [['2024-01-31', 100], ['2024-02-29', 50]])]),
      transactions: [tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'S', quantity: 100, price: 100 }), tx({ date: '2024-02-12', type: 'SPLIT', instrumentId: 'S', ratio: 2 }), tx({ date: '2024-02-20', type: 'DEPOSIT', amount: 5000 })],
      options: { asOf: '2024-02-29' },
    };
    expect(valuePortfolio(inp, '2024-02-15').totalMarketValueBase).toBeCloseTo(10_000, 9);
    expect(valuePortfolio(inp, '2024-02-11').totalMarketValueBase).toBeCloseTo(10_000, 9);
    expect(monthlyPerformance(inp, { asOf: '2024-02-29' })[1]!.twr).toBeCloseTo(0, 9);
  });

  it('A2: recorded 10:1 reverse split, post-split buy is not a unit error', () => {
    const inp: EngineInput = {
      portfolio: pf('BRL'),
      instruments: [inst('RS', 'BRL')],
      market: mkt([ps('RS', 'BRL', [['2024-03-28', 1.0]])]),
      transactions: [
        tx({ date: '2024-03-28', type: 'BUY', instrumentId: 'RS', quantity: 10000, price: 1.0, currency: 'BRL' }),
        tx({ date: '2024-04-08', type: 'SPLIT', instrumentId: 'RS', ratio: 0.1, currency: 'BRL' }),
        tx({ date: '2024-04-15', type: 'BUY', instrumentId: 'RS', quantity: 100, price: 10.2, currency: 'BRL' }),
      ],
      options: { asOf: '2024-04-20' },
    };
    const s = performanceSummary(inp, 'MTD', '2024-04-20');
    expect(s.endValueBase).toBeCloseTo(11_220, 9);
    expect(s.twr).toBeCloseTo(0.02, 9);
    expect(codes(inp).filter((c) => c.startsWith('TRADE'))).toEqual([]);
  });

  it('trade-only prints before a split are valued pre-split before the ex-date and adjusted after', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('T', 'COP', { pricing: 'manual' })],
      market: mkt(),
      transactions: [tx({ date: '2024-01-10', type: 'BUY', instrumentId: 'T', quantity: 10, price: 300 }), tx({ date: '2024-02-01', type: 'SPLIT', instrumentId: 'T', ratio: 3 }), tx({ date: '2024-03-01', type: 'BUY', instrumentId: 'T', quantity: 1, price: 101 })],
    };
    expect(valuePortfolio(inp, '2024-01-31').totalMarketValueBase).toBeCloseTo(3000, 9);
    expect(valuePortfolio(inp, '2024-02-15').totalMarketValueBase).toBeCloseTo(3000, 9);
    expect(valuePortfolio(inp, '2024-03-01').totalMarketValueBase).toBeCloseTo(31 * 101, 9);
    expect(codes(inp).filter((c) => c.startsWith('TRADE'))).toEqual([]);
  });

  it('demo: WEGE3 between the split (2024-04-15) and the April close is valued at the adjusted price', () => {
    const d = createDemoData();
    const split = d.input.transactions.find((t) => t.type === 'SPLIT')!;
    const id = split.instrumentId!;
    const series = d.marketInput.prices!.find((p) => p.instrumentId === id)!;
    const last = series.points.filter((p) => p.date < split.date).at(-1)!;
    const h = valuePortfolio(d.input, '2024-04-20').holdings.find((x) => x.instrumentId === id)!;
    expect(h.price).toBeCloseTo(last.close / split.ratio!, 9);
  });
});

describe('C53 / C54 — power-of-ten moves and the split detector', () => {
  it('A1: a real x10 on three consistent prints on distinct days is accepted, with warnings', () => {
    const inp: EngineInput = {
      portfolio: pf('USD'),
      instruments: [inst('PNY', 'USD', { pricing: 'manual' })],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-10', type: 'BUY', instrumentId: 'PNY', quantity: 10000, price: 0.1, currency: 'USD' }),
        tx({ date: '2024-05-10', type: 'BUY', instrumentId: 'PNY', quantity: 100, price: 1.05, currency: 'USD' }),
        tx({ date: '2024-06-10', type: 'BUY', instrumentId: 'PNY', quantity: 100, price: 1.1, currency: 'USD' }),
        tx({ date: '2024-07-10', type: 'BUY', instrumentId: 'PNY', quantity: 100, price: 1.2, currency: 'USD' }),
      ],
      options: { asOf: '2024-07-31' },
    };
    expect(valuePortfolio(inp, '2024-07-31').totalMarketValueBase).toBeCloseTo(12_360, 6);
    const w = performanceSummary(inp, 'YTD', '2024-07-31').warnings ?? [];
    expect(w).toContain('TRADE_PRICE_UNIT_SUSPECT:PNY');
    expect(w).toContain('TRADE_PRICE_CONFIRMED_BY_RUN:PNY');
    // Web R7 W67: structured data says which suspects are already accepted, and the factor.
    const unit = ledgerDiagnostics(inp).filter((d) => d.code === 'TRADE_PRICE_UNIT_SUSPECT');
    expect(unit.map((d) => d.data)).toContainEqual({ unitFactor: 10, accepted: 1 });
    expect(unit.filter((d) => d.data?.accepted === 0).every((d) => d.data?.unitFactor === 10)).toBe(true);
  });

  it('two x100 prints on distinct days are still never confirmed', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('V', 'COP', { pricing: 'manual' })],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-10', type: 'BUY', instrumentId: 'V', quantity: 1000, price: 1 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'V', quantity: 1, price: 100 }),
        tx({ date: '2024-03-10', type: 'BUY', instrumentId: 'V', quantity: 1, price: 101 }),
        tx({ date: '2024-04-10', type: 'BUY', instrumentId: 'V', quantity: 1, price: 102 }),
      ],
    };
    expect(valuePortfolio(inp, '2024-04-30').totalMarketValueBase).toBeCloseTo(1003, 9);
  });

  for (const [label, pts, cls] of [
    ['B1 daily crash -50 %', [['2024-03-01', 100], ['2024-03-04', 50.5], ['2024-03-05', 51]], 'equity'],
    ['B2 daily -66 %', [['2024-03-01', 100], ['2024-03-04', 33.5], ['2024-03-05', 33]], 'equity'],
    ['B3 biotech doubles', [['2024-03-01', 10], ['2024-03-04', 20.1], ['2024-03-05', 20.5]], 'equity'],
    ['B5 crypto -75 %', [['2022-04-30', 40], ['2022-05-31', 10.1], ['2022-06-30', 9]], 'crypto'],
  ] as const) {
    it(`${label}: no split warning in rows or summary`, () => {
      const inp: EngineInput = {
        portfolio: pf(),
        instruments: [inst('Z', 'USD', { assetClass: cls })],
        market: mkt([ps('Z', 'USD', pts as unknown as [string, number][])], [fxs('USD', 'COP', [['2020-01-01', 4000]])]),
        transactions: [tx({ date: pts[0][0], type: 'BUY', instrumentId: 'Z', quantity: 100, price: pts[0][1], currency: 'USD' })],
      };
      const rows = monthlyPerformance(inp, { asOf: pts[pts.length - 1]![0] });
      expect(rows.flatMap((r) => r.warnings ?? []).filter((w) => w.includes('SPLIT'))).toEqual([]);
    });
  }

  it('A4: a fall to 1/1000 is reported as a possible redenomination', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('EC', 'COP')],
      market: mkt([ps('EC', 'COP', [['2024-01-31', 4000], ['2024-02-01', 4.0], ['2024-02-29', 4.1]])]),
      transactions: [tx({ date: '2024-01-15', type: 'DEPOSIT', amount: 1_000_000 }), tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'EC', quantity: 100, price: 4000 })],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp, { asOf: '2024-02-29' })[1]!.warnings).toContain('POSSIBLE_REDENOMINATION:EC');
  });

  it('split labels: a fall 1200 -> 121 is a 10:1 split; a rise 1 -> 10 is a 1:10 reverse split (structured data)', () => {
    const run = (a: number, b: number) => {
      const inp: EngineInput = {
        portfolio: pf(),
        instruments: [inst('N', 'COP')],
        market: mkt([ps('N', 'COP', [['2024-06-03', a], ['2024-06-04', b], ['2024-06-05', b]])]),
        transactions: [tx({ date: '2024-06-03', type: 'BUY', instrumentId: 'N', quantity: 10, price: a })],
      };
      return ledgerDiagnostics(inp).find((d) => d.code === 'POSSIBLE_UNRECORDED_SPLIT')!;
    };
    const fwd = run(1200, 121);
    expect(fwd.data).toMatchObject({ ratioFrom: 1, ratioTo: 10, splitRatio: 10, priceFrom: 1200, priceTo: 121, dateTo: '2024-06-04', instrumentId: 'N' });
    expect(fwd.message).toContain('10:1 split');
    expect(fwd.date).toBe('2024-06-04');
    const rev = run(1, 10);
    expect(rev.data).toMatchObject({ ratioFrom: 10, ratioTo: 1, splitRatio: 0.1 });
    expect(rev.message).toContain('1:10 reverse split');
  });
});

describe('C55 — unit dissolution emitted as MERGER then SPINOFF', () => {
  it('E2: CPLE11 -> 1 CPLE3 + 4 CPLE6 keeps every component and the cost', () => {
    const ins = [inst('BVMF:CPLE11', 'BRL'), inst('BVMF:CPLE3', 'BRL'), inst('BVMF:CPLE6', 'BRL')];
    const inp: EngineInput = {
      portfolio: pf('BRL'),
      instruments: ins,
      market: mkt([ps('BVMF:CPLE3', 'BRL', [['2023-12-26', 8]]), ps('BVMF:CPLE6', 'BRL', [['2023-12-26', 8.5]]), ps('BVMF:CPLE11', 'BRL', [['2023-12-22', 42]])]),
      transactions: [
        tx({ date: '2023-06-01', type: 'BUY', instrumentId: 'BVMF:CPLE11', quantity: 100, price: 40, currency: 'BRL' }),
        tx({ date: '2023-12-26', type: 'SPLIT', subtype: 'MERGER', instrumentId: 'BVMF:CPLE11', targetInstrumentId: 'BVMF:CPLE3', ratio: 1, currency: 'BRL' }),
        tx({ date: '2023-12-26', type: 'SPLIT', subtype: 'SPINOFF', instrumentId: 'BVMF:CPLE11', targetInstrumentId: 'BVMF:CPLE6', ratio: 4, currency: 'BRL' }),
      ],
      options: { asOf: '2023-12-29' },
    };
    const v = valuePortfolio(inp, '2023-12-29');
    const q = Object.fromEntries(v.holdings.map((h) => [h.instrumentId, h.quantity]));
    expect(q).toEqual({ 'BVMF:CPLE3': 100, 'BVMF:CPLE6': 400 });
    expect(v.holdings.reduce((s, h) => s + h.costBasis, 0)).toBeCloseTo(4000, 9);
    expect(monthlyPerformance(inp, { asOf: '2023-12-29' }).at(-1)!.twr).toBeCloseTo(4200 / 4000 - 1, 9);
    expect(codes(inp)).toContain('COST_FRACTION_ESTIMATED');
  });

  it('a corporate action on an emptied parent is reported', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('A', 'COP'), inst('B', 'COP'), inst('C', 'COP')],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'A', quantity: 10, price: 100 }),
        tx({ date: '2024-02-01', type: 'SPLIT', subtype: 'MERGER', instrumentId: 'A', targetInstrumentId: 'B', ratio: 1 }),
        tx({ date: '2024-02-02', type: 'SPLIT', subtype: 'SPINOFF', instrumentId: 'A', targetInstrumentId: 'C', ratio: 1 }),
      ],
    };
    expect(codes(inp)).toContain('CORPORATE_ACTION_WITHOUT_POSITION');
  });
});

describe('C56 — shared ticker renames and merger cash pay date', () => {
  it('E1: old id (manual history) and new id (import) are one instrument', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('XBOG:PFBCOLOM', 'COP'), inst('XBOG:PFCIBEST', 'COP')],
      market: mkt([ps('XBOG:PFCIBEST', 'COP', [['2024-01-02', 35000], ['2025-09-30', 60000]])]),
      transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'XBOG:PFBCOLOM', quantity: 100, price: 35000 }), tx({ date: '2025-09-15', type: 'SELL', instrumentId: 'XBOG:PFCIBEST', quantity: 50, price: 59000 })],
      options: { asOf: '2025-09-30' },
    };
    const v = valuePortfolio(inp, '2025-09-30');
    expect(v.holdings.map((h) => [h.instrumentId, h.quantity, h.priceSource])).toEqual([['XBOG:PFCIBEST', 50, 'market']]);
    expect(codes(inp)).toEqual(['INSTRUMENT_RENAMED']);
    expect(validateTransactions(inp.transactions, inp.instruments!, { today: '2030-01-01' }).warnings.map((w) => w.code)).toContain('RENAMED_TICKER_MIXED');
    // opt out
    expect(valuePortfolio({ ...inp, options: { ...inp.options, tickerRenames: false } }, '2025-09-30').holdings.map((h) => h.instrumentId)).toContain('XBOG:PFBCOLOM');
  });

  it('prices stored only under the old id are used for the renamed instrument', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('XBOG:PFBCOLOM', 'COP')],
      market: mkt([ps('XBOG:PFBCOLOM', 'COP', [['2024-01-02', 35000], ['2024-06-28', 40000]])]),
      transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'XBOG:PFBCOLOM', quantity: 10, price: 35000 })],
    };
    const h = valuePortfolio(inp, '2024-06-30').holdings[0]!;
    expect(h.instrumentId).toBe('XBOG:PFCIBEST');
    expect(h.marketValueBase).toBe(400_000);
  });

  it('CPLE5 -> CPLE3 merger cash is a receivable until its pay date', () => {
    const ins = [inst('BVMF:CPLE5', 'BRL'), inst('BVMF:CPLE3', 'BRL')];
    const buy = tx({ date: '2025-06-02', type: 'BUY', instrumentId: 'BVMF:CPLE5', quantity: 1000, price: 12, currency: 'BRL' });
    const ca = applyCorporateActions(
      [buy],
      [
        { instrumentId: 'BVMF:CPLE5', date: '2025-12-22', type: 'SPLIT', subtype: 'MERGER', ratio: 1, targetInstrumentId: 'BVMF:CPLE3' },
        { instrumentId: 'BVMF:CPLE5', date: '2025-12-22', type: 'DIVIDEND', subtype: 'EXTRAORDINARY', amountPerShare: 0.7749, currency: 'BRL', payDate: '2025-12-30' },
      ],
      ins,
    );
    const merger = ca.suggested.find((t) => t.subtype === 'MERGER')!;
    expect(merger.cashPayDate).toBe('2025-12-30');
    expect(merger.amount).toBeCloseTo(774.9, 6);
    const inp: EngineInput = {
      portfolio: pf('BRL'),
      instruments: ins,
      market: mkt([ps('BVMF:CPLE5', 'BRL', [['2025-06-02', 12], ['2025-12-19', 13]]), ps('BVMF:CPLE3', 'BRL', [['2025-12-22', 12.2]])]),
      transactions: [buy, merger, tx({ date: '2025-12-24', type: 'BUY', instrumentId: 'BVMF:CPLE3', quantity: 50, price: 12.2, currency: 'BRL' })],
    };
    const mid = valuePortfolio(inp, '2025-12-23').cash.find((c) => c.currency === 'BRL')!;
    expect(mid.receivable).toBeCloseTo(774.9, 6);
    // the buy on 12-24 cannot use the receivable: it is funded by an implicit deposit
    const after = valuePortfolio(inp, '2025-12-31').cash.find((c) => c.currency === 'BRL')!;
    expect(after.amount).toBeCloseTo(774.9, 6);
    expect(after.receivable).toBeUndefined();
    expect(codes(inp)).toContain('MERGER_CASH_PENDING');
  });
});
