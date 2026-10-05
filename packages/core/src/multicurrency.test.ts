/**
 * Multi-currency portfolio (COP base; COP, BRL, USD and EUR assets and cash) over 24 months.
 * Checks the engine against hand-computable totals and against an independent brute-force
 * daily TWR built only from valuePortfolio() and externalFlows().
 */
import { describe, expect, it } from 'vitest';
import {
  computeHoldings,
  externalFlows,
  incomeEvents,
  monthlyPerformance,
  performanceSummary,
  valuePortfolio,
  valueSeries,
} from './api';
import { addDays, monthEnd, monthRange } from './dates';
import { engine, inst, sum, tx } from './__fixtures__/helpers';
import type { FxSeries, PriceSeries, Transaction } from './types';

const ECO = inst('XBOG:ECOPETROL', 'COP', { country: 'CO' });
const PETR = inst('BVMF:PETR4', 'BRL', { country: 'BR' });
const AAPL = inst('XNAS:AAPL', 'USD');
const SAP = inst('XETR:SAP', 'EUR', { country: 'DE' });
const months = monthRange('2022-12', '2024-12');
const ends = months.map(monthEnd);

const series = (id: string, ccy: string, f: (k: number) => number): PriceSeries => ({
  instrumentId: id,
  currency: ccy,
  source: 't',
  points: ends.map((date, k) => ({ date, close: Math.round(f(k) * 100) / 100 })),
});
const fxSeries = (base: string, quote: string, f: (k: number) => number): FxSeries => ({
  base,
  quote,
  source: 't',
  points: ends.map((date, k) => ({ date, rate: Math.round(f(k) * 10000) / 10000 })),
});

const PRICES = [
  series(ECO.id, 'COP', (k) => 2400 * (1 + 0.08 * Math.sin(k / 2)) - 10 * k),
  series(PETR.id, 'BRL', (k) => 25 + 0.5 * k + 2 * Math.cos(k)),
  series(AAPL.id, 'USD', (k) => 140 + 4 * k + 8 * Math.sin(k / 1.5)),
  series(SAP.id, 'EUR', (k) => 100 + 2.5 * k - 5 * Math.cos(k / 3)),
];
const FX = [
  fxSeries('USD', 'COP', (k) => 4400 - 25 * k + 120 * Math.sin(k / 2)),
  fxSeries('USD', 'BRL', (k) => 5.1 + 0.02 * k + 0.15 * Math.sin(k / 3)),
  fxSeries('EUR', 'USD', (k) => 1.07 + 0.002 * k + 0.02 * Math.cos(k / 2)),
];

const T: Transaction[] = [
  tx({ date: '2023-01-10', type: 'DEPOSIT', amount: 100_000_000, currency: 'COP' }),
  tx({ date: '2023-01-12', type: 'BUY', instrumentId: ECO.id, quantity: 10_000, price: 2410, fees: 25_000, currency: 'COP' }),
  tx({ date: '2023-01-15', type: 'FX_CONVERSION', amount: 40_000_000, currency: 'COP', toCurrency: 'USD', toAmount: 9_050 }),
  tx({ date: '2023-01-15', type: 'FX_CONVERSION', amount: 15_000_000, currency: 'COP', toCurrency: 'BRL', toAmount: 17_400 }),
  tx({ date: '2023-01-15', type: 'FX_CONVERSION', amount: 15_000_000, currency: 'COP', toCurrency: 'EUR', toAmount: 3_150 }),
  tx({ date: '2023-01-18', type: 'BUY', instrumentId: AAPL.id, quantity: 50, price: 141, fees: 1, currency: 'USD' }),
  tx({ date: '2023-01-18', type: 'BUY', instrumentId: PETR.id, quantity: 600, price: 26, fees: 4.5, currency: 'BRL' }),
  tx({ date: '2023-01-19', type: 'BUY', instrumentId: SAP.id, quantity: 25, price: 98, fees: 3, currency: 'EUR' }),
];
// Monthly COP contributions on the 15th (Feb 2023 .. Dec 2024).
for (const ym of monthRange('2023-02', '2024-12')) T.push(tx({ date: `${ym}-15`, type: 'DEPOSIT', amount: 2_000_000, currency: 'COP' }));
// Quarterly dividends with withholding in each currency.
for (const ym of ['2023-03', '2023-06', '2023-09', '2023-12', '2024-03', '2024-06', '2024-09', '2024-12']) {
  T.push(tx({ date: `${ym}-20`, type: 'DIVIDEND', instrumentId: AAPL.id, amount: 12, taxes: 3.6, currency: 'USD' }));
  T.push(tx({ date: `${ym}-22`, type: 'DIVIDEND', instrumentId: PETR.id, amount: 300, taxes: 0, currency: 'BRL' }));
}
T.push(tx({ date: '2023-04-20', type: 'DIVIDEND', instrumentId: ECO.id, amount: 3_000_000, taxes: 300_000, currency: 'COP' }));
T.push(tx({ date: '2024-05-10', type: 'DIVIDEND', instrumentId: SAP.id, amount: 55, taxes: 14.5, currency: 'EUR' }));
T.push(tx({ date: '2023-09-12', type: 'SELL', instrumentId: PETR.id, quantity: 300, price: 30, fees: 2.7, currency: 'BRL' }));
T.push(tx({ date: '2023-11-08', type: 'BUY', instrumentId: ECO.id, quantity: 5_000, price: 2300, fees: 12_000, currency: 'COP' }));
T.push(tx({ date: '2024-02-07', type: 'FX_CONVERSION', amount: 20_000_000, currency: 'COP', toCurrency: 'USD', toAmount: 5_000 }));
T.push(tx({ date: '2024-02-08', type: 'BUY', instrumentId: AAPL.id, quantity: 25, price: 190, fees: 1, currency: 'USD' }));
T.push(tx({ date: '2024-03-20', type: 'WITHDRAWAL', amount: 5_000_000, currency: 'COP' }));
T.push(tx({ date: '2024-06-11', type: 'SELL', instrumentId: AAPL.id, quantity: 30, price: 200, fees: 1, currency: 'USD' }));
T.push(tx({ date: '2024-07-03', type: 'FX_CONVERSION', amount: 5_000, currency: 'USD', toCurrency: 'EUR', toAmount: 4_600 }));
T.push(tx({ date: '2024-07-05', type: 'BUY', instrumentId: SAP.id, quantity: 30, price: 150, fees: 3, currency: 'EUR' }));

