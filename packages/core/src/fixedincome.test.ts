/** C3 — fixed income valued by accrual (CDT, CDB % do CDI, IPCA+), manual override, maturity. */
import { describe, expect, it } from 'vitest';
import { createMarketData, ledgerDiagnostics, monthlyPerformance, performanceSummary, realizedGains, valuePortfolio } from './api';
import type { EngineInput } from './api';
import { businessDaysBetween, isoToDay } from './dates';
import { inst, prices, tx } from './__fixtures__/helpers';
import type { IndexSeries, Instrument } from './types';

const pf = (base: string) => ({ id: 'p1', name: 'p', baseCurrency: base, costMethod: 'FIFO' as const, createdAt: '2020-01-01' });

/** Daily CDI at 0.043739 % per business day (≈ 11.65 % a.a.), Jan-Mar 2024. */
function cdiSeries(): IndexSeries {
  const points: { date: string; value: number }[] = [];
  for (let d = isoToDay('2024-01-02'); d <= isoToDay('2024-03-29'); d++) {
    const w = new Date(d * 86_400_000).getUTCDay();
    if (w === 0 || w === 6) continue;
    points.push({ date: new Date(d * 86_400_000).toISOString().slice(0, 10), value: 0.043739 });
  }
  return { id: 'CDI', kind: 'periodRate', period: 'day', unit: 'percent', currency: 'BRL', source: 'test', points };
}

describe('Colombian CDT at 12 % E.A. (ACT/365)', () => {
  const CDT: Instrument = inst('MANUAL:CDT1', 'COP', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.12, dayCount: 'ACT/365' } });
  const input: EngineInput = {
    portfolio: pf('COP'),
    instruments: [CDT],
    market: createMarketData({ prices: [], fx: [] }),
    transactions: [
      tx({ date: '2024-01-02', type: 'DEPOSIT', amount: 10_000_000, currency: 'COP' }),
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: CDT.id, quantity: 1, price: 10_000_000, currency: 'COP' }),
    ],
    options: { asOf: '2024-12-31' },
  };

  it('S5e: accrues 10M at 12 % E.A. (≈ 11,196,523 on 2024-12-31) and YTD TWR ≈ 11.95 %', () => {
    const expected = 10_000_000 * Math.pow(1.12, 364 / 365);
    const v = valuePortfolio(input, '2024-12-31');
    expect(v.holdings[0]!.priceSource).toBe('accrual');
    expect(v.holdings[0]!.marketValue).toBeCloseTo(expected, 4);
    expect(v.totalMarketValueBase).toBeCloseTo(expected, 4);
    expect(v.missingPrices).toEqual([]);
    expect(performanceSummary(input, 'YTD', '2024-12-31').twr).toBeCloseTo(expected / 10_000_000 - 1, 10);
    const rows = monthlyPerformance(input);
    expect(rows[1]!.twr).toBeCloseTo(Math.pow(1.12, 29 / 365) - 1, 12); // February 2024 = 29 days
  });

  it('a manual price re-anchors the accrual from its date', () => {
    const m = { ...input, market: createMarketData({ prices: [], fx: [], manualPrices: [prices(CDT.id, 'COP', { '2024-07-01': 10_400_000 })] }) };
    const v = valuePortfolio(m, '2024-12-31');
    expect(v.holdings[0]!.marketValue).toBeCloseTo(10_400_000 * Math.pow(1.12, 183 / 365), 4);
  });

  it('is redeemed automatically at maturity at the accrued value', () => {
    const CDT2 = { ...CDT, accrual: { ...CDT.accrual!, maturity: '2024-12-27' } };
    const m = { ...input, instruments: [CDT2] };
    const v = valuePortfolio(m, '2024-12-31');
    expect(v.holdings).toHaveLength(0);
    const proceeds = 10_000_000 * Math.pow(1.12, 360 / 365);
    expect(v.cash[0]!.amount).toBeCloseTo(proceeds, 4);
    const r = realizedGains(m)[0]!;
    expect(r.sellDate).toBe('2024-12-27');
    expect(r.gain).toBeCloseTo(proceeds - 10_000_000, 4);
    expect(ledgerDiagnostics(m).map((d) => d.code)).toContain('MATURITY_REDEEMED');
    // after maturity the money sits in cash: no growth in the last days of December
    expect(performanceSummary(m, 'YTD', '2024-12-31').twr).toBeCloseTo(proceeds / 10_000_000 - 1, 10);
  });
});

