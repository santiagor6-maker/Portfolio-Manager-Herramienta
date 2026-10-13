/**
 * Regression tests from the round-6 external review (reviews/core-r6.md), script r6-a.
 * Finding ids C48 (run confirmation vs systematic import errors), C49 (indexed coupons),
 * C50 (unrecorded splits), C51 (hash cost).
 */
import { describe, expect, it } from 'vitest';
import { createMarketData, ledgerDiagnostics, monthlyPerformance, performanceSummary, valuePortfolio } from './api';
import type { EngineInput } from './api';
import { addMonthsYm } from './dates';
import { inputHash } from './engine';
import type { FxSeries, IndexSeries, Instrument, PriceSeries, Transaction } from './types';

const pf = (base = 'COP') => ({ id: 'p', name: 'p', baseCurrency: base, costMethod: 'FIFO' as const, createdAt: '2020-01-01' });
let n = 0;
const tx = (t: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>): Transaction => ({ id: `r6-${++n}`, portfolioId: 'p', currency: 'COP', ...t });
const inst = (id: string, currency: string, extra: Partial<Instrument> = {}): Instrument => ({ id, symbol: id, name: id, exchange: 'X', currency, country: 'US', assetClass: 'equity', ...extra });
const ps = (instrumentId: string, currency: string, pts: [string, number][]): PriceSeries => ({ instrumentId, currency, source: 'manual', points: pts.map(([date, close]) => ({ date, close })) });
const fxs = (base: string, quote: string, pts: [string, number][]): FxSeries => ({ base, quote, source: 'manual', points: pts.map(([date, rate]) => ({ date, rate })) });
const mkt = (prices: PriceSeries[] = [], fx: FxSeries[] = []) => createMarketData({ prices, fx });
const tradeCodes = (inp: EngineInput) => ledgerDiagnostics(inp).map((d) => d.code).filter((c) => c.startsWith('TRADE'));

describe('C48 — systematic import errors are never confirmed by a run', () => {
  it('R1: two same-day fills with the same x10 error are one piece of evidence', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-31', 100]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 1000, price: 100 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'X', quantity: 5, price: 1000 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'X', quantity: 5, price: 1000 }),
      ],
      options: { asOf: '2024-02-20' },
    };
    const s = performanceSummary(inp, 'MTD', '2024-02-20');
    expect(s.endValueBase).toBeCloseTo(101_000, 6);
    expect(s.twr).toBeLessThan(0);
    expect(s.warnings).toContain('TRADE_PRICE_UNIT_SUSPECT:X');
  });

  it('same-day fills with a x2.5 move (inside the band) do not confirm each other either', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP', { pricing: 'manual' })],
      market: mkt([ps('X', 'COP', [['2024-01-31', 100]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 1000, price: 100 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'X', quantity: 5, price: 400 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'X', quantity: 5, price: 400 }),
      ],
      options: { asOf: '2024-02-20' },
    };
    expect(valuePortfolio(inp, '2024-02-20').totalMarketValueBase).toBeCloseTo(101_000, 6);
    expect(tradeCodes(inp)).toEqual(['TRADE_PRICE_OUTLIER', 'TRADE_PRICE_OUTLIER']);
  });

  it('R2: Colombian thousands separator read as a decimal ("4.200" -> 4.2) on two trades', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('PFX', 'COP', { pricing: 'manual' })],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-15', type: 'BUY', instrumentId: 'PFX', quantity: 100, price: 4100 }),
        tx({ date: '2024-03-15', type: 'BUY', instrumentId: 'PFX', quantity: 10, price: 4.2 }),
        tx({ date: '2024-04-15', type: 'BUY', instrumentId: 'PFX', quantity: 10, price: 4.25 }),
      ],
      options: { asOf: '2024-04-30' },
    };
    expect(valuePortfolio(inp, '2024-04-30').totalMarketValueBase).toBeGreaterThan(400_000);
    const rows = monthlyPerformance(inp, { asOf: '2024-04-30' });
    expect(rows[2]!.twr).toBeGreaterThan(-0.01);
    expect(rows[2]!.warnings).toContain('TRADE_PRICE_UNIT_SUSPECT:PFX');
    expect(tradeCodes(inp)).toEqual(['TRADE_PRICE_UNIT_SUSPECT', 'TRADE_PRICE_UNIT_SUSPECT']);
  });

  it('R3: pence read as pounds (x100) on two trades in the current month', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('VOD', 'GBP', { exchange: 'XLON' })],
      market: mkt([ps('VOD', 'GBP', [['2024-01-31', 0.7]])], [fxs('GBP', 'COP', [['2024-01-01', 5000]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'VOD', quantity: 1000, price: 0.7, currency: 'GBP' }),
        tx({ date: '2024-02-05', type: 'BUY', instrumentId: 'VOD', quantity: 100, price: 71, currency: 'GBP' }),
        tx({ date: '2024-02-12', type: 'BUY', instrumentId: 'VOD', quantity: 100, price: 72, currency: 'GBP' }),
      ],
      options: { asOf: '2024-02-20' },
    };
    const s = performanceSummary(inp, 'MTD', '2024-02-20');
    expect(Math.abs(s.twr)).toBeLessThan(1);
    expect(s.warnings).toContain('TRADE_PRICE_UNIT_SUSPECT:VOD');
  });

  it('a unit-suspect price is used once the user confirms it', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('PFX', 'COP', { pricing: 'manual' })],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-15', type: 'BUY', instrumentId: 'PFX', quantity: 100, price: 4100 }),
        tx({ date: '2024-03-15', type: 'BUY', instrumentId: 'PFX', quantity: 10, price: 41_000, priceConfirmed: true }),
      ],
    };
    expect(tradeCodes(inp)).toEqual([]);
    expect(valuePortfolio(inp, '2024-03-31').totalMarketValueBase).toBeCloseTo(110 * 41_000, 6);
  });

  it('R4: a genuine crypto x6 with consistent prices on two days still confirms, with a warning', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('SOL', 'USD', { assetClass: 'crypto' })],
      market: mkt([ps('SOL', 'USD', [['2023-10-31', 20]])], [fxs('USD', 'COP', [['2023-01-01', 4000]])]),
      transactions: [
        tx({ date: '2023-10-31', type: 'BUY', instrumentId: 'SOL', quantity: 100, price: 20, currency: 'USD' }),
        tx({ date: '2023-11-20', type: 'BUY', instrumentId: 'SOL', quantity: 1, price: 120, currency: 'USD' }),
        tx({ date: '2023-11-28', type: 'BUY', instrumentId: 'SOL', quantity: 1, price: 125, currency: 'USD' }),
      ],
      options: { asOf: '2023-11-30' },
    };
    const s = performanceSummary(inp, 'MTD', '2023-11-30');
    expect(s.twr).toBeCloseTo(5.25, 2);
    expect(s.warnings).toContain('TRADE_PRICE_CONFIRMED_BY_RUN:SOL');
  });
});

