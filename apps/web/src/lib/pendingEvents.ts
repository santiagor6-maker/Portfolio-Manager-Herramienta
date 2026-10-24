/**
 * W55: corporate events and dividends announced by the provider (or inferred from the price history)
 * that are not recorded yet. A split of a held position makes the headline value wrong (10.000 NVDA
 * instead of 100.000), so it must surface on the Resumen — not only in the Movimientos inbox.
 */
import type { Diagnostic } from '@pm/core';
import { splitSuggestion } from './diagnosticText';
import type { Suggestion } from '../services/analysis';

/** Diagnostics whose fix changes quantities or prices (and therefore the portfolio value). */
export const VALUATION_CODES = ['POSSIBLE_UNRECORDED_SPLIT', 'POSSIBLE_REDENOMINATION', 'TRADE_PRICE_UNIT_SUSPECT'];

/** Suggestion types shown as pending income (Proventos, Dividendos card). */
export const INCOME_TYPES = ['DIVIDEND', 'INTEREST', 'RETURN_OF_CAPITAL'];

/**
 * A suspect trade price the engine already accepted (later prints confirmed the level) changes nothing:
 * core says so in the message ("— accepted because N consistent prices…").
 */
const acceptedUnit = (d: Diagnostic) => d.code === 'TRADE_PRICE_UNIT_SUSPECT' && /accepted because/.test(d.message);

export interface PendingSplit {
  instrumentId: string;
  date: string;
  /** New shares per old share (10 = 10:1). */
  ratio: number;
  /** Provider suggestion to accept, when there is one (else the split is inferred from prices). */
  suggestion?: Suggestion;
  diagnostic?: Diagnostic;
}

export interface PendingEvents {
  /** Splits / reverse splits / redenominations of positions held now. */
  splits: PendingSplit[];
  /** Announced dividends, interest and other cash events not recorded. */
  income: Suggestion[];
  /** Every pending suggestion (inbox size). */
  total: number;
  /** Valuation-changing diagnostics that are warnings (not errors). */
  valuationWarnings: Diagnostic[];
}

export function pendingEvents(a: { suggestions: Suggestion[]; diagnostics: Diagnostic[]; valuation?: { holdings: { instrumentId: string; quantity: number }[] } } | undefined): PendingEvents {
  if (!a) return { splits: [], income: [], total: 0, valuationWarnings: [] };
  const held = new Set((a.valuation?.holdings ?? []).filter((h) => h.quantity > 0).map((h) => h.instrumentId));
  const splits = new Map<string, PendingSplit>();
  for (const s of a.suggestions) {
    const x = s.transaction;
    if (x.type !== 'SPLIT' || !x.instrumentId || !x.ratio || x.subtype === 'SPINOFF' || !held.has(x.instrumentId)) continue;
    splits.set(`${x.instrumentId}|${x.date}`, { instrumentId: x.instrumentId, date: x.date, ratio: x.ratio, suggestion: s });
  }
  // Only 'warning' diagnostics: an 'info' split is a weak, unconfirmed price jump (core ledger), and an
  // 'error' is already listed among the engine errors.
  const valuationWarnings = a.diagnostics.filter((d) => VALUATION_CODES.includes(d.code) && d.severity === 'warning' && !acceptedUnit(d));
  for (const d of valuationWarnings) {
    if (d.code !== 'POSSIBLE_UNRECORDED_SPLIT' && d.code !== 'POSSIBLE_REDENOMINATION') continue;
    const sp = splitSuggestion(d.message, d.data);
    if (!sp || !held.has(sp.instrumentId)) continue;
    // The provider's suggestion for the same instrument (a day apart at most) wins: it is the exact event.
    const twin = [...splits.values()].find((p) => p.instrumentId === sp.instrumentId && Math.abs(Date.parse(p.date) - Date.parse(sp.date)) <= 7 * 86_400_000);
    if (twin) twin.diagnostic = d;
    else splits.set(`${sp.instrumentId}|${sp.date}`, { instrumentId: sp.instrumentId, date: sp.date, ratio: sp.ratio, diagnostic: d });
  }
  const income = a.suggestions.filter((s) => INCOME_TYPES.includes(s.transaction.type));
  return { splits: [...splits.values()].sort((x, y) => (x.date < y.date ? -1 : 1)), income, total: a.suggestions.length, valuationWarnings };
}
