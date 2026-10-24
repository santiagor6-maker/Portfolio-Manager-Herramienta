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

/** A split as investors write it, in the locale: "10:1", "1,5:1", "1:10" (reverse). */
export function formatSplitRatio(ratio: number, locale: string): string {
  const n = (x: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(x);
  return ratio >= 1 ? `${n(ratio)}:1` : `1:${n(1 / ratio)}`;
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
  // W62: grupamentos cached before market-data typed them (1:25, 1:30, 1:100 arrived as SPINOFF to
  // review, without a target): a reverse factor 1:k with no receiving instrument is a reverse split.
  if (a.type === 'SPLIT' && a.subtype === 'SPINOFF' && !a.targetInstrumentId && isReverseSplitFactor(a.priceFactor)) {
    const { subtype: _s, costFraction: _c, reviewRequired: _r, ...rest } = a as A & { reviewRequired?: boolean };
    return { ...rest, ratio: a.priceFactor } as A;
  }
  if (a.type !== 'STOCK_DIVIDEND' || !a.ratio || !a.priceFactor || a.ratio <= 1 || Math.abs(a.ratio - a.priceFactor) > 1e-9) return a;
  return { ...a, ratio: Math.round((a.ratio - 1) * 1e6) / 1e6 };
}

/** 1:k with k a whole number (0.04, 1/30, 0.01). */
function isReverseSplitFactor(f: number | undefined): f is number {
  if (!f || f >= 1) return false;
  const k = 1 / f;
  return Math.abs(k - Math.round(k)) < 1e-6 * k;
}

/** Localized description of a provider-suggested corporate action (falls back to its note). */
export function corporateNote(x: Pick<Transaction, 'type' | 'ratio' | 'subtype' | 'note'>, t: T, locale: string): string | undefined {
  if (x.type === 'STOCK_DIVIDEND' && x.ratio && x.ratio > 0) return t('ca.note.bonus', { pct: formatPct(x.ratio, locale, { decimals: 2 }) });
  if (x.type === 'SPLIT' && x.subtype === 'SPINOFF') return t('ca.note.spinoff');
  if (x.type === 'SPLIT' && x.ratio) return t(x.ratio >= 1 ? 'ca.note.split' : 'ca.note.reverse', { ratio: formatRatio(x.ratio, locale) });
  return x.note;
}