describe('C49 — coupons of inflation-indexed bonds never settle the index update', () => {
  it('I1: NTN-B (IPCA + 6 %) with low inflation keeps the updated VNA after the coupon', () => {
    const points: { date: string; value: number }[] = [];
    for (let ym = '2023-01'; ym <= '2025-12'; ym = addMonthsYm(ym, 1)) points.push({ date: `${ym}-01`, value: 0.12 });
    const ipca: IndexSeries = { id: 'IPCA', kind: 'periodRate', period: 'month', unit: 'percent', points, source: 't' };
    const b = inst('NTNB', 'BRL', { country: 'BR', assetClass: 'bond', pricing: 'manual', accrual: { kind: 'indexed', index: 'IPCA', spread: 0.06, dayCount: 'BUS/252', taxRegime: 'NONE' } });
    const vna = 4000 * Math.pow(1.0012, 6);
    const inp: EngineInput = {
      portfolio: pf('BRL'),
      instruments: [b],
      market: createMarketData({ prices: [], fx: [], indexSeries: [ipca] }),
      transactions: [
        tx({ date: '2024-05-15', type: 'BUY', instrumentId: 'NTNB', quantity: 1, price: 4000, currency: 'BRL' }),
        tx({ date: '2024-11-14', type: 'INTEREST', subtype: 'COUPON', instrumentId: 'NTNB', amount: vna * (Math.sqrt(1.06) - 1), currency: 'BRL' }),
      ],
    };
    const after = valuePortfolio(inp, '2024-11-14').holdings[0]!.marketValueBase!;
    expect(Math.abs(after / vna - 1)).toBeLessThan(0.001);
    const yr = valuePortfolio(inp, '2025-05-15').holdings[0]!.marketValueBase!;
    expect(Math.abs(yr / (4000 * Math.pow(1.0012, 12) * Math.sqrt(1.06)) - 1)).toBeLessThan(0.003);
  });

  it('I2: TES UVR coupon leaves the UVR-updated principal', () => {
    const uvr: IndexSeries = { id: 'UVR', kind: 'level', points: [{ date: '2024-01-01', value: 360 }, { date: '2025-01-01', value: 378 }], source: 't' };
    const b = inst('TESUVR', 'COP', { assetClass: 'bond', pricing: 'manual', accrual: { kind: 'indexed', index: 'UVR', spread: 0.03, dayCount: 'ACT/365', taxRegime: 'NONE' } });
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [b],
      market: createMarketData({ prices: [], fx: [], indexSeries: [uvr] }),
      transactions: [tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'TESUVR', quantity: 1, price: 1000 }), tx({ date: '2025-01-01', type: 'INTEREST', instrumentId: 'TESUVR', amount: 1000 * 1.05 * 0.03 })],
    };
    expect(valuePortfolio(inp, '2025-01-01').holdings[0]!.marketValueBase).toBeCloseTo(1050, 0);
  });
});

