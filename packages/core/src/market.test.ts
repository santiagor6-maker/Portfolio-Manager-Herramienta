import { describe, expect, it } from 'vitest';
import { createMarketData } from './api';
import { fxs, prices } from './__fixtures__/helpers';
import { addMonths, isoToDay, dayToIso, monthEnd, isValidIsoDate } from './dates';

describe('createMarketData: prices', () => {
  const m = createMarketData({
    prices: [prices('XNAS:AAPL', 'USD', { '2024-01-02': 185, '2024-01-03': 184, '2024-01-10': 186 })],
    fx: [],
    manualPrices: [prices('XNAS:AAPL', 'USD', { '2024-01-03': 190, '2024-01-05': 191 })],
  });

  it('fills forward and returns undefined before the first point', () => {
    expect(m.price('XNAS:AAPL', '2024-01-01')).toBeUndefined();
    expect(m.price('XNAS:AAPL', '2024-01-02')).toBe(185);
    expect(m.price('XNAS:AAPL', '2024-01-09')).toBe(191);
    expect(m.price('XNAS:AAPL', '2024-01-10')).toBe(186);
    expect(m.price('XNAS:AAPL', '2030-01-01')).toBe(186);
    expect(m.price('UNKNOWN', '2024-01-10')).toBeUndefined();
  });

  it('manual prices override provider prices on the same date', () => {
    expect(m.price('XNAS:AAPL', '2024-01-03')).toBe(190);
    expect(m.price('XNAS:AAPL', '2024-01-04')).toBe(190);
  });

  it('exposes the price point date', () => {
    expect(m.pricePoint('XNAS:AAPL', '2024-01-08')).toEqual({ date: '2024-01-05', close: 191 });
  });

  it('normalizes pence quotes (GBp) to pounds', () => {
    const g = createMarketData({ prices: [prices('XLON:VOD', 'GBp', { '2024-01-02': 70 })], fx: [] });
    expect(g.price('XLON:VOD', '2024-01-02')).toBeCloseTo(0.7, 12);
    expect(g.priceCurrency('XLON:VOD')).toBe('GBP');
  });

  it('binary search handles many points', () => {
    const pts: Record<string, number> = {};
    for (let d = isoToDay('2015-01-01'); d < isoToDay('2025-01-01'); d += 1) pts[dayToIso(d)] = d;
    const big = createMarketData({ prices: [prices('X', 'USD', pts)], fx: [] });
    expect(big.price('X', '2020-02-29')).toBe(isoToDay('2020-02-29'));
    expect(big.price('X', '2030-02-28')).toBe(isoToDay('2024-12-31'));
  });
});

describe('createMarketData: fx', () => {
  const m = createMarketData({
    prices: [],
    fx: [
      fxs('USD', 'COP', { '2024-01-31': 3900, '2024-02-29': 3950 }),
      fxs('USD', 'BRL', { '2024-01-31': 4.95, '2024-02-29': 5.0 }),
      fxs('EUR', 'USD', { '2024-01-31': 1.08, '2024-02-29': 1.1 }),
      fxs('EUR', 'CHF', { '2024-01-31': 0.93 }),
      fxs('GBP', 'USD', { '2024-01-31': 1.27 }),
    ],
  });

  it('same currency = 1 even without data', () => {
    expect(m.fx('COP', 'COP', '1990-01-01')).toBe(1);
  });

  it('direct and inverse pairs with fill-forward', () => {
    expect(m.fx('USD', 'COP', '2024-02-15')).toBe(3900);
    expect(m.fx('COP', 'USD', '2024-02-29')).toBeCloseTo(1 / 3950, 15);
    expect(m.fx('USD', 'COP', '2024-01-30')).toBeUndefined();
  });

  it('triangulates through USD', () => {
    // BRL -> COP = (1 / USDBRL) * USDCOP
    expect(m.fx('BRL', 'COP', '2024-02-29')).toBeCloseTo(3950 / 5.0, 10);
    expect(m.fx('COP', 'BRL', '2024-02-29')).toBeCloseTo(5.0 / 3950, 14);
    expect(m.fx('EUR', 'COP', '2024-02-29')).toBeCloseTo(1.1 * 3950, 9);
  });

  it('triangulates through EUR when USD is not linked', () => {
    // CHF only quoted vs EUR: CHF -> USD = (1/0.93) * 1.08
    expect(m.fx('CHF', 'USD', '2024-01-31')).toBeCloseTo(1.08 / 0.93, 12);
  });

  it('finds longer paths (CHF -> COP via EUR and USD)', () => {
    expect(m.fx('CHF', 'COP', '2024-01-31')).toBeCloseTo((1 / 0.93) * 1.08 * 3900, 8);
    expect(m.fx('GBP', 'BRL', '2024-01-31')).toBeCloseTo(1.27 * 4.95, 10);
  });

  it('falls back to triangulation when a direct series starts later', () => {
    const mm = createMarketData({
      prices: [],
      fx: [
        fxs('BRL', 'COP', { '2024-06-30': 700 }),
        fxs('USD', 'COP', { '2024-01-31': 3900 }),
        fxs('USD', 'BRL', { '2024-01-31': 5 }),
      ],
    });
    expect(mm.fx('BRL', 'COP', '2024-03-01')).toBeCloseTo(780, 10);
    expect(mm.fx('BRL', 'COP', '2024-07-01')).toBe(700);
  });

  it('returns undefined for unknown currencies', () => {
    expect(m.fx('XYZ', 'COP', '2024-02-29')).toBeUndefined();
  });

  it('fxNearest looks forward when there is no earlier point', () => {
    expect(m.fxNearest('USD', 'COP', isoToDay('2023-12-01'))).toBe(3900);
  });
});

describe('dates', () => {
  it('month arithmetic clamps to month end', () => {
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');
    expect(addMonths('2023-03-31', -1)).toBe('2023-02-28');
    expect(addMonths('2024-01-15', 12)).toBe('2025-01-15');
    expect(monthEnd('2024-02')).toBe('2024-02-29');
    expect(isValidIsoDate('2024-02-30')).toBe(false);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
  });
});
