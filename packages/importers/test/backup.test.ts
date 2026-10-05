import { describe, expect, it } from 'vitest';
import { BACKUP_SCHEMA_VERSION, createBackup, parseBackup, serializeBackup, validateBackup } from '../src';

const sample = () =>
  createBackup({
    exportedAt: '2024-06-30T12:00:00.000Z',
    portfolios: [{ id: 'p1', name: 'Principal', baseCurrency: 'COP', costMethod: 'FIFO', createdAt: '2024-01-01', taxResidence: 'CO' }],
    instruments: [
      { id: 'XBOG:ECOPETROL', symbol: 'ECOPETROL', name: 'Ecopetrol', exchange: 'XBOG', currency: 'COP', country: 'CO', assetClass: 'equity' },
      { id: 'MANUAL:CDT-1', symbol: 'CDT-1', name: 'CDT 1 año', exchange: 'MANUAL', currency: 'COP', country: 'CO', assetClass: 'fixed_income', pricing: 'manual' },
    ],
    transactions: [
      { id: 't1', portfolioId: 'p1', date: '2024-01-02', type: 'DEPOSIT', currency: 'COP', amount: 1e7 },
      { id: 't2', portfolioId: 'p1', date: '2024-01-03', type: 'BUY', instrumentId: 'XBOG:ECOPETROL', quantity: 100, price: 2450, currency: 'COP' },
    ],
    manualPrices: [{ instrumentId: 'MANUAL:CDT-1', currency: 'COP', source: 'manual', points: [{ date: '2024-01-31', close: 1_008_000 }] }],
    settings: { viewCurrency: 'USD' },
  });

describe('JSON backup', () => {
  it('serializes and parses back identically', () => {
    const b = sample();
    expect(b.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    const v = parseBackup(serializeBackup(b));
    expect(v.ok).toBe(true);
    expect(v.backup).toEqual(b);
  });
  it('reports structural errors with paths', () => {
    const b = sample() as unknown as Record<string, unknown>;
    const txs = b.transactions as Record<string, unknown>[];
    txs[1]!.instrumentId = 'XBOG:NOPE';
    txs[0]!.date = '02/01/2024';
    txs.push({ ...txs[0]!, id: 't1', type: 'COMPRA' });
    const v = validateBackup(b);
    expect(v.ok).toBe(false);
    const paths = v.errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['transactions[1].instrumentId', 'transactions[0].date', 'transactions[2].id', 'transactions[2].type']));
  });
  it('rejects unknown formats, future versions and invalid JSON', () => {
    expect(validateBackup({ format: 'other', schemaVersion: 1 }).errors[0]!.path).toBe('format');
    expect(validateBackup({ ...sample(), schemaVersion: 99 }).errors[0]!.message).toMatch(/más nueva/);
    expect(parseBackup('{oops').ok).toBe(false);
    expect(validateBackup([]).ok).toBe(false);
  });
  it('migrates schema v0 (prices → manualPrices)', () => {
    const { manualPrices, ...rest } = sample();
    const v = validateBackup({ ...rest, schemaVersion: 0, prices: manualPrices });
    expect(v.ok).toBe(true);
    expect(v.backup!.schemaVersion).toBe(1);
    expect(v.backup!.manualPrices).toHaveLength(1);
  });
});
