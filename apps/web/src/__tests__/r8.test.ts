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
