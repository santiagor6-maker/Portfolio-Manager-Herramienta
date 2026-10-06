/** C5 — per-position performance (hand-computed). */
import { describe, expect, it } from 'vitest';
import { positionPerformance } from './api';
import { engine, fxs, inst, prices, tx } from './__fixtures__/helpers';

describe('positionPerformance', () => {
  /**
   * Buy 10 @ 100 (01-31), dividend 50 (02-15), sell 5 @ 120 (02-20), close 125 (02-29).
   *   invested 1000, income 50, proceeds 600, end 625 -> total return 275
   *   realized 5*(120-100) = 100, unrealized 5*(125-100) = 125, income 50  (sum 275)
   *   TWR = (1 + 50/1000) * 120/100 * 125/120 - 1 = 1.05 * 1.25 - 1 = 31.25 %
   */
  const X = inst('X', 'COP');
  const input = engine({
    base: 'COP',
    instruments: [X],
    prices: [prices('X', 'COP', { '2024-01-31': 100, '2024-02-20': 120, '2024-02-29': 125 })],
    transactions: [
      tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100, currency: 'COP' }),
      tx({ date: '2024-02-15', type: 'DIVIDEND', instrumentId: 'X', amount: 50, currency: 'COP' }),
      tx({ date: '2024-02-20', type: 'SELL', instrumentId: 'X', quantity: 5, price: 120, currency: 'COP' }),
    ],
    options: { asOf: '2024-02-29' },
  });

  it('total return in money splits into realized + unrealized + income', () => {
    const p = positionPerformance(input, 'SI', '2024-02-29')[0]!;
    expect(p).toMatchObject({ instrumentId: 'X', quantityStart: 0, quantityEnd: 5, startValueBase: 0, endValueBase: 625, investedBase: 1000, proceedsBase: 600, incomeBase: 50 });
    expect(p.totalReturnBase).toBeCloseTo(275, 9);
    expect(p.realizedGainBase).toBeCloseTo(100, 9);
    expect(p.unrealizedGainBase).toBeCloseTo(125, 9);
    expect(p.realizedGainBase + p.unrealizedGainBase + p.incomeBase).toBeCloseTo(p.totalReturnBase, 9);
    expect(p.fxGainBase).toBeCloseTo(0, 9);
    expect(p.simpleReturn).toBeCloseTo(0.275, 12);
  });

  it('position TWR (dividend reinvested in the time-weighting) and IRR', () => {
    const p = positionPerformance(input, 'SI', '2024-02-29')[0]!;
    expect(p.twr).toBeCloseTo(1.05 * 1.25 - 1, 12);
    // IRR solves -1000 (01-31) + 50 (02-15) + 600 (02-20) + 625 (02-29) = 0, ACT/ACT (366-day year)
    const npv = (r: number) => -1000 + 50 * (1 + r) ** (-15 / 366) + 600 * (1 + r) ** (-20 / 366) + 625 * (1 + r) ** (-29 / 366);
    expect(Math.abs(npv(p.irr!))).toBeLessThan(1e-6);
    expect(p.irrPeriod).toBeCloseTo(Math.pow(1 + p.irr!, 29 / 366) - 1, 12);
  });

  it('a sub-period starts from the market value at the start', () => {
    const p = positionPerformance(input, 'CUSTOM', '2024-02-29', { from: '2024-02-16', to: '2024-02-29' })[0]!;
    expect(p.startValueBase).toBe(1000);
    expect(p.incomeBase).toBe(0);
    expect(p.twr).toBeCloseTo(0.25, 12);
    expect(p.totalReturnBase).toBeCloseTo(625 - 1000 + 600, 9);
  });

  it('a closed position keeps its realized result; FX part for a foreign position', () => {
    const A = inst('AAPL', 'USD');
    const fx = engine({
      base: 'COP',
      instruments: [A],
      prices: [prices('AAPL', 'USD', { '2024-01-02': 100 })],
      fx: [fxs('USD', 'COP', { '2024-01-01': 4000, '2024-06-01': 4400 })],
      transactions: [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'AAPL', quantity: 10, price: 100, currency: 'USD' }),
        tx({ date: '2024-06-03', type: 'SELL', instrumentId: 'AAPL', quantity: 10, price: 100, currency: 'USD' }),
      ],
      options: { asOf: '2024-06-30' },
    });
    const p = positionPerformance(fx, 'SI', '2024-06-30')[0]!;
    expect(p.quantityEnd).toBe(0);
    expect(p.endValueBase).toBe(0);
    expect(p.totalReturnBase).toBeCloseTo(400_000, 6);
    expect(p.realizedGainBase).toBeCloseTo(400_000, 6);
    expect(p.fxGainBase).toBeCloseTo(400_000, 6);
    expect(p.twr).toBeCloseTo(0.1, 12);
  });
});
