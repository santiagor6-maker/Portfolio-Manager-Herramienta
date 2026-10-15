/**
 * Ticker renames, mergers and share-class conversions, read from the ONE shared table in
 * `@pm/core` (`TICKER_EVENTS`, packages/core/src/tickerRenames.ts). This module only adapts it to
 * market-data's lookups; it holds no data of its own.
 *
 * Two very different cases (review R2, M23):
 *  - 'rename': the SAME security under a new ticker (CCR -> Motiva, Eletrobras -> AXIA, ISA CTEEP ->
 *    ISA Energia). History continues: the old ticker resolves to the new one, history is stitched.
 *  - 'merger' / 'conversion': the old security ceased to exist; holders received `ratio` shares of
 *    another security (+ cash). The new ticker's prices are never served as the old one's: history
 *    is cut at the last trading day and a MERGER action (plus a cash event) is emitted.
 *
 * Reused codes: BVMF:NATU3 was Natura Cosméticos until 2019-12-17 (-> NTCO3), and the code came back
 * on 2025-07-02 (NTCO3 -> NATU3). An event whose old code was later reused is HISTORICAL: it does not
 * make the current code "delisted"; it is reported as an action of the current code's history when
 * the requested range covers it (`historicalEventsFrom`).
 */
import { TICKER_EVENTS, type TickerEvent } from '@pm/core';
import { yahooSymbolFromId } from './symbols';
import type { RenameInfo } from './types';

/** A core TickerEvent with both Yahoo symbols filled in. */
export type TickerAlias = TickerEvent & { fromYahoo: string; toYahoo: string };

const yahooOf = (id: string, given?: string) => given ?? yahooSymbolFromId(id) ?? id.split(':')[1]!;

export const TICKER_ALIASES: readonly TickerAlias[] = TICKER_EVENTS.map((e) => ({ ...e, fromYahoo: yahooOf(e.fromId, e.fromYahoo), toYahoo: yahooOf(e.toId, e.toYahoo) }));

const up = (s: string) => s.trim().toUpperCase();

/** The old code of `a` was taken again by a later event (the code is live again). */
function superseded(a: TickerAlias): boolean {
  return TICKER_ALIASES.some((b) => b !== a && up(b.toId) === up(a.fromId) && !!b.effective && !!a.effective && b.effective > a.effective);
}

const current = TICKER_ALIASES.filter((a) => !superseded(a));
const byKey = new Map<string, TickerAlias>();
for (const a of current) {
  byKey.set(up(a.fromId), a);
  byKey.set(up(a.fromYahoo), a);
  // Bare old ticker as typed from a broker statement (PFBCOLOM, ELET3).
  byKey.set(up(a.fromId.split(':')[1]!), a);
  for (const isin of a.isins ?? []) byKey.set(up(isin), a);
}

/** Alias for an old id, old Yahoo symbol, bare ticker or old ISIN (case-insensitive). Current codes only. */
export function findAlias(key: string): TickerAlias | undefined {
  return byKey.get(up(key));
}

/** Same-security renames whose new instrument is `toId` (history can be stitched). */
export function aliasesTo(toId: string): TickerAlias[] {
  return current.filter((a) => a.kind === 'rename' && up(a.toId) === up(toId));
}

/** Past events of a code that is live again (NATU3 -> NTCO3 in 2019): actions of its history. */
export function historicalEventsFrom(id: string): TickerAlias[] {
  return TICKER_ALIASES.filter((a) => superseded(a) && up(a.fromId) === up(id));
}

/**
 * Periods in which a reused code did NOT trade: after the old security's last trading day and before
 * the code came back (NATU3: after 2019-12-17, before 2025-07-02). Provider bars inside them (Yahoo
 * repeats 36.86 on 2019-12-18 with volume 0) belong to no security and are dropped (review R6, M41).
 */
export function reuseGaps(id: string): { after: string; before: string }[] {
  const out: { after: string; before: string }[] = [];
  for (const a of historicalEventsFrom(id)) {
    const last = a.lastTradingDay ?? a.effective;
    const back = TICKER_ALIASES.filter((b) => up(b.toId) === up(id) && !!b.effective && b.effective > a.effective!).map((b) => b.effective!).sort()[0];
    if (last && back) out.push({ after: last, before: back });
  }
  return out;
}

export function renameInfo(a: TickerAlias): RenameInfo {
  return {
    kind: a.kind,
    fromId: a.fromId,
    toId: a.toId,
    ratio: a.ratio,
    ...(a.effective ? { effective: a.effective } : {}),
    ...(a.lastTradingDay ? { lastTradingDay: a.lastTradingDay } : {}),
    ...(a.cashPerShare !== undefined ? { cashPerShare: a.cashPerShare } : {}),
    ...(a.cashPayDate ? { cashPayDate: a.cashPayDate } : {}),
    note: a.note,
  };
}
