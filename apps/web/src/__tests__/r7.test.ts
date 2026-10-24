/** Round 7 (reviews/web-r6.md): W55–W60. */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { computeAnalysis, type Dataset } from '../services/analysis';
import { pendingEvents } from '../lib/pendingEvents';

const NVDA: Instrument = { id: 'XNAS:NVDA', symbol: 'NVDA', name: 'NVIDIA', exchange: 'XNAS', currency: 'USD', country: 'US', assetClass: 'equity' };
const PETR: Instrument = { id: 'BVMF:PETR4', symbol: 'PETR4', name: 'Petrobras PN', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' };
const tx = (t: Partial<Transaction>): Transaction => ({ id: `t${Math.random()}`, portfolioId: 'p', date: '2023-01-05', type: 'DEPOSIT', currency: 'USD', ...t }) as Transaction;

function ds(over: Partial<Dataset>): Dataset {
  return {
    portfolios: [{ id: 'p', name: 'P', baseCurrency: 'USD', costMethod: 'FIFO', createdAt: '2023-01-01' }],
    transactions: [],
    instruments: [NVDA, PETR],
    prices: [],
    fx: [{ base: 'USD', quote: 'BRL', source: 't', points: [{ date: '2022-12-01', rate: 5 }] }],
    manualPrices: [],
    indexSeries: [],
    selectedPortfolioId: 'p',
    reportingCurrency: 'USD',
    asOf: '2024-10-01',
    benchmarks: [],
    riskFreeRate: 0.04,
    defaultCostMethod: 'FIFO',
    ...over,
  };
}

describe('W55: pending corporate events reach the Resumen', () => {
  it('NVDA bought before the 10:1 split of 2024-06-10: the split is a pending event of a held position', () => {
    const a = computeAnalysis(
      ds({
        transactions: [tx({ amount: 1_500_000 }), tx({ type: 'BUY', instrumentId: NVDA.id, quantity: 10_000, price: 142.65, amount: 1_426_500 })],
        prices: [{ instrumentId: NVDA.id, currency: 'USD', source: 't', points: [{ date: '2023-01-05', close: 142.65 }, { date: '2024-06-07', close: 1208.88 }, { date: '2024-06-10', close: 121.79 }, { date: '2024-09-30', close: 121.44 }] }],
        corporateActions: [{ instrumentId: NVDA.id, type: 'SPLIT', date: '2024-06-10', ratio: 10, source: 'yahoo' } as never],
      }),
    );
    const p = pendingEvents(a);
    expect(p.splits).toHaveLength(1);
    expect(p.splits[0]).toMatchObject({ instrumentId: NVDA.id, date: '2024-06-10', ratio: 10 });
    expect(p.splits[0]!.suggestion).toBeDefined();
    expect(p.total).toBeGreaterThan(0);
  });

  it('an inferred split (price history only) is also pending when the position is held', () => {
    const a = computeAnalysis(
      ds({
        transactions: [tx({ amount: 1_500_000 }), tx({ type: 'BUY', instrumentId: NVDA.id, quantity: 10_000, price: 142.65, amount: 1_426_500 })],
        prices: [{ instrumentId: NVDA.id, currency: 'USD', source: 't', points: [{ date: '2023-01-05', close: 142.65 }, { date: '2024-06-07', close: 1208.88 }, { date: '2024-06-10', close: 121.79 }, { date: '2024-09-30', close: 121.44 }] }],
      }),
    );
    const p = pendingEvents(a);
    expect(p.splits.map((x) => [x.instrumentId, x.ratio])).toEqual([[NVDA.id, 10]]);
    expect(p.splits[0]!.suggestion).toBeUndefined();
  });

  it('announced Brazilian proventos are pending income, not "no hay proventos"', () => {
    const a = computeAnalysis(
      ds({
        portfolios: [{ id: 'p', name: 'P', baseCurrency: 'BRL', costMethod: 'FIFO', createdAt: '2023-01-01' }],
        reportingCurrency: 'BRL',
        transactions: [tx({ amount: 10_000, currency: 'BRL' }), tx({ type: 'BUY', instrumentId: PETR.id, quantity: 100, price: 25, amount: 2_500, currency: 'BRL' })],
        prices: [{ instrumentId: PETR.id, currency: 'BRL', source: 't', points: [{ date: '2023-01-05', close: 25 }, { date: '2024-09-30', close: 36 }] }],
        corporateActions: ['2024-03-01', '2024-06-03'].map((d) => ({ instrumentId: PETR.id, type: 'DIVIDEND', date: d, amountPerShare: 1.2, currency: 'BRL', source: 'yahoo' }) as never),
      }),
    );
    const p = pendingEvents(a);
    expect(p.income.length).toBe(2);
    expect(a.income).toHaveLength(0);
  });
});

describe('W56: redundant columns give way first', () => {
  it('flags all-zero and duplicate candidate columns, never the ones it is not allowed to hide', async () => {
    const { redundantColumns } = await import('../lib/columnStats');
    const rows = [
      { twr: 0.01, local: 0.01, fx: 0, flows: 0, income: 0 },
      { twr: -0.02, local: -0.02, fx: 0, flows: 100, income: 0 },
    ];
    const v = (id: string, r: Record<string, number>) => r[id];
    expect(redundantColumns(['twr', 'local', 'fx', 'flows', 'income'], rows, v as never, ['local', 'fx'])).toEqual(['local', 'fx']);
    // "income" is all zero but is not a candidate (dividends are never hidden).
    expect(redundantColumns(['twr', 'income'], rows, v as never, ['twr'])).toEqual([]);
  });
});

describe('W57: compact amounts', () => {
  it('Spanish uses millions and "mil", never MRD, with the full amount spacing', async () => {
    const { formatMoney } = await import('../lib/format');
    const c = (v: number, signed = false) => formatMoney(v, 'COP', 'es-CO', { compact: true, signed });
    expect(c(-8_568_345_718)).toMatch(/^-\$\s8\.568\sM$/);
    expect(c(62_804_000_000, true)).toMatch(/^\+\$\s62\.804\sM$/);
    expect(c(789_600_000, true)).toMatch(/^\+\$\s789,6\sM$/);
    expect(c(12_000)).toMatch(/^\$\s12\smil$/);
    expect(c(3_730.04)).toMatch(/^\$\s3,7\smil$/);
    expect(formatMoney(3_730.04, 'BRL', 'pt-BR', { compact: true })).toMatch(/R\$\s3,7\smil/);
    // The unit follows the rounded value.
    expect(c(999_960)).toMatch(/^\$\s1\sM$/);
    expect(c(999.7)).toMatch(/^\$\s1\smil$/);
  });

  it('split ratios read in the locale', async () => {
    const { formatSplitRatio } = await import('../lib/corporateText');
    expect(formatSplitRatio(10, 'es-CO')).toBe('10:1');
    expect(formatSplitRatio(1.5, 'es-CO')).toBe('1,5:1');
    expect(formatSplitRatio(0.1, 'pt-BR')).toBe('1:10');
  });
});

describe('W60: residual strings', () => {
  it('localizes a decimal that ends a sentence and drops the duplicated preposition', async () => {
    const { localizeNumbers } = await import('../lib/taxText');
    expect(localizeNumbers('Valores não atribuídos ao à vista: 0.07.', 'pt-BR')).toBe('Valores não atribuídos à vista: 0,07.');
    expect(localizeNumbers('Lei 14.754.', 'pt-BR')).toBe('Lei 14.754.');
    expect(localizeNumbers('vence 2025-01-09', 'es-CO')).toBe('vence 09/01/2025');
  });

  it('pluralizes the import summary and keeps developer commands out of the price banner', async () => {
    const i18next = (await import('i18next')).default;
    const { translationsFor } = await import('../i18n');
    for (const [lng, one, other] of [['es', 'Se agregó 1 activo nuevo', 'Se agregaron 3 activos nuevos'], ['pt', '1 ativo novo adicionado', '3 ativos novos adicionados'], ['en', '1 new asset added', '3 new assets added']] as const) {
      const inst = i18next.createInstance();
      await inst.init({ lng, resources: { [lng]: { translation: await translationsFor(lng) } } });
      expect(inst.t('imp.doneBody', { count: 1 })).toContain(one);
      expect(inst.t('imp.doneBody', { count: 3 })).toContain(other);
      expect(inst.t('imp.doneBody', { count: 0 })).not.toMatch(/\b0\b/);
      expect(inst.t('market.offlineBody')).not.toContain('npm');
    }
  });
});

describe('W55 review: only confirmed valuation warnings count', () => {
  it('ignores weak (info) split hints and unit suspects the engine already accepted', () => {
    const data = { splitRatio: 2, instrumentId: 'XNAS:NVDA', dateTo: '2024-06-10' };
    const base = { suggestions: [], valuation: { holdings: [{ instrumentId: 'XNAS:NVDA', quantity: 10 }] } };
    const diag = (over: Record<string, unknown>) => ({ code: 'POSSIBLE_UNRECORDED_SPLIT', severity: 'warning', message: 'x', data, ...over }) as never;
    expect(pendingEvents({ ...base, diagnostics: [diag({ severity: 'info' })] }).splits).toEqual([]);
    expect(pendingEvents({ ...base, diagnostics: [diag({})] }).splits).toHaveLength(1);
    const unit = (message: string) => diag({ code: 'TRADE_PRICE_UNIT_SUSPECT', message, data: undefined });
    expect(pendingEvents({ ...base, diagnostics: [unit('Trade price 14265 vs 142.65 — accepted because 3 consistent prices on distinct days confirm the new level')] }).valuationWarnings).toEqual([]);
    expect(pendingEvents({ ...base, diagnostics: [unit('Trade price 14265 vs 142.65')] }).valuationWarnings).toHaveLength(1);
  });
});
