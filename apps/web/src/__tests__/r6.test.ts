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

describe('W45/W53: tax and import texts', () => {
  it('merges the same notice of several years and localizes signed decimals', async () => {
    const { tidyTaxIssues, localizeNumbers } = await import('../lib/taxText');
    const out = tidyTaxIssues(
      ['2023', '2024', '2025'].map((y) => ({ level: 'info', code: 'PARAMS_TO_VERIFY', message: `Alguns parâmetros de ${y} estão marcados para verificação.` })),
      'pt-BR',
    );
    expect(out.map((i) => i.text)).toEqual(['Alguns parâmetros de 2023, 2024, 2025 estão marcados para verificação.']);
    expect(localizeNumbers('o líquido calculado (-2000.6) não confere (de 2023-01-02): 0.07', 'pt-BR')).toBe('o líquido calculado (-2.000,6) não confere (de 02/01/2023): 0,07');
  });
  it('words provider corporate actions in the UI language', async () => {
    const { corporateNote, formatRatio } = await import('../lib/corporateText');
    const t = (k: string, o?: Record<string, unknown>) => `${k}:${String(o?.pct ?? o?.ratio ?? '')}`;
    expect(corporateNote({ type: 'STOCK_DIVIDEND', ratio: 4 / 3, note: 'For IR the new shares…' }, t, 'pt-BR')).toBe('ca.note.bonus:33,33%');
    expect(formatRatio(1.03, 'pt-BR')).toBe('×1,03');
  });
  it('time-axis ticks follow the language', async () => {
    const { timeTick } = await import('../components/charts');
    expect(timeTick(new Date(2026, 3, 1).getTime(), 'pt-BR')).toBe('Abr');
    expect(timeTick(new Date(2026, 0, 1).getTime(), 'es-CO')).toBe('2026');
  });
  it('axis labels get enough compact digits to tell ticks apart', async () => {
    const { axisCompactDigits } = await import('../lib/format');
    expect(axisCompactDigits(50_100, 50_200)).toBe(2); // 50,12 mil … not "50,1 mil" × 3
    expect(axisCompactDigits(90e6, 400e6)).toBe(0);
  });
});

describe('D16: price decimals', () => {
  it('uses the currency decimals and 4 only when a small price has them', async () => {
    const { formatPrice } = await import('../lib/format');
    expect(formatPrice(2.5, 'USD', 'en-US')).toBe('$2.50');
    expect(formatPrice(0.5432, 'USD', 'en-US')).toBe('$0.5432');
    expect(formatPrice(38_500, 'COP', 'es-CO')).toBe('$ 38.500');
  });
});
