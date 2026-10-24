/**
 * W55: corporate events and dividends announced by the provider (or inferred from the price history)
 * that are not recorded yet. A split of a held position makes the headline value wrong (10.000 NVDA
 * instead of 100.000), so it must surface on the Resumen — not only in the Movimientos inbox.
 */
import type { CorporateAction, Diagnostic } from '@pm/core';
import { splitSuggestion } from './diagnosticText';
import type { Suggestion } from '../services/analysis';

/** Diagnostics whose fix changes quantities or prices (and therefore the portfolio value). */
export const VALUATION_CODES = ['POSSIBLE_UNRECORDED_SPLIT', 'POSSIBLE_REDENOMINATION', 'TRADE_PRICE_UNIT_SUSPECT'];

/** Suggestion types shown as pending income (Proventos, Dividendos card). */
export const INCOME_TYPES = ['DIVIDEND', 'INTEREST', 'RETURN_OF_CAPITAL'];

/**
 * A suspect trade price the engine already accepted (later prints confirmed the level) changes nothing
 * (W67: core's structured `data.accepted`, not its English message).
 */
const acceptedUnit = (d: Diagnostic) => d.code === 'TRADE_PRICE_UNIT_SUSPECT' && d.data?.accepted === 1;

/** W62: key under which an unclassified provider event is ignored (same store as dismissed suggestions). */
export function reviewKey(a: Pick<CorporateAction, 'instrumentId' | 'type' | 'date'>): string {
  return `review|${a.instrumentId}|${a.type}|${a.date}`;
}

export interface PendingSplit {
  instrumentId: string;
  date: string;
  /** New shares per old share (10 = 10:1). */
  ratio: number;
  /** W64: the provider's suggestions for this event, one per portfolio that held the instrument. */
  suggestions: Suggestion[];
  diagnostic?: Diagnostic;
  /** W67: announced by the data provider, or only inferred from a jump in the closes (to confirm). */
  source: 'provider' | 'prices';
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
  /** W62: provider events of held instruments that could not be classified (spin-off?) — never dropped. */
  review: CorporateAction[];
}

export function pendingEvents(
  a: { suggestions: Suggestion[]; diagnostics: Diagnostic[]; reviewActions?: CorporateAction[]; valuation?: { holdings: { instrumentId: string; quantity: number }[] } } | undefined,
): PendingEvents {
  if (!a) return { splits: [], income: [], total: 0, valuationWarnings: [], review: [] };
  const held = new Set((a.valuation?.holdings ?? []).filter((h) => h.quantity > 0).map((h) => h.instrumentId));
  const splits = new Map<string, PendingSplit>();
  for (const s of a.suggestions) {
    const x = s.transaction;
    if (x.type !== 'SPLIT' || !x.instrumentId || !x.ratio || x.subtype === 'SPINOFF' || !held.has(x.instrumentId)) continue;
    const key = `${x.instrumentId}|${x.date}`;
    const prev = splits.get(key);
    if (prev) prev.suggestions.push(s);
    else splits.set(key, { instrumentId: x.instrumentId, date: x.date, ratio: x.ratio, suggestions: [s], source: 'provider' });
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
    else splits.set(`${sp.instrumentId}|${sp.date}`, { instrumentId: sp.instrumentId, date: sp.date, ratio: sp.ratio, suggestions: [], diagnostic: d, source: d.data?.source === 'provider' ? 'provider' : 'prices' });
  }
  const income = a.suggestions.filter((s) => INCOME_TYPES.includes(s.transaction.type));
  const review = (a.reviewActions ?? []).filter((r) => held.has(r.instrumentId));
  return { splits: [...splits.values()].sort((x, y) => (x.date < y.date ? -1 : 1)), income, total: a.suggestions.length, valuationWarnings, review };
}

/** W61: SPLIT rows of one portfolio, instrument and day beyond the first (`ids[0]` is kept). */
export function duplicateSplits(rows: { id: string; portfolioId: string; instrumentId?: string; date: string; createdAt?: number }[], scope: string) {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (scope !== 'all' && r.portfolioId !== scope) continue;
    const k = `${r.portfolioId}|${r.instrumentId}|${r.date}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const sorted = [...g].sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0));
      return { instrumentId: g[0]!.instrumentId ?? '', date: g[0]!.date, ids: sorted.map((x) => x.id) };
    });
}
