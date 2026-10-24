/**
 * W68: the consolidated view ("Todos") runs the engine on one ledger with every portfolio's
 * transactions. A corporate event is a property of the security, not of the holding: the engine applies
 * a SPLIT / STOCK_DIVIDEND / restructuring to the instrument's whole book (every lot, from every
 * portfolio). Recorded once per portfolio (the correct way), it would be applied once per portfolio —
 * NVDA 10:1 in two portfolios became ×100.
 *
 * So the copies of one event are merged before the engine sees them. This is exact when every
 * portfolio holding the instrument recorded the event (each portfolio's view is then right too, and the
 * consolidated book is the sum of the portfolio books scaled once). Copies are the same event when they
 * have the same instrument, type, ratio, subtype and target, and dates within a few days with no
 * trade of the instrument in between (the book is identical on both dates, so applying it on the
 * earliest is the same). Cash attached to the event (merger cash, cash in lieu) is per holding and
 * is added up.
 */
import type { Transaction } from '@pm/core';

const EVENT_TYPES = new Set<Transaction['type']>(['SPLIT', 'STOCK_DIVIDEND']);
const TRADES = new Set<Transaction['type']>(['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT']);
const SAME_EVENT_DAYS = 7;

export function mergeCorporateEvents<T extends Transaction>(txs: T[]): T[] {
  const events = txs.filter((t) => EVENT_TYPES.has(t.type) && t.instrumentId).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (events.length < 2) return txs;
  const tradeDays = new Map<string, string[]>();
  for (const t of txs) if (TRADES.has(t.type) && t.instrumentId) tradeDays.set(t.instrumentId, [...(tradeDays.get(t.instrumentId) ?? []), t.date]);
  const tradedBetween = (inst: string, from: string, to: string) => (tradeDays.get(inst) ?? []).some((d) => d > from && d < to);
  const sig = (t: T) => `${t.instrumentId}|${t.type}|${t.ratio ?? ''}|${t.subtype ?? ''}|${t.targetInstrumentId ?? ''}`;
  const kept = new Map<string, T[]>(); // signature -> merged events (earliest first)
  const replaced = new Map<string, T | null>(); // id -> merged row (or null when folded into another)
  for (const e of events) {
    const list = kept.get(sig(e)) ?? [];
    const into = list.find(
      (k) =>
        Math.abs(Date.parse(e.date) - Date.parse(k.date)) <= SAME_EVENT_DAYS * 86_400_000 &&
        !tradedBetween(e.instrumentId!, k.date, e.date) &&
        !(e.targetInstrumentId && tradedBetween(e.targetInstrumentId, k.date, e.date)),
    );
    if (!into) {
      list.push({ ...e });
      kept.set(sig(e), list);
      continue;
    }
    if (e.amount !== undefined || into.amount !== undefined) into.amount = (into.amount ?? 0) + (e.amount ?? 0);
    replaced.set(e.id, null);
  }
  for (const list of kept.values()) for (const k of list) replaced.set(k.id, k);
  return txs.flatMap((t) => {
    if (!replaced.has(t.id)) return [t];
    const r = replaced.get(t.id);
    return r ? [r] : [];
  });
}

/**
 * Import hashes identify a row within a portfolio: the same broker file imported into two portfolios is
 * not a "possible duplicate" in the consolidated view (W68).
 */
export function scopeImportHashes<T extends Transaction>(txs: T[]): T[] {
  return txs.map((t) => (t.importHash ? { ...t, importHash: `${t.portfolioId}:${t.importHash}` } : t));
}