const input = engine({ base: 'COP', instruments: [ECO, PETR, AAPL, SAP], prices: PRICES, fx: FX, transactions: T, options: { asOf: '2024-12-31' } });

/** Independent daily TWR: inflows at start of day, outflows at end of day. */
function bruteForceMonthlyTwr(): Map<string, number> {
  const flows = externalFlows(input);
  const out = new Map<string, number>();
  let prev = valuePortfolio(input, '2022-12-31').totalMarketValueBase;
  let date = '2023-01-01';
  let g = 1;
  while (date <= '2024-12-31') {
    const v = valuePortfolio(input, date).totalMarketValueBase;
    const today = flows.filter((f) => f.date === date);
    const inB = sum(today.filter((f) => f.amountBase > 0).map((f) => f.amountBase));
    const outB = -sum(today.filter((f) => f.amountBase < 0).map((f) => f.amountBase));
    const den = prev + inB;
    if (den > 0.01) g *= (v + outB) / den;
    const next = addDays(date, 1);
    if (next.slice(0, 7) !== date.slice(0, 7)) {
      out.set(date.slice(0, 7), g - 1);
      g = 1;
    }
    prev = v;
    date = next;
  }
  return out;
}

describe('multi-currency portfolio over 24 months (COP, BRL, USD, EUR)', () => {
  const rows = monthlyPerformance(input);

  it('produces 24 contiguous monthly rows', () => {
    expect(rows).toHaveLength(24);
    expect(rows[0]!.month).toBe('2023-01');
    expect(rows[23]!.month).toBe('2024-12');
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.startValueBase).toBeCloseTo(rows[i - 1]!.endValueBase, 6);
    for (const r of rows) expect(r.gainBase).toBeCloseTo(r.endValueBase - r.startValueBase - r.netFlowsBase, 6);
  });

  it('flows: only explicit COP deposits/withdrawals (no implicit cash flows needed)', () => {
    const f = externalFlows(input);
    expect(f.every((x) => x.kind === 'DEPOSIT' || x.kind === 'WITHDRAWAL')).toBe(true);
    // 100M + 23 * 2M - 5M
    expect(sum(rows.map((r) => r.netFlowsBase))).toBeCloseTo(141_000_000, 6);
  });

  it('matches an independent brute-force daily TWR month by month', () => {
    const brute = bruteForceMonthlyTwr();
    for (const r of rows) expect(r.twr).toBeCloseTo(brute.get(r.month)!, 10);
  });

  it('cumulative TWR is the chained product and agrees with valueSeries and performanceSummary', () => {
    const chained = rows.reduce((g, r) => g * (1 + r.twr), 1) - 1;
    expect(rows[23]!.cumulativeTwr).toBeCloseTo(chained, 12);
    const s = valueSeries(input, { from: '2022-12-31', to: '2024-12-31', step: 'month' });
    expect(s[s.length - 1]!.cumulativeTwr).toBeCloseTo(chained, 10);
    const daily = valueSeries(input, { from: '2022-12-31', to: '2024-12-31', step: 'day' });
    expect(daily[daily.length - 1]!.cumulativeTwr).toBeCloseTo(chained, 10);
    expect(daily[daily.length - 1]!.netInvestedBase).toBeCloseTo(141_000_000, 6);
    const si = performanceSummary(input, 'SI', '2024-12-31');
    expect(si.twr).toBeCloseTo(chained, 10);
    expect(si.endValueBase).toBeCloseTo(rows[23]!.endValueBase, 6);
    expect(si.twrAnnualized).toBeDefined();
    const y2024 = performanceSummary(input, 'YTD', '2024-12-31');
    expect(y2024.twr).toBeCloseTo(rows.slice(12).reduce((g, r) => g * (1 + r.twr), 1) - 1, 10);
  });

  it('local + FX returns add up to the TWR every month', () => {
    for (const r of rows) expect(r.localReturn! + r.fxReturn!).toBeCloseTo(r.twr, 14);
    // Not trivially zero: currencies moved.
    expect(rows.some((r) => Math.abs(r.fxReturn!) > 0.001)).toBe(true);
  });

  it('income and the month table agree with income events', () => {
    const ev = incomeEvents(input);
    expect(ev).toHaveLength(18);
    expect(sum(rows.map((r) => r.incomeBase))).toBeCloseTo(sum(ev.map((e) => e.netBase)), 6);
    // Withholding included in taxesBase: 8 * 3.6 USD + 300,000 COP + 14.5 EUR
    const taxes = sum(rows.map((r) => r.taxesBase));
    expect(taxes).toBeGreaterThan(300_000);
  });

  it('cash per currency (hand-computed)', () => {
    const v = valuePortfolio(input, '2024-12-31');
    const cash = Object.fromEntries(v.cash.map((c) => [c.currency, c.amount]));
    // USD: 9050 - 7051 + 8*8.4 + 5000 - 4751 + 5999 - 5000
    expect(cash.USD).toBeCloseTo(9050 - 7051 + 8 * 8.4 + 5000 - 4751 + 5999 - 5000, 6);
    // BRL: 17400 - 15604.5 + 8*300 + 8997.3
    expect(cash.BRL).toBeCloseTo(17400 - 15604.5 + 8 * 300 + 8997.3, 6);
    // EUR: 3150 - 2453 + 40.5 + 4600 - 4503
    expect(cash.EUR).toBeCloseTo(3150 - 2453 + 40.5 + 4600 - 4503, 6);
    // COP: 100M + 46M - 5M - 24,125,000 - 70M - 2,700,000 + 11,512,000(dividend net 2.7M) ...
    const cop = 100_000_000 + 46_000_000 - 5_000_000 - 24_125_000 - 70_000_000 + 2_700_000 - 11_512_000 - 20_000_000;
    expect(cash.COP).toBeCloseTo(cop, 4);
  });

  it('holdings: price + FX effects sum to unrealized gain; totals are consistent', () => {
    const v = valuePortfolio(input, '2024-12-31');
    for (const h of v.holdings) expect(h.priceGainBase! + h.fxGainBase!).toBeCloseTo(h.unrealizedGainBase!, 4);
    expect(v.holdings.find((h) => h.instrumentId === ECO.id)!.fxGainBase).toBe(0);
    const securities = sum(v.holdings.map((h) => h.marketValueBase!));
    const cash = sum(v.cash.map((c) => c.amountBase!));
    expect(v.totalMarketValueBase).toBeCloseTo(securities + cash, 4);
    expect(sum(v.holdings.map((h) => h.weight!)) + cash / v.totalMarketValueBase).toBeCloseTo(1, 12);
    expect(v.missingPrices).toEqual([]);
    expect(v.missingFx).toEqual([]);
    const aapl = computeHoldings(input, '2024-12-31').find((h) => h.instrumentId === AAPL.id)!;
    expect(aapl.quantity).toBe(45);
    expect(aapl.lots.map((l) => [l.openDate, l.quantity])).toEqual([
      ['2023-01-18', 20],
      ['2024-02-08', 25],
    ]);
  });

  it('reporting in USD is the COP value converted at the closing USD/COP rate', () => {
    const cop = valuePortfolio(input, '2024-12-31').totalMarketValueBase;
    const usd = valuePortfolio({ ...input, baseCurrency: 'USD' }, '2024-12-31').totalMarketValueBase;
    const usdcop = input.market.fx('USD', 'COP', '2024-12-31')!;
    expect(usd * usdcop).toBeCloseTo(cop, 4);
    // USD-based TWR differs from COP-based TWR by the currency move.
    const usdRows = monthlyPerformance({ ...input, baseCurrency: 'USD' });
    expect(usdRows).toHaveLength(24);
    expect(usdRows[5]!.twr).not.toBeCloseTo(rows[5]!.twr, 6);
  });
});
