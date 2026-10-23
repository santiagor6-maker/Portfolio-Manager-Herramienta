/**
 * W53: corporate actions suggested by the data provider carry an English note ("For IR the new shares
 * carry…") and a raw ratio ("×1.03"). The UI words them from the type and the ratio instead.
 *
 * STOCK_DIVIDEND `ratio` follows the core contract: NEW shares received per share held (a 10 %
 * bonificação is 0.1; core credits held × (1 + ratio)).
 */
import type { CorporateAction, Transaction } from '@pm/core';
import { formatPct } from './format';

type T = (key: string, opts?: Record<string, unknown>) => string;

export function formatRatio(ratio: number, locale: string): string {
  return `×${new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(ratio)}`;
}

/** Ratio column of a transaction: a stock dividend shows the share bonus (+10 %), a split its factor. */
export function formatTxRatio(x: Pick<Transaction, 'type' | 'ratio'>, locale: string): string {
  if (x.type === 'STOCK_DIVIDEND' && x.ratio) return `+${formatPct(x.ratio, locale, { decimals: 2 })}`;
  return formatRatio(x.ratio ?? 1, locale);
}

/**
 * Provider STOCK_DIVIDEND actions cached before the ratio fix carry the total-shares factor (1.10)
 * as `ratio`, equal to their `priceFactor`; the cache is refreshed incrementally, so they would
 * linger. Converts those to new shares per share held (0.10).
 */
export function normalizeProviderAction<A extends CorporateAction & { priceFactor?: number }>(a: A): A {
  if (a.type !== 'STOCK_DIVIDEND' || !a.ratio || !a.priceFactor || a.ratio <= 1 || Math.abs(a.ratio - a.priceFactor) > 1e-9) return a;
  return { ...a, ratio: Math.round((a.ratio - 1) * 1e6) / 1e6 };
}

/** Localized description of a provider-suggested corporate action (falls back to its note). */
export function corporateNote(x: Pick<Transaction, 'type' | 'ratio' | 'subtype' | 'note'>, t: T, locale: string): string | undefined {
  if (x.type === 'STOCK_DIVIDEND' && x.ratio && x.ratio > 0) return t('ca.note.bonus', { pct: formatPct(x.ratio, locale, { decimals: 2 }) });
  if (x.type === 'SPLIT' && x.subtype === 'SPINOFF') return t('ca.note.spinoff');
  if (x.type === 'SPLIT' && x.ratio) return t(x.ratio >= 1 ? 'ca.note.split' : 'ca.note.reverse', { ratio: formatRatio(x.ratio, locale) });
  return x.note;
}
