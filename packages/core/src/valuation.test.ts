import { describe, expect, it } from 'vitest';
import { computeHoldings, monthlyPerformance, realizedGains, valuePortfolio } from './api';
import { engine, fxs, inst, prices, tx } from './__fixtures__/helpers';

/**
 * Colombian investor (base COP) holding a US stock while USD/COP moves.
 *   BUY 10 AAPL @ 100 USD on 2024-01-15, USD/COP 4000 -> cost 1000 USD = 4,000,000 COP
 *   2024-06-30: price 120, USD/COP 4500 -> MV 1200 USD = 5,400,000 COP
 *     unrealized = 1,400,000 = price (120-100)*10*4000 = 800,000 + FX 1200*(4500-4000) = 600,000
 *   SELL 5 @ 130 on 2024-09-30, USD/COP 4200 -> proceeds 650 USD = 2,730,000 COP; cost 2,000,000
 */
const AAPL = inst('XNAS:AAPL', 'USD');
const fx = fxs('USD', 'COP', { '2024-01-15': 4000, '2024-06-30': 4500, '2024-09-30': 4200 });
const px = prices(AAPL.id, 'USD', { '2024-01-15': 100, '2024-06-30': 120, '2024-09-30': 130 });
const buy = tx({ date: '2024-01-15', type: 'BUY', instrumentId: AAPL.id, quantity: 10, price: 100, currency: 'USD' });
const sell = tx({ date: '2024-09-30', type: 'SELL', instrumentId: AAPL.id, quantity: 5, price: 130, currency: 'USD' });

describe('COP investor holding US stocks: price vs FX decomposition', () => {
  const input = engine({ base: 'COP', instruments: [AAPL], prices: [px], fx: [fx], transactions: [buy, sell] });

  it('splits unrealized gain into price and FX effects that sum exactly', () => {
    const h = computeHoldings(input, '2024-06-30')[0]!;
    expect(h.costBasis).toBe(1000);
    expect(h.costBasisBase).toBe(4_000_000);
    expect(h.marketValue).toBe(1200);
    expect(h.marketValueBase).toBe(5_400_000);
    expect(h.unrealizedGain).toBe(200);
    expect(h.unrealizedGainBase).toBe(1_400_000);
    expect(h.priceGainBase).toBe(800_000);
    expect(h.fxGainBase).toBe(600_000);
    expect(h.priceGainBase! + h.fxGainBase!).toBe(h.unrealizedGainBase);
    expect(h.priceDate).toBe('2024-06-30');
    expect(h.weight).toBe(1);
  });

  it('uses the executed rate (fxRateToBase) as historical FX when given', () => {
    const withRate = engine({
      base: 'COP',
      instruments: [AAPL],
      prices: [px],
      fx: [fx],
      transactions: [{ ...buy, fxRateToBase: 3950 }],
    });
    const h = computeHoldings(withRate, '2024-06-30')[0]!;
    expect(h.costBasisBase).toBe(3_950_000);
    expect(h.priceGainBase).toBeCloseTo((1200 - 1000) * 3950, 6);
    expect(h.fxGainBase).toBeCloseTo(1200 * (4500 - 3950), 6);
    expect(h.priceGainBase! + h.fxGainBase!).toBeCloseTo(h.unrealizedGainBase!, 6);
  });

  it('realized gain in base uses historical FX on both sides', () => {
    const r = realizedGains(input);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ quantity: 5, proceeds: 650, cost: 500, gain: 150, holdingDays: 259 });
    expect(r[0]!.proceedsBase).toBe(2_730_000);
    expect(r[0]!.costBase).toBe(2_000_000);
    expect(r[0]!.gainBase).toBe(730_000);
  });

  it('remaining position after the sale decomposes correctly', () => {
    const h = computeHoldings(input, '2024-09-30')[0]!;
    expect(h.quantity).toBe(5);
    expect(h.priceGainBase).toBeCloseTo((650 - 500) * 4000, 6);
    expect(h.fxGainBase).toBeCloseTo(650 * (4200 - 4000), 6);
  });

  it('same portfolio viewed in USD has no FX effect on USD assets', () => {
    const usd = { ...input, baseCurrency: 'USD' };
    const h = computeHoldings(usd, '2024-06-30')[0]!;
    expect(h.unrealizedGainBase).toBe(200);
    expect(h.fxGainBase).toBe(0);
  });

  it('monthly local vs FX return (no flows): local = price move at constant FX', () => {
    const m = engine({
      base: 'COP',
      instruments: [AAPL],
      prices: [prices(AAPL.id, 'USD', { '2024-01-31': 100, '2024-02-29': 110 })],
      fx: [fxs('USD', 'COP', { '2024-01-31': 4000, '2024-02-29': 4400 })],
      transactions: [
        tx({ date: '2024-01-31', type: 'DEPOSIT', amount: 1000, currency: 'USD' }),
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: AAPL.id, quantity: 10, price: 100, currency: 'USD' }),
      ],
    });
    const rows = monthlyPerformance(m, { to: '2024-02', asOf: '2024-02-29' });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.twr).toBe(0);
    expect(rows[0]!.netFlowsBase).toBe(4_000_000);
    const feb = rows[1]!;
    // 1100*4400 / (1000*4000) - 1 = 0.21 ; local = 1100*4000/4,000,000 - 1 = 0.10 ; fx = 0.11
    expect(feb.twr).toBeCloseTo(0.21, 12);
    expect(feb.localReturn).toBeCloseTo(0.1, 12);
    expect(feb.fxReturn).toBeCloseTo(0.11, 12);
    expect(feb.localReturn! + feb.fxReturn!).toBeCloseTo(feb.twr, 14);
  });
});

describe('missing data', () => {
  it('values holdings without price at cost and flags them; flags missing FX', () => {
    const FUND = inst('MANUAL:FIC1', 'COP', { pricing: 'manual' });
    const input = engine({
      base: 'COP',
      instruments: [FUND, AAPL],
      prices: [],
      fx: [],
      options: { implicitCashFlows: false },
      transactions: [
        tx({ date: '2024-01-15', type: 'BUY', instrumentId: FUND.id, quantity: 100, price: 1000, fees: 500, currency: 'COP' }),
        tx({ date: '2024-01-15', type: 'DEPOSIT', amount: 50, currency: 'MXN' }),
      ],
    });
    const v = valuePortfolio(input, '2024-02-01');
    expect(v.missingPrices).toEqual(['MANUAL:FIC1']);
    expect(v.missingFx).toEqual(['MXN']);
    const h = v.holdings[0]!;
    expect(h.marketValue).toBe(100_500);
    expect(h.marketValueBase).toBe(100_500);
    expect(h.unrealizedGainBase).toBe(0);
    expect(v.cash.find((c) => c.currency === 'MXN')!.amountBase).toBeUndefined();
    expect(v.totalMarketValueBase).toBe(100_500 - 100_500); // COP cash is -100,500 (margin), MXN unpriced
  });

  it('bond quoted per 100 (priceMultiplier)', () => {
    const BOND = inst('MANUAL:TES2030', 'COP', { assetClass: 'bond', priceMultiplier: 100 });
    const input = engine({
      base: 'COP',
      instruments: [BOND],
      prices: [prices(BOND.id, 'COP', { '2024-01-01': 98.5, '2024-06-01': 101 })],
      transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: BOND.id, quantity: 1_000_000, price: 98.5, currency: 'COP' })],
    });
    const h = computeHoldings(input, '2024-06-30')[0]!;
    expect(h.costBasis).toBe(985_000);
    expect(h.marketValue).toBe(1_010_000);
  });
});
