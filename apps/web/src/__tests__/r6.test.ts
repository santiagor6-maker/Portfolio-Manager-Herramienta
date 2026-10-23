/** Round 6 (reviews/web-r5.md): W49–W54. */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction, Valuation } from '@pm/core';
import { priceCoverage } from '../services/analysis';
import { unpricedMonths } from '../hooks/useAnalysis';

const PETR: Instrument = { id: 'BVMF:PETR4', symbol: 'PETR4', name: 'Petrobras PN', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' };
const CDT: Instrument = { ...PETR, id: 'MANUAL:CDT', symbol: 'CDT', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.1 } };
const buy = (instrumentId: string, date: string): Transaction => ({ id: date + instrumentId, portfolioId: 'p', date, type: 'BUY', instrumentId, quantity: 1, price: 10, currency: 'BRL' });

describe('W49: months and holdings without market prices', () => {
  it('lists the months after the first buy with no close, and stale market-priced holdings', () => {
    const ds = { instruments: [PETR, CDT], asOf: '2024-06-20', prices: [{ instrumentId: PETR.id, currency: 'BRL', source: 't', points: [{ date: '2024-03-08', close: 10 }] }] };
    const valuation = { holdings: [{ instrumentId: PETR.id, quantity: 1, priceDate: '2024-03-08' }, { instrumentId: CDT.id, quantity: 1 }] } as unknown as Valuation;
    const r = priceCoverage(ds, [buy(PETR.id, '2024-03-08'), buy(CDT.id, '2024-01-02')], valuation);
    expect(r.unpricedMonths).toEqual(['2024-04', '2024-05', '2024-06']);
    expect(r.staleMarket).toEqual([{ instrumentId: PETR.id, priceDate: '2024-03-08' }]); // the CDT accrues: not "stale"
  });
  it('a portfolio with only accrual / manual assets has no unpriced months', () => {
    const r = priceCoverage({ instruments: [CDT], asOf: '2024-06-20', prices: [] }, [buy(CDT.id, '2024-01-02')], undefined);
    expect(r).toEqual({ unpricedMonths: [], staleMarket: [] });
  });
  it('the current month without prices is included', () => {
    expect([...unpricedMonths({ asOf: '2026-10-23', latestPriceDate: '2026-09-30', unpricedMonths: ['2026-05'] })].sort()).toEqual(['2026-05', '2026-10']);
  });
});
