/**
 * B3 bonificação ratio fix. Until market-data was corrected, a provider STOCK_DIVIDEND carried the
 * total-shares factor (110:100 -> 1.10) as `ratio`, while core reads `ratio` as NEW shares per share
 * held (0.10) and applies 1 + ratio: an accepted suggestion credited 2.10x the shares.
 *
 * Pure helpers (no database: also used by the analysis worker). The one-time repair lives in
 * db/repairs.ts.
 */
import type { CorporateAction, Diagnostic, Transaction } from '@pm/core';
import { canonicalId } from './renames';

export const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

type ProviderAction = CorporateAction & { priceFactor?: number };

/** The provider's ratio before the fix: its price factor (equal to the old buggy `ratio`). */
function legacyRatio(a: ProviderAction): number | undefined {
  if (a.priceFactor && a.priceFactor > 1) return a.priceFactor;
  return a.ratio && a.ratio > 1 ? a.ratio : undefined;
}

/**
 * STOCK_DIVIDEND transactions recorded with the old provider ratio: ratio > 1, no quantity, and a
 * cached provider STOCK_DIVIDEND on the same instrument and date whose pre-fix ratio matches within
 * 1e-6. Returns the corrected ratio per transaction id; anything else is left alone.
 */
export function legacyBonusFixes(txs: readonly Transaction[], actions: readonly ProviderAction[]): { id: string; ratio: number }[] {
  const byKey = new Map<string, number[]>();
  for (const a of actions) {
    if (a.type !== 'STOCK_DIVIDEND' || !a.instrumentId) continue;
    const r = legacyRatio(a);
    if (r === undefined) continue;
    for (const d of new Set([a.date, a.exDate].filter(Boolean))) {
      const k = `${canonicalId(a.instrumentId)}|${d}`;
      byKey.set(k, [...(byKey.get(k) ?? []), r]);
    }
  }
  const out: { id: string; ratio: number }[] = [];
  for (const t of txs) {
    if (t.type !== 'STOCK_DIVIDEND' || !t.id || !t.instrumentId || !(t.ratio && t.ratio > 1) || (t.quantity && t.quantity > 0)) continue;
    const cands = byKey.get(`${canonicalId(t.instrumentId)}|${t.date}`) ?? [];
    if (cands.some((r) => Math.abs(t.ratio! - r) < 1e-6)) out.push({ id: t.id, ratio: round6(t.ratio - 1) });
  }
  return out;
}

export const BONUS_RATIO_SUSPECT = 'STOCK_DIVIDEND_RATIO_SUSPECT';

/**
 * Web-level warning: a STOCK_DIVIDEND by ratio of 1 or more (a bonus of 100 % or more) is very
 * unusual and is most likely the total-shares factor typed as the ratio (1.10 instead of 0.10).
 */
export function bonusRatioWarnings(txs: readonly Transaction[]): Diagnostic[] {
  return txs
    .filter((t) => t.type === 'STOCK_DIVIDEND' && !(t.quantity && t.quantity > 0) && t.ratio !== undefined && t.ratio >= 1)
    .map((t) => ({
      transactionId: t.id,
      date: t.date,
      code: BONUS_RATIO_SUSPECT,
      severity: 'warning' as const,
      message: `STOCK_DIVIDEND of ${t.instrumentId ?? '?'} on ${t.date} with ratio ${t.ratio} (${round6(t.ratio! * 100)} % new shares per share held) is very unusual; check that it is not the total-shares factor (a 10 % bonus is ratio 0.1).`,
      data: { instrumentId: t.instrumentId ?? '', ratio: t.ratio! },
    }));
}
