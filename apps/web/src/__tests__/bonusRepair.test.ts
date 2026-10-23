import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { CorporateAction, Transaction } from '@pm/core';
import { bonusRatioWarnings, legacyBonusFixes } from '../lib/bonusRepair';
import { describeDiagnostic } from '../lib/diagnosticText';
import { esR5 } from '../i18n/es.r5';
import { ptR5 } from '../i18n/pt.r5';
import { enR5 } from '../i18n/en.r5';

const ITUB = 'BVMF:ITUB4';
const sd = (id: string, extra: Partial<Transaction> = {}): Transaction => ({ id, portfolioId: 'p', date: '2025-03-18', type: 'STOCK_DIVIDEND', instrumentId: ITUB, ratio: 1.1, currency: 'BRL', ...extra });
// Cached provider action as stored before the market-data fix (ratio == priceFactor) and after it.
const oldAction: CorporateAction & { priceFactor: number } = { instrumentId: ITUB, date: '2025-03-18', type: 'STOCK_DIVIDEND', ratio: 1.1, priceFactor: 1.1, source: 'yahoo' };
const newAction: CorporateAction & { priceFactor: number } = { ...oldAction, ratio: 0.1 };

describe('bonificação ratio repair: matching', () => {
  it('fixes only STOCK_DIVIDENDs by ratio that match a cached provider action', () => {
    const txs = [
      sd('match'),
      sd('qty', { quantity: 10 }), // recorded by quantity: ratio is not what core applies
      sd('small', { ratio: 0.1 }), // already the core convention
      sd('otherDate', { date: '2025-03-19' }),
      sd('otherInst', { instrumentId: 'BVMF:BBAS3' }),
      sd('otherRatio', { ratio: 1.5 }), // a user's own 150 % bonus: not the provider factor
      { ...sd('split'), type: 'SPLIT' as const },
    ];
    expect(legacyBonusFixes(txs, [oldAction])).toEqual([{ id: 'match', ratio: 0.1 }]);
    // the corrected cache keeps the old value in priceFactor
    expect(legacyBonusFixes(txs, [newAction])).toEqual([{ id: 'match', ratio: 0.1 }]);
    expect(legacyBonusFixes(txs, [])).toEqual([]);
  });

  it('matches within 1e-6, on the ex-date too, and rounds to 1e-6', () => {
    const a = { ...oldAction, date: '2025-03-20', exDate: '2025-03-18', ratio: 1.03, priceFactor: 1.03 };
    expect(legacyBonusFixes([sd('x', { ratio: 1.0300004 })], [a])).toEqual([{ id: 'x', ratio: 0.03 }]);
    expect(legacyBonusFixes([sd('y', { ratio: 1.03002 })], [a])).toEqual([]);
  });
});

describe('bonificação ratio repair: database, once', () => {
  it('rewrites the matches, leaves the rest, records the repair and the notice', async () => {
    const schema = await import('../db/schema');
    const db = schema.resetDbInstance('bonus-repair');
    const { repairBonusRatios, BONUS_REPAIR_DONE, BONUS_REPAIR_NOTICE } = await import('../db/repairs');
    await db.transactions.bulkPut([sd('m1'), sd('m2', { date: '2025-12-22', ratio: 1.03 }), sd('u1', { ratio: 1.5 }), sd('q1', { quantity: 10 })]);
    await db.corporateActions.bulkPut([
      { ...newAction, id: `${ITUB}|STOCK_DIVIDEND|2025-03-18`, updatedAt: 1 },
      { ...oldAction, date: '2025-12-22', ratio: 1.03, priceFactor: 1.03, id: `${ITUB}|STOCK_DIVIDEND|2025-12-22`, updatedAt: 1 },
    ]);
    expect(await repairBonusRatios()).toBe(2);
    expect((await db.transactions.get('m1'))!.ratio).toBe(0.1);
    expect((await db.transactions.get('m2'))!.ratio).toBe(0.03);
    expect((await db.transactions.get('u1'))!.ratio).toBe(1.5);
    expect((await db.transactions.get('q1'))!.ratio).toBe(1.1);
    expect((await db.meta.get(BONUS_REPAIR_DONE))!.value).toMatchObject({ count: 2 });
    expect((await db.meta.get(BONUS_REPAIR_NOTICE))!.value).toBe(2);

    // Once: a second start does nothing, even with a new matching row.
    await db.transactions.put(sd('m3'));
    expect(await repairBonusRatios()).toBe(0);
    expect((await db.transactions.get('m3'))!.ratio).toBe(1.1);
    await db.delete();
  });

  it('records the repair without a notice when nothing matched', async () => {
    const schema = await import('../db/schema');
    const db = schema.resetDbInstance('bonus-repair-none');
    const { repairBonusRatios, BONUS_REPAIR_DONE, BONUS_REPAIR_NOTICE } = await import('../db/repairs');
    await db.transactions.put(sd('u1', { ratio: 1.5 }));
    expect(await repairBonusRatios()).toBe(0);
    expect((await db.meta.get(BONUS_REPAIR_DONE))!.value).toMatchObject({ count: 0 });
    expect(await db.meta.get(BONUS_REPAIR_NOTICE)).toBeUndefined();
    await db.delete();
  });
});

describe('bonificação ratio warning', () => {
  it('warns on a STOCK_DIVIDEND by ratio >= 1 only', () => {
    const d = bonusRatioWarnings([sd('a', { ratio: 1.5 }), sd('b', { ratio: 1 }), sd('c', { ratio: 0.1 }), sd('d', { quantity: 5, ratio: 2 })]);
    expect(d.map((x) => [x.transactionId, x.code, x.severity])).toEqual([
      ['a', 'STOCK_DIVIDEND_RATIO_SUSPECT', 'warning'],
      ['b', 'STOCK_DIVIDEND_RATIO_SUSPECT', 'warning'],
    ]);
  });

  it('is worded in the UI language', () => {
    const tx = sd('a', { ratio: 1.5 });
    const [d] = bonusRatioWarnings([tx]);
    const t = (k: string, o?: Record<string, unknown>) => (k === 'diag.text.STOCK_DIVIDEND_RATIO_SUSPECT' ? `${o?.symbol} ${o?.ratio} ${o?.pct}` : '');
    const text = describeDiagnostic(d!, { tx, instruments: new Map([[ITUB, { id: ITUB, symbol: 'ITUB4', name: 'Itaú', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' }]]), locale: 'pt-BR', t });
    expect(text).toBe('ITUB4 1,5 150%');
    for (const r of [esR5, ptR5, enR5]) {
      expect(r.diag.code.STOCK_DIVIDEND_RATIO_SUSPECT).toBeTruthy();
      expect(r.diag.text.STOCK_DIVIDEND_RATIO_SUSPECT).toContain('{{symbol}}');
      expect(r.repair.bonus_other).toContain('{{count}}');
      expect(r.repair.bonus_one).toContain('{{count}}');
    }
    expect(esR5.repair.bonus_other).toBe('Corregimos {{count}} bonificaciones que se habían aplicado con una proporción errónea.');
  });
});
