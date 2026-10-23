/**
 * One-time data repairs run at startup.
 */
import { db } from './schema';
import { legacyBonusFixes } from '../lib/bonusRepair';

/** Meta flag: the bonificação ratio repair already ran on this database. */
export const BONUS_REPAIR_DONE = 'bonusRatioRepaired';
/** Meta value: number of repaired transactions still to announce (removed when the notice is closed). */
export const BONUS_REPAIR_NOTICE = 'bonusRatioRepairNotice';

/**
 * Rewrites STOCK_DIVIDEND transactions accepted from a provider suggestion before the ratio fix
 * (ratio 1.10 for a 10 % bonificação) to the core convention (0.10). Runs once per database; only
 * transactions that match a cached provider action are touched. Returns how many were fixed.
 */
export async function repairBonusRatios(): Promise<number> {
  return db.transaction('rw', db.meta, db.transactions, db.corporateActions, async () => {
    if ((await db.meta.get(BONUS_REPAIR_DONE))?.value) return 0;
    const [txs, actions] = await Promise.all([db.transactions.where('type').equals('STOCK_DIVIDEND').toArray(), db.corporateActions.toArray()]);
    const fixes = legacyBonusFixes(txs, actions);
    const now = Date.now();
    for (const f of fixes) await db.transactions.update(f.id, { ratio: f.ratio, updatedAt: now });
    await db.meta.put({ key: BONUS_REPAIR_DONE, value: { at: now, count: fixes.length } });
    if (fixes.length) await db.meta.put({ key: BONUS_REPAIR_NOTICE, value: fixes.length });
    return fixes.length;
  });
}
