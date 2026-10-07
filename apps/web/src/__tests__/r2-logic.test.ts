import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { pendingCloses, pendingMonths } from '../lib/pendingCloses';
import { rebalance } from '../lib/rebalance';
import { decryptText, encryptText, isEncrypted } from '../lib/crypto';
import { annualize, ratio } from '../pages/Performance';
import { heatColor } from '../pages/Report';
import { ESSENTIAL_COLUMNS, resolveColumns } from '../pages/Monthly';
import { corporateActionToTransaction } from '../services/importers';
import { exchangeLabel } from '../lib/exchanges';
import { fxReferenceName } from '../components/TransactionForm';
import { resources } from '../i18n';

const FIC: Instrument = { id: 'MANUAL:FIC', symbol: 'FIC', name: 'FIC', exchange: 'MANUAL', currency: 'COP', country: 'CO', assetClass: 'fund', pricing: 'manual' };
const CDT: Instrument = { ...FIC, id: 'MANUAL:CDT', symbol: 'CDT', assetClass: 'fixed_income', accrual: { kind: 'fixed', annualRate: 0.1 } };
const tx = (p: Partial<Transaction>): Transaction => ({ id: Math.random().toString(36), portfolioId: 'p', date: '2026-07-01', type: 'BUY', currency: 'COP', quantity: 10, price: 100, ...p });

describe('W5 pending month-end closes', () => {
  it('flags every month since purchase without a manual price, not just the last one', () => {
    const p = pendingCloses([tx({ instrumentId: FIC.id })], [FIC], [], '2026-10-06');
    expect(p).toEqual([{ instrumentId: FIC.id, months: ['2026-07', '2026-08', '2026-09'] }]);
  });
  it('clears months with a price, ignores accrual instruments and sold positions', () => {
    const prices = [{ instrumentId: FIC.id, currency: 'COP', source: 'manual', points: [{ date: '2026-07-31', close: 101 }] }];
    const txs = [tx({ instrumentId: FIC.id }), tx({ instrumentId: FIC.id, type: 'SELL', date: '2026-08-20' }), tx({ instrumentId: CDT.id })];
    expect(pendingCloses(txs, [FIC, CDT], prices, '2026-10-06')).toEqual([]);
    expect(pendingMonths([{ instrumentId: 'a', months: ['2026-08'] }, { instrumentId: 'b', months: ['2026-07', '2026-08'] }])).toEqual(['2026-07', '2026-08']);
  });
});

describe('W11 rebalancing', () => {
  const items = [
    { key: 'equity', value: 700, target: 0.6 },
    { key: 'fixed_income', value: 300, target: 0.4 },
  ];
  it('computes trades to reach target weights', () => {
    const r = rebalance(items);
    expect(r.rows.find((x) => x.key === 'equity')!.trade).toBeCloseTo(-100);
    expect(r.rows.find((x) => x.key === 'fixed_income')!.trade).toBeCloseTo(100);
  });
  it('splits a contribution only across underweight groups first', () => {
    const r = rebalance(items, 100);
    expect(r.rows.find((x) => x.key === 'fixed_income')!.contribution).toBeCloseTo(100);
    expect(r.rows.find((x) => x.key === 'equity')!.contribution).toBeCloseTo(0);
    const big = rebalance(items, 1000);
    expect(big.rows.reduce((s, x) => s + x.contribution, 0)).toBeCloseTo(1000);
  });
});

describe('W10 encrypted backups', () => {
  it('round-trips with the right passphrase and rejects a wrong one', async () => {
    const enc = await encryptText('{"app":"portafolio-pro"}', 'secreto', 1000);
    expect(isEncrypted(enc)).toBe(true);
    expect(enc.data).not.toContain('portafolio');
    expect(await decryptText(enc, 'secreto')).toBe('{"app":"portafolio-pro"}');
    await expect(decryptText(enc, 'otra')).rejects.toThrow('wrong_passphrase');
  });
});

describe('W9 single annualization rule', () => {
  it('never annualizes periods shorter than one year', () => {
    expect(annualize(0.05, 0.4)).toBeUndefined();
    expect(annualize(0.21, 2)).toBeCloseTo(0.1);
    expect(ratio(0.9, 'es-CO')).toBe('0,90');
    expect(ratio(undefined, 'es-CO')).toBe('—');
  });
});

describe('W2 / W3 / W16 helpers', () => {
  it('report heat colours are plain rgb (portable for print and snapshots)', () => {
    expect(heatColor(0.05)).toMatch(/^rgb\(/);
    expect(heatColor(-0.05)).not.toEqual(heatColor(0.05));
    expect(heatColor(0)).toBe('#f3f5f8');
  });
  it('essential monthly columns include price/FX effects and benchmark', () => {
    expect(ESSENTIAL_COLUMNS).toEqual(expect.arrayContaining(['local', 'fx', 'bench', 'alpha', 'real']));
    expect(resolveColumns(['twr', 'gain'])).toEqual(['gain', 'twr']);
    expect(resolveColumns('complete').length).toBeGreaterThan(ESSENTIAL_COLUMNS.length);
  });
  it('shows exchange names instead of MIC codes', () => {
    expect(exchangeLabel('XBOG')).toBe('BVC');
    expect(exchangeLabel('BVMF')).toBe('B3');
    expect(exchangeLabel('XNAS')).toBe('NASDAQ');
  });
  it('picks TRM / PTAX as the FX reference', () => {
    expect(fxReferenceName('COP', 'USD')).toBe('TRM');
    expect(fxReferenceName('USD', 'BRL')).toBe('PTAX');
    expect(fxReferenceName('EUR', 'USD')).toBe('market');
  });
});

describe('importer corporate events', () => {
  it('turns an incorporação into a MERGER split between known instruments', () => {
    const a: Instrument = { id: 'BVMF:AAA3', symbol: 'AAA3', name: 'A', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' };
    const b: Instrument = { ...a, id: 'BVMF:BBB3', symbol: 'BBB3' };
    const t = corporateActionToTransaction(
      { line: 3, date: '2026-05-02', kind: 'merger', description: 'Incorporação', legs: [{ symbol: 'AAA3', quantity: 100, direction: 'out' }, { symbol: 'BBB3', quantity: 50, direction: 'in' }] },
      (s) => [a, b].find((i) => i.symbol === s),
      'p1',
    );
    expect(t).toMatchObject({ type: 'SPLIT', subtype: 'MERGER', instrumentId: a.id, targetInstrumentId: b.id, ratio: 0.5, portfolioId: 'p1' });
    expect(corporateActionToTransaction({ line: 1, date: '2026-01-01', kind: 'spinoff', description: '', legs: [] }, () => undefined, 'p')).toBeUndefined();
  });
});

describe('i18n completeness', () => {
  const keys = (o: object, p = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v as object, `${p}${k}.`) : [`${p}${k}`]));
  it('pt and en have exactly the same keys as es', () => {
    const es = keys(resources.es.translation).sort();
    expect(keys(resources.pt.translation).sort()).toEqual(es);
    expect(keys(resources.en.translation).sort()).toEqual(es);
  });
});