describe('C50 — possible unrecorded split', () => {
  it('R5: closes fall about 10:1 with no split recorded: warning in the month', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('NV', 'USD')],
      market: mkt([ps('NV', 'USD', [['2024-05-31', 1100], ['2024-06-28', 120]])], [fxs('USD', 'COP', [['2024-01-01', 4000]])]),
      transactions: [tx({ date: '2024-05-31', type: 'BUY', instrumentId: 'NV', quantity: 10, price: 1100, currency: 'USD' }), tx({ date: '2024-06-20', type: 'BUY', instrumentId: 'NV', quantity: 10, price: 118, currency: 'USD' })],
      options: { asOf: '2024-06-28' },
    };
    const r = monthlyPerformance(inp, { asOf: '2024-06-28' });
    expect(r[1]!.warnings).toContain('POSSIBLE_UNRECORDED_SPLIT:NV');
    expect(ledgerDiagnostics(inp).map((d) => d.code)).toContain('POSSIBLE_UNRECORDED_SPLIT');
    // with the split recorded there is no warning
    const ok = { ...inp, transactions: [inp.transactions[0]!, tx({ date: '2024-06-10', type: 'SPLIT', instrumentId: 'NV', ratio: 10 }), inp.transactions[1]!] };
    expect(ledgerDiagnostics(ok).map((d) => d.code)).not.toContain('POSSIBLE_UNRECORDED_SPLIT');
  });

  it('ordinary daily moves are not flagged', () => {
    const pts: [string, number][] = [];
    for (let d = 1; d <= 28; d++) pts.push([`2024-02-${String(d).padStart(2, '0')}`, 100 + (d % 5) * 3]);
    const inp: EngineInput = { portfolio: pf(), instruments: [inst('Q', 'COP')], market: mkt([ps('Q', 'COP', pts)]), transactions: [tx({ date: '2024-02-01', type: 'BUY', instrumentId: 'Q', quantity: 10, price: 100 })] };
    expect(ledgerDiagnostics(inp).map((d) => d.code)).not.toContain('POSSIBLE_UNRECORDED_SPLIT');
  });
});

describe('C51 — per-array hash cache keeps detecting every change', () => {
  it('row replaced, row pushed and field edited in place all change the hash', () => {
    const rows = [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 1, price: 1 }), tx({ date: '2024-01-03', type: 'BUY', instrumentId: 'X', quantity: 1, price: 1 })];
    const inp: EngineInput = { portfolio: pf(), instruments: [inst('X', 'COP')], market: mkt(), transactions: rows };
    const h0 = inputHash(inp);
    expect(inputHash(inp)).toBe(h0);
    rows[1] = { ...rows[1]!, price: 2 };
    const h1 = inputHash(inp);
    expect(h1).not.toBe(h0);
    rows[1]!.note = 'x';
    const h2 = inputHash(inp);
    expect(h2).not.toBe(h1);
    rows.push(tx({ date: '2024-01-04', type: 'BUY', instrumentId: 'X', quantity: 1, price: 1 }));
    expect(inputHash(inp)).not.toBe(h2);
    // a new array with the same rows hashes the same as the old one did
    expect(inputHash({ ...inp, transactions: rows.slice() })).toBe(inputHash(inp));
  });

  it('30,000 unchanged rows hash quickly on repeated calls', () => {
    const rows = Array.from({ length: 30_000 }, (_, k) => tx({ date: '2024-01-02', type: 'BUY', instrumentId: `I${k % 150}`, quantity: 1, price: 100 }));
    const inp: EngineInput = { portfolio: pf(), instruments: [], market: mkt(), transactions: rows };
    inputHash(inp);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) inputHash(inp);
    expect((performance.now() - t0) / 10).toBeLessThan(15);
  });
});
