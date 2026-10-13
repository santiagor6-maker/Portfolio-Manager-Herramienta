/**
 * Regression tests from the round-5 external review (reviews/core-r5.md), script r5-a.
 * Finding ids C45, C46, C47 and the open C43 case (W3).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMarketData, incomeEvents, ledgerDiagnostics, performanceSummary, valuePortfolio } from './api';
import type { EngineInput } from './api';
import { inputHash } from './engine';
import type { FxSeries, Instrument, PriceSeries, Transaction } from './types';

const pf = (base = 'COP') => ({ id: 'p', name: 'p', baseCurrency: base, costMethod: 'FIFO' as const, createdAt: '2020-01-01' });
let n = 0;
const tx = (t: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>): Transaction => ({ id: `r5-${++n}`, portfolioId: 'p', currency: 'COP', ...t });
const inst = (id: string, currency: string, extra: Partial<Instrument> = {}): Instrument => ({ id, symbol: id, name: id, exchange: 'X', currency, country: 'US', assetClass: 'equity', ...extra });
const ps = (instrumentId: string, currency: string, pts: [string, number][]): PriceSeries => ({ instrumentId, currency, source: 'manual', points: pts.map(([date, close]) => ({ date, close })) });
const fxs = (base: string, quote: string, pts: [string, number][]): FxSeries => ({ base, quote, source: 'manual', points: pts.map(([date, rate]) => ({ date, rate })) });
const mkt = (prices: PriceSeries[] = [], fx: FxSeries[] = []) => createMarketData({ prices, fx });
const codes = (inp: EngineInput) => ledgerDiagnostics(inp).map((d) => d.code);

describe('C45 — every Transaction field is part of the cache hash', () => {
  it('each field declared in types.ts changes inputHash', () => {
    const src = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export interface Transaction {'));
    const block = body.slice(0, body.indexOf('\n}'));
    const keys = Array.from(block.matchAll(/^ {2}(\w+)\??:/gm), (m) => m[1] as string);
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toContain('priceConfirmed');
    const row: Transaction = tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 1, price: 1 });
    const inp: EngineInput = { portfolio: pf(), instruments: [inst('X', 'COP')], market: mkt(), transactions: [row] };
    const h0 = inputHash(inp);
    for (const k of keys) {
      const rec = row as unknown as Record<string, unknown>;
      const old = rec[k];
      rec[k] = typeof old === 'number' ? old + 1 : typeof old === 'boolean' ? !old : `${String(old ?? '')}~`;
      expect(inputHash(inp), `field ${k}`).not.toBe(h0);
      if (old === undefined) delete rec[k];
      else rec[k] = old;
      expect(inputHash(inp)).toBe(h0);
    }
  });

  it('V1: confirming a price in place, or on a copy of the row, takes effect through the API', () => {
    const t2 = tx({ date: '2024-02-20', type: 'BUY', instrumentId: 'X', quantity: 100, price: 4 });
    const input: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP', { pricing: 'manual' })],
      market: mkt([ps('X', 'COP', [['2024-01-31', 1]])]),
      transactions: [tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 1000, price: 1 }), t2],
      options: { asOf: '2024-02-29' },
    };
    expect(valuePortfolio(input, '2024-02-29').totalMarketValueBase).toBe(1100);
    const copy = { ...input, transactions: [input.transactions[0]!, { ...t2, priceConfirmed: true }] };
    expect(valuePortfolio(copy, '2024-02-29').totalMarketValueBase).toBe(4400);
    t2.priceConfirmed = true;
    expect(valuePortfolio(input, '2024-02-29').totalMarketValueBase).toBe(4400);
  });
});

describe('C46 — a run of consistent trade prices confirms a new level', () => {
  it('V2: trade-only small cap 1 -> 3.5 -> 4 -> 4.2 values at 4,326', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('PV', 'COP', { pricing: 'manual' })],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-10', type: 'BUY', instrumentId: 'PV', quantity: 1000, price: 1 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'PV', quantity: 10, price: 3.5 }),
        tx({ date: '2024-03-10', type: 'BUY', instrumentId: 'PV', quantity: 10, price: 4 }),
        tx({ date: '2024-04-10', type: 'BUY', instrumentId: 'PV', quantity: 10, price: 4.2 }),
      ],
      options: { asOf: '2024-04-30' },
    };
    expect(valuePortfolio(inp, '2024-04-30').totalMarketValueBase).toBeCloseTo(4326, 9);
    // the first new price is re-accepted: February ends at 3.5
    expect(valuePortfolio(inp, '2024-02-29').totalMarketValueBase).toBeCloseTo(1010 * 3.5, 9);
    expect(codes(inp).filter((c) => c.startsWith('TRADE'))).toEqual(['TRADE_PRICE_CONFIRMED_BY_RUN']);
    expect(performanceSummary(inp, 'SI', '2024-04-30').warnings ?? []).toEqual([]);
  });

  const sol = (extra: Transaction[]): EngineInput => ({
    portfolio: pf(),
    instruments: [inst('SOL', 'USD', { assetClass: 'crypto' })],
    market: mkt([ps('SOL', 'USD', [['2023-10-31', 20]])], [fxs('USD', 'COP', [['2023-01-01', 4000]])]),
    transactions: [tx({ date: '2023-10-31', type: 'BUY', instrumentId: 'SOL', quantity: 100, price: 20, currency: 'USD' }), tx({ date: '2023-11-28', type: 'BUY', instrumentId: 'SOL', quantity: 1, price: 125, currency: 'USD' }), ...extra],
    options: { asOf: '2023-11-30' },
  });

  it('V3: a single crypto x6.25 print waits for confirmation; a consistent second print confirms it', () => {
    expect(performanceSummary(sol([]), 'MTD', '2023-11-30').warnings).toContain('TRADE_PRICE_OUTLIER:SOL');
    const ok = sol([tx({ date: '2023-11-29', type: 'SELL', instrumentId: 'SOL', quantity: 0.5, price: 128, currency: 'USD' })]);
    expect(valuePortfolio(ok, '2023-11-30').holdings[0]!.marketValueBase).toBeCloseTo(100.5 * 128 * 4000, 6);
    expect(performanceSummary(ok, 'MTD', '2023-11-30').twr).toBeGreaterThan(4);
    expect(codes(ok).filter((c) => c.startsWith('TRADE'))).toEqual(['TRADE_PRICE_CONFIRMED_BY_RUN']);
  });

  it('a confirmed price re-anchors the reference for the following prints', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('PV', 'COP', { pricing: 'manual' })],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-10', type: 'BUY', instrumentId: 'PV', quantity: 1000, price: 1 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'PV', quantity: 10, price: 4, priceConfirmed: true }),
        tx({ date: '2024-03-10', type: 'BUY', instrumentId: 'PV', quantity: 10, price: 4.4 }),
      ],
    };
    expect(codes(inp).filter((c) => c.startsWith('TRADE'))).toEqual([]);
    expect(valuePortfolio(inp, '2024-03-31').totalMarketValueBase).toBeCloseTo(1020 * 4.4, 9);
  });

  it('two prints that disagree with each other stay rejected (x10 typo twice in different directions)', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('PV', 'COP', { pricing: 'manual' })],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-10', type: 'BUY', instrumentId: 'PV', quantity: 1000, price: 1 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'PV', quantity: 10, price: 10 }),
        tx({ date: '2024-03-10', type: 'BUY', instrumentId: 'PV', quantity: 10, price: 0.1 }),
      ],
    };
    expect(valuePortfolio(inp, '2024-03-31').totalMarketValueBase).toBeCloseTo(1020, 9);
    expect(codes(inp).filter((c) => c.startsWith('TRADE'))).toEqual(['TRADE_PRICE_OUTLIER', 'TRADE_PRICE_OUTLIER']);
  });
});

describe('C47 — net-interest inference only when unambiguous, and marked estimated', () => {
  const cdt = (id: string) => inst(id, 'COP', { assetClass: 'fixed_income', pricing: 'manual', country: 'CO', accrual: { kind: 'fixed', annualRate: 0.12, dayCount: 'ACT/365' } });
  const one = (id: string, payDate: string, amount: number, extra: Partial<Transaction> = {}): EngineInput => ({
    portfolio: pf(),
    instruments: [cdt(id)],
    market: mkt(),
    transactions: [tx({ date: '2024-01-01', type: 'BUY', instrumentId: id, quantity: 1, price: 10_000_000 }), tx({ date: payDate, type: 'INTEREST', instrumentId: id, amount, ...extra })],
  });

  it('X1: gross paid on 30 of 31 days is kept gross, no invented withholding, no phantom interest', () => {
    const gross = 10_000_000 * (Math.pow(1.12, 30 / 365) - 1);
    const inp = one('X1', '2024-02-01', gross);
    const ev = incomeEvents(inp)[0]!;
    expect(ev.gross).toBeCloseTo(gross, 9);
    expect(ev.taxes).toBe(0);
    expect(ev.taxesEstimated).toBeUndefined();
    expect(valuePortfolio(inp, '2024-02-01').holdings[0]!.marketValueBase).toBeCloseTo(10_000_000, 4);
    expect(codes(inp)).toContain('INTEREST_BELOW_ACCRUED');
  });

  it('X2: a gross amount at 96.2 % of the accrual does not invent a withholding', () => {
    const inp = one('X2', '2024-03-31', 10_000_000 * (Math.pow(1.12, 90 / 365) - 1) * 0.962);
    expect(incomeEvents(inp)[0]!.taxes).toBe(0);
    expect(codes(inp)).not.toContain('INTEREST_NET_ASSUMED');
  });

  it('amountIsNet infers the withholding and marks it estimated', () => {
    const m = 10_000_000 * (Math.pow(1.12, 31 / 365) - 1);
    const inp = one('XN', '2024-02-01', m * 0.96, { amountIsNet: true });
    const ev = incomeEvents(inp)[0]!;
    expect(ev.gross).toBeCloseTo(m, 4);
    expect(ev.taxes).toBeCloseTo(m * 0.04, 4);
    expect(ev.taxesEstimated).toBe(true);
    expect(codes(inp)).toContain('INTEREST_NET_ASSUMED');
    expect(valuePortfolio(inp, '2024-02-01').holdings[0]!.marketValueBase).toBeCloseTo(10_000_000, 4);
  });

  it('a Brazilian coupon net of 22.5 % IR is unambiguous: inferred automatically, estimated', () => {
    const b = inst('LTN', 'BRL', { country: 'BR', assetClass: 'bond', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.1, dayCount: 'ACT/365' } });
    const c = 1000 * (Math.pow(1.1, 120 / 365) - 1);
    const inp: EngineInput = {
      portfolio: pf('BRL'),
      instruments: [b],
      market: mkt(),
      transactions: [tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'LTN', quantity: 1, price: 1000, currency: 'BRL' }), tx({ date: '2024-04-30', type: 'INTEREST', instrumentId: 'LTN', amount: c * 0.775, currency: 'BRL' })],
    };
    const ev = incomeEvents(inp)[0]!;
    expect(ev.gross).toBeCloseTo(c, 6);
    expect(ev.taxesEstimated).toBe(true);
    expect(valuePortfolio(inp, '2024-04-30').holdings[0]!.marketValueBase).toBeCloseTo(1000, 6);
  });
});

describe('C43 / C42 — coupons with purchases near the payment date', () => {
  const bond = (id: string, ccy = 'COP') => inst(id, ccy, { country: ccy === 'BRL' ? 'BR' : 'CO', assetClass: 'bond', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.1, dayCount: 'ACT/365', ...(ccy === 'COP' ? { taxRegime: 'NONE' as const } : {}) } });
  const c = 1000 * (Math.pow(1.1, 182 / 365) - 1);
  const run = (id: string, buyDate: string, buyPrice: number, amount: number, ccy = 'COP', extra: Partial<Transaction> = {}) => {
    const inp: EngineInput = {
      portfolio: pf(ccy),
      instruments: [bond(id, ccy)],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-01', type: 'BUY', instrumentId: id, quantity: 4, price: 1000, currency: ccy }),
        tx({ date: buyDate, type: 'BUY', instrumentId: id, quantity: 1, price: buyPrice, currency: ccy }),
        tx({ date: '2024-07-01', type: 'INTEREST', instrumentId: id, amount, currency: ccy, ...extra }),
      ],
    };
    return { inp, v: valuePortfolio(inp, '2024-07-01').holdings[0]!.marketValueBase! };
  };

  it('W1: bought at a dirty price before the record date: the coupon covers 5 units', () => {
    expect(run('W1', '2024-06-21', 1000 + (c * 172) / 182, 5 * c).v).toBeCloseTo(5000, 0);
  });

  it('W2: bought at a clean price after the record date: the coupon covers the 4 older units only', () => {
    const { v, inp } = run('W2', '2024-06-28', 1000, 4 * c);
    expect(v).toBeCloseTo(5000 + 1000 * (Math.pow(1.1, 3 / 365) - 1), 3);
    expect(codes(inp)).toContain('COUPON_RECORD_DATE_UNITS');
  });

  it('W3: Brazilian coupon recorded net after a recent purchase leaves no phantom interest', () => {
    expect(run('W3', '2024-06-21', 1000 + (c * 172) / 182, 5 * c * 0.8, 'BRL').v).toBeCloseTo(5000, 0);
  });

  it('W3 with amountIsNet: IR per lot with its own holding period (20 % and 22.5 %), estimated', () => {
    const { inp, v } = run('W3N', '2024-06-21', 1000 + (c * 172) / 182, c * (4 * 0.8 + 0.775), 'BRL', { amountIsNet: true });
    const ev = incomeEvents(inp)[0]!;
    expect(ev.gross).toBeCloseTo(5 * c, 4);
    expect(ev.taxesEstimated).toBe(true);
    expect(v).toBeCloseTo(5000, 0);
  });
});
