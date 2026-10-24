/** Round 8 (reviews/web-r7.md): W61 idempotent writes, W64 splits for every holder. */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { addTransactionsOnce, saveTransaction } from '../db/repo';
import { createDepositFor, fixUnit, holdersBefore, recordSplit } from '../components/DiagnosticsPanel';
import { acceptSuggestions } from '../services/suggestions';
import { once, txDedupeKey } from '../lib/writeGuard';

let n = 0;
beforeEach(() => {
  schema.resetDbInstance(`r8-db-${++n}`);
});
afterEach(async () => {
  await schema.db.delete();
});

const NVDA = 'XNAS:NVDA';
const buy = (portfolioId: string, quantity: number, date = '2023-01-05') =>
  saveTransaction({ portfolioId, date, type: 'BUY', instrumentId: NVDA, quantity, price: 142.65, amount: quantity * 142.65, currency: 'USD' });
const splits = async () => (await schema.db.transactions.where('type').equals('SPLIT').toArray()).map((t) => t.portfolioId).sort();
const t = (k: string) => k;

describe('W61: one-click writes are idempotent', () => {
  it('a double click on "Registrar split" records one SPLIT', async () => {
    await buy('p1', 10_000);
    await Promise.all([recordSplit({ instrumentId: NVDA, ratio: 10, date: '2024-06-10' }, 'p1'), recordSplit({ instrumentId: NVDA, ratio: 10, date: '2024-06-10' }, 'p1')]);
    await recordSplit({ instrumentId: NVDA, ratio: 10, date: '2024-06-10' }, 'p1'); // and a late third click
    expect(await splits()).toEqual(['p1']);
  });

  it('"Crear aporte" twice books one deposit', async () => {
    const tx = await buy('p1', 10);
    const f = { date: '2023-01-05', month: '2023-01', currency: 'USD' as const, amount: 1426.5, transactionId: tx.id };
    await Promise.all([createDepositFor(f, 'n'), createDepositFor(f, 'n')]);
    await createDepositFor({ ...f }, 'n');
    expect(await schema.db.transactions.where('type').equals('DEPOSIT').count()).toBe(1);
  });

  it('"Corregir unidad" divides the price once', async () => {
    const tx = await saveTransaction({ portfolioId: 'p1', date: '2023-01-05', type: 'BUY', instrumentId: NVDA, quantity: 10, price: 14265, amount: 142650, currency: 'USD' });
    await Promise.all([fixUnit(tx, 100), fixUnit(tx, 100)]);
    expect((await schema.db.transactions.get(tx.id))?.price).toBeCloseTo(142.65);
  });

  it('"Registrar todos" twice records each suggestion once', async () => {
    const s = (key: string, date: string) => ({ key, transaction: { id: `sug-${key}`, portfolioId: 'p1', date, type: 'DIVIDEND' as const, instrumentId: NVDA, amount: 12, currency: 'USD' } });
    const list = [s('a', '2024-03-01'), s('b', '2024-06-01')];
    await Promise.all([acceptSuggestions(list, t, 'es-CO'), acceptSuggestions(list, t, 'es-CO')]);
    await acceptSuggestions([{ ...list[0]!, transaction: { ...list[0]!.transaction, id: 'other-id' } }], t, 'es-CO');
    expect(await schema.db.transactions.where('type').equals('DIVIDEND').count()).toBe(2);
  });

  it('cash movements differ by amount; corporate events only by portfolio, instrument and date', async () => {
    const dep = { portfolioId: 'p', date: '2024-01-02', type: 'DEPOSIT' as const, currency: 'COP' as const };
    expect(txDedupeKey({ ...dep, amount: 100 })).not.toBe(txDedupeKey({ ...dep, amount: 200 }));
    const sp = { portfolioId: 'p', date: '2024-01-02', type: 'SPLIT' as const, instrumentId: NVDA };
    expect(txDedupeKey(sp)).toBe(txDedupeKey({ ...sp, amount: 3 }));
    await addTransactionsOnce([{ ...dep, amount: 100 }, { ...dep, amount: 100 }, { ...dep, amount: 200 }]);
    expect(await schema.db.transactions.count()).toBe(2);
  });

  it('once() shares one run per key', async () => {
    let runs = 0;
    const fn = async () => ++runs;
    const [a, b] = await Promise.all([once('k', fn), once('k', fn)]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
  });
});

describe('W64: a split from "Todos" goes to every portfolio holding the instrument', () => {
  it('writes to each holder before the date, not to one that had sold out', async () => {
    await buy('A', 10_000);
    await buy('B', 5_000, '2023-03-01');
    await buy('C', 100);
    await saveTransaction({ portfolioId: 'C', date: '2023-06-01', type: 'SELL', instrumentId: NVDA, quantity: 100, price: 400, amount: 40_000, currency: 'USD' });
    expect((await holdersBefore(NVDA, '2024-06-10')).sort()).toEqual(['A', 'B']);
    expect((await recordSplit({ instrumentId: NVDA, ratio: 10, date: '2024-06-10' })).sort()).toEqual(['A', 'B']);
    await recordSplit({ instrumentId: NVDA, ratio: 10, date: '2024-06-10' });
    expect(await splits()).toEqual(['A', 'B']);
  });
});

describe('W62: B3 grupamentos are never dropped', () => {
  it('a grupamento cached as "SPINOFF to review" becomes a reverse split', async () => {
    const { normalizeProviderAction } = await import('../lib/corporateText');
    const amer = { instrumentId: 'BVMF:AMER3', date: '2024-08-27', type: 'SPLIT' as const, subtype: 'SPINOFF' as const, priceFactor: 0.01, costFraction: -99, reviewRequired: true, source: 'yahoo' };
    expect(normalizeProviderAction(amer)).toMatchObject({ type: 'SPLIT', ratio: 0.01 });
    expect(normalizeProviderAction(amer).subtype).toBeUndefined();
    expect((normalizeProviderAction(amer) as { reviewRequired?: boolean }).reviewRequired).toBeUndefined();
    // A real spin-off (GE 1253:1000 → GEV) is left for review.
    const ge = { instrumentId: 'XNYS:GE', date: '2024-04-02', type: 'SPLIT' as const, subtype: 'SPINOFF' as const, priceFactor: 1.253, targetInstrumentId: 'XNYS:GEV', reviewRequired: true };
    expect(normalizeProviderAction(ge)).toBe(ge);
  });

  it('2.000 AMER3 with the 1:100 grupamento: a pending provider split on the Resumen', async () => {
    const { computeAnalysis } = await import('../services/analysis');
    const { pendingEvents } = await import('../lib/pendingEvents');
    const { normalizeProviderAction } = await import('../lib/corporateText');
    const AMER = { id: 'BVMF:AMER3', symbol: 'AMER3', name: 'Americanas', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' } as const;
    const a = computeAnalysis({
      portfolios: [{ id: 'p', name: 'P', baseCurrency: 'BRL', costMethod: 'AVERAGE', createdAt: '2022-01-01' }],
      transactions: [
        { id: 'd', portfolioId: 'p', date: '2022-12-01', type: 'DEPOSIT', currency: 'BRL', amount: 30_000 },
        { id: 'b', portfolioId: 'p', date: '2022-12-05', type: 'BUY', instrumentId: AMER.id, quantity: 2000, price: 11.5, amount: 23_000, currency: 'BRL' },
      ],
      instruments: [AMER],
      prices: [{ instrumentId: AMER.id, currency: 'BRL', source: 't', points: [{ date: '2022-12-05', close: 11.5 }, { date: '2024-08-26', close: 0.05 }, { date: '2024-08-27', close: 7 }, { date: '2024-10-31', close: 6.63 }] }],
      fx: [],
      manualPrices: [],
      indexSeries: [],
      selectedPortfolioId: 'p',
      reportingCurrency: 'BRL',
      corporateActions: [normalizeProviderAction({ instrumentId: AMER.id, date: '2024-08-27', type: 'SPLIT', subtype: 'SPINOFF', priceFactor: 0.01, reviewRequired: true, source: 'yahoo' } as never)],
      asOf: '2024-10-31',
      benchmarks: [],
      riskFreeRate: 0.1,
      defaultCostMethod: 'AVERAGE',
    } as never);
    const p = pendingEvents(a);
    expect(p.splits).toEqual([expect.objectContaining({ instrumentId: AMER.id, ratio: 0.01, source: 'provider' })]);
    expect(p.review).toEqual([]);
  });

  it('unclassified provider events of held positions are surfaced for review', async () => {
    const { pendingEvents } = await import('../lib/pendingEvents');
    const r = pendingEvents({
      suggestions: [],
      diagnostics: [],
      reviewActions: [{ instrumentId: 'XNYS:GE', date: '2024-04-02', type: 'SPLIT', subtype: 'SPINOFF' } as never, { instrumentId: 'XNYS:SOLD', date: '2024-04-02', type: 'SPLIT' } as never],
      valuation: { holdings: [{ instrumentId: 'XNYS:GE', quantity: 10 }] },
    });
    expect(r.review.map((x) => x.instrumentId)).toEqual(['XNYS:GE']);
  });
});

describe('W64 / W61: one event, every portfolio; duplicates flagged', () => {
  it('suggestions for the same split in two portfolios are kept together', async () => {
    const { pendingEvents } = await import('../lib/pendingEvents');
    const sug = (pid: string) => ({ key: `${pid}|s`, transaction: { id: `${pid}-s`, portfolioId: pid, date: '2024-06-10', type: 'SPLIT' as const, instrumentId: NVDA, ratio: 10, currency: 'USD' } });
    const r = pendingEvents({ suggestions: [sug('A'), sug('B')], diagnostics: [], valuation: { holdings: [{ instrumentId: NVDA, quantity: 15_000 }] } });
    expect(r.splits).toHaveLength(1);
    expect(r.splits[0]!.suggestions.map((s) => s.transaction.portfolioId)).toEqual(['A', 'B']);
  });

  it('duplicateSplits keeps the first row and lists the extras per portfolio', async () => {
    const { duplicateSplits } = await import('../lib/pendingEvents');
    const row = (id: string, portfolioId: string, createdAt: number) => ({ id, portfolioId, instrumentId: NVDA, date: '2024-06-10', createdAt });
    const rows = [row('b', 'A', 2), row('a', 'A', 1), row('c', 'B', 1)];
    expect(duplicateSplits(rows, 'all')).toEqual([{ instrumentId: NVDA, date: '2024-06-10', ids: ['a', 'b'] }]);
    expect(duplicateSplits(rows, 'B')).toEqual([]);
  });
});
