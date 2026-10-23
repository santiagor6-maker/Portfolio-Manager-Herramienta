/**
 * W53: corporate actions suggested by the data provider carry an English note ("For IR the new shares
 * carry…") and a raw ratio ("×1.03"). The UI words them from the type and the ratio instead.
 */
import type { Transaction } from '@pm/core';
import { formatPct } from './format';

type T = (key: string, opts?: Record<string, unknown>) => string;

export function formatRatio(ratio: number, locale: string): string {
  return `×${new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(ratio)}`;
}

/** Localized description of a provider-suggested corporate action (falls back to its note). */
export function corporateNote(x: Pick<Transaction, 'type' | 'ratio' | 'subtype' | 'note'>, t: T, locale: string): string | undefined {
  if (x.type === 'STOCK_DIVIDEND' && x.ratio && x.ratio > 1) return t('ca.note.bonus', { pct: formatPct(x.ratio - 1, locale, { decimals: 2 }) });
  if (x.type === 'SPLIT' && x.subtype === 'SPINOFF') return t('ca.note.spinoff');
  if (x.type === 'SPLIT' && x.ratio) return t(x.ratio >= 1 ? 'ca.note.split' : 'ca.note.reverse', { ratio: formatRatio(x.ratio, locale) });
  return x.note;
}