describe('Brazilian CDB at 110 % do CDI (BUS/252, daily CDI)', () => {
  const CDB = inst('MANUAL:CDB-XP', 'BRL', { country: 'BR', assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'indexed', index: 'CDI', percentOfIndex: 1.1 } });
  const market = createMarketData({ prices: [], fx: [], indexSeries: [cdiSeries()] });
  const input: EngineInput = {
    portfolio: pf('BRL'),
    instruments: [CDB],
    market,
    transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: CDB.id, quantity: 1, price: 10_000, currency: 'BRL' })],
    options: { asOf: '2024-01-31' },
  };
  it('compounds 1.1 x daily CDI over the business days held (21 days 01-02..01-30)', () => {
    const v = valuePortfolio(input, '2024-01-31');
    expect(v.holdings[0]!.marketValue).toBeCloseTo(10_000 * Math.pow(1 + 1.1 * 0.00043739, 21), 8);
  });
  it('percentOfIndex given as 110 (percent) is read the same way', () => {
    const CDB2 = { ...CDB, accrual: { ...CDB.accrual!, percentOfIndex: 110 } };
    const v = valuePortfolio({ ...input, instruments: [CDB2] }, '2024-01-31');
    expect(v.holdings[0]!.marketValue).toBeCloseTo(10_000 * Math.pow(1 + 1.1 * 0.00043739, 21), 8);
  });
  it('monthly table shows the CDI and "% do CDI" (a 110 % CDB is ~110 % of the CDI)', () => {
    const rows = monthlyPerformance({ ...input, options: { asOf: '2024-03-29' } });
    const feb = rows[1]!;
    expect(feb.indexReturns!.CDI).toBeCloseTo(Math.pow(1.00043739, 21) - 1, 12); // business days 01-31..02-28
    expect(feb.percentOfIndex!.CDI).toBeGreaterThan(1.09);
    expect(feb.percentOfIndex!.CDI).toBeLessThan(1.11);
  });
  it('missing index data is reported, valued at purchase value', () => {
    const v = valuePortfolio({ ...input, market: createMarketData({ prices: [], fx: [] }) }, '2024-01-31');
    expect(v.missingIndex).toEqual(['CDI']);
    expect(v.holdings[0]!.marketValue).toBe(10_000);
    expect(v.holdings[0]!.priceSource).toBe('cost');
  });
});

describe('Tesouro IPCA+ 6 % (monthly IPCA, BUS/252 spread)', () => {
  it('index growth times the real spread', () => {
    const NTNB = inst('MANUAL:IPCA+2035', 'BRL', { country: 'BR', assetClass: 'bond', pricing: 'manual', accrual: { kind: 'indexed', index: 'IPCA', spread: 0.06 } });
    const ipca: IndexSeries = { id: 'IPCA', kind: 'periodRate', period: 'month', unit: 'percent', source: 'test', points: [{ date: '2024-01-01', value: 0.42 }, { date: '2024-02-01', value: 0.83 }] };
    const input: EngineInput = {
      portfolio: pf('BRL'),
      instruments: [NTNB],
      market: createMarketData({ prices: [], fx: [], indexSeries: [ipca] }),
      transactions: [tx({ date: '2024-01-31', type: 'BUY', instrumentId: NTNB.id, quantity: 1, price: 3000, currency: 'BRL' })],
    };
    const v = valuePortfolio(input, '2024-02-29');
    const bus = businessDaysBetween(isoToDay('2024-01-31'), isoToDay('2024-02-29'));
    expect(bus).toBe(21);
    expect(v.holdings[0]!.marketValue).toBeCloseTo(3000 * 1.0083 * Math.pow(1.06, 21 / 252), 8);
  });
});
