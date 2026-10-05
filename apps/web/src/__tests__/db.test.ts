import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, PortfolioDB, resetDbInstance, SCHEMA_VERSION } from '../db/schema';
import {
  createPortfolio,
  deletePortfolio,
  DEFAULT_SETTINGS,
  exportBackup,
  loadSettings,
  mergePriceSeries,
  parseBackup,
  removeDemoData,
  restoreBackup,
  saveSetting,
  saveTransaction,
  seedData,
  BackupError,
} from '../db/repo';
import { loadDemoData } from '../services/demo';

let n = 0;
beforeEach(() => {
  resetDbInstance(`test-db-${++n}`);
});
afterEach(async () => {
  await db.delete();
});

describe('settings', () => {
  it('returns defaults and persists changes', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    await saveSetting('reportingCurrency', 'BRL');
    await saveSetting('language', 'pt');
    const s = await loadSettings();
    expect(s.reportingCurrency).toBe('BRL');
    expect(s.language).toBe('pt');
  });
});

describe('portfolios and transactions', () => {
  it('deleting a portfolio cascades to its transactions only', async () => {
    const a = await createPortfolio({ name: 'A', baseCurrency: 'COP' });
    const b = await createPortfolio({ name: 'B', baseCurrency: 'BRL' });
    await saveTransaction({ portfolioId: a.id, date: '2026-01-02', type: 'DEPOSIT', currency: 'COP', amount: 1000 });
    const t = await saveTransaction({ portfolioId: b.id, date: '2026-01-02', type: 'DEPOSIT', currency: 'BRL', amount: 10 });
    expect(t.source).toBe('manual');
    await deletePortfolio(a.id);
    expect(await db.portfolios.count()).toBe(1);
    const left = await db.transactions.toArray();
    expect(left.map((x) => x.portfolioId)).toEqual([b.id]);
  });

  it('merges price series with new points winning', async () => {
    await mergePriceSeries({ instrumentId: 'X:Y', currency: 'USD', source: 'yahoo', points: [{ date: '2026-01-01', close: 1 }, { date: '2026-01-02', close: 2 }] });
    await mergePriceSeries({ instrumentId: 'X:Y', currency: 'USD', source: 'yahoo', points: [{ date: '2026-01-02', close: 3 }, { date: '2026-01-03', close: 4 }] });
    const s = await db.priceSeries.get('X:Y');
    expect(s?.points).toEqual([
      { date: '2026-01-01', close: 1 },
      { date: '2026-01-02', close: 3 },
      { date: '2026-01-03', close: 4 },
    ]);
  });
});

describe('demo data', () => {
  it('seeds the sample portfolio flagged as demo and removes it cleanly', async () => {
    const mine = await createPortfolio({ name: 'Mío', baseCurrency: 'COP' });
    await saveTransaction({ portfolioId: mine.id, date: '2026-01-02', type: 'DEPOSIT', currency: 'COP', amount: 5 });
    await seedData(loadDemoData(), true);
    const demo = (await db.portfolios.toArray()).find((p) => p.isDemo);
    expect(demo).toBeTruthy();
    expect(await db.transactions.where('portfolioId').equals(demo!.id).count()).toBeGreaterThan(50);
    expect(await db.manualPrices.count()).toBeGreaterThan(0);
    await removeDemoData();
    expect((await db.portfolios.toArray()).map((p) => p.name)).toEqual(['Mío']);
    expect(await db.transactions.count()).toBe(1);
    expect(await db.manualPrices.count()).toBe(0);
  });
});

describe('backup', () => {
  it('round-trips through JSON and validates input', async () => {
    const p = await createPortfolio({ name: 'A', baseCurrency: 'USD' });
    await saveTransaction({ portfolioId: p.id, date: '2026-01-02', type: 'DEPOSIT', currency: 'USD', amount: 100 });
    await saveSetting('reportingCurrency', 'EUR');
    const json = JSON.stringify(await exportBackup());
    await db.transactions.clear();
    await db.portfolios.clear();
    const parsed = parseBackup(json);
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    await restoreBackup(parsed, 'replace');
    expect(await db.transactions.count()).toBe(1);
    expect((await loadSettings()).reportingCurrency).toBe('EUR');
    expect(() => parseBackup('{nope')).toThrow(BackupError);
    expect(() => parseBackup('{"app":"other"}')).toThrow('not_a_backup');
    expect(() => parseBackup(JSON.stringify({ app: 'portafolio-pro', schemaVersion: 99, portfolios: [], transactions: [] }))).toThrow('newer_version');
  });
});

describe('schema migrations', () => {
  it('upgrades a v1 database: adds tables and backfills transaction.source', async () => {
    const name = `migration-${n}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({
      portfolios: 'id, name',
      instruments: 'id, symbol, exchange, country, currency',
      transactions: 'id, portfolioId, date, type, instrumentId, importHash, [portfolioId+date]',
      manualPrices: '[instrumentId+date], instrumentId, date',
      priceSeries: 'instrumentId, updatedAt',
      fxSeries: 'pair, updatedAt',
      settings: 'key',
    });
    await v1.table('transactions').add({ id: 't1', portfolioId: 'p', date: '2025-01-01', type: 'DEPOSIT', currency: 'COP', amount: 1 });
    v1.close();

    const v2 = new PortfolioDB(name);
    await v2.open();
    expect(v2.verno).toBe(SCHEMA_VERSION);
    expect((await v2.transactions.get('t1'))?.source).toBe('manual');
    await v2.meta.put({ key: 'x', value: 1 });
    expect(await v2.meta.count()).toBe(1);
    await v2.delete();
  });
});
