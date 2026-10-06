/**
 * Turn provider corporate actions into suggested transactions without duplicating the ones
 * the user already recorded. Nothing is applied silently: the caller shows `suggested` for
 * confirmation; actions flagged `reviewRequired` are returned in `review` and never suggested.
 *
 * - DIVIDEND: amount = units held at the close before the ex-date x amountPerShare, dated on the
 *   payment date (or the ex-date), in the action's currency (or the instrument's). Subtype kept
 *   (JCP...). Withholding is left empty (it depends on the investor).
 * - SPLIT: plain split, or SPINOFF / MERGER / TICKER_CHANGE with targetInstrumentId/costFraction.
 * - STOCK_DIVIDEND: bonus shares by ratio (new shares per share held).
 * A recorded transaction of the same instrument and kind within the tolerance window
 * (dividends 10 days around ex/pay date, splits 3 days) marks the action as already recorded.
 */
import type { CorporateAction, Instrument, ISODate, Transaction } from './types';
import { isoToDay, isStrictIsoDate } from './dates';
import { sortTransactions } from './ledger';

export interface CorporateActionResult {
  suggested: Transaction[];
  /** Actions skipped with the reason: ALREADY_RECORDED, NO_POSITION, INVALID. */
  skipped: { action: CorporateAction; reason: string }[];
  /** Actions flagged reviewRequired by the provider (heuristic classification). */
  review: CorporateAction[];
}

function heldBefore(txs: Transaction[], instrumentId: string, day: number): number {
  let q = 0;
  for (const { tx, day: d } of sortTransactions(txs)) {
    if (d >= day) break;
    if (tx.instrumentId === instrumentId) {
      switch (tx.type) {
        case 'BUY':
        case 'TRANSFER_IN':
          q += tx.quantity ?? 0;
          break;
        case 'SELL':
        case 'TRANSFER_OUT':
          q -= tx.quantity ?? 0;
          break;
        case 'SPLIT':
          if (!tx.subtype || tx.subtype === 'SPLIT') q *= tx.ratio ?? 1;
          else if (tx.subtype === 'MERGER' || tx.subtype === 'TICKER_CHANGE') q = 0;
          break;
        case 'STOCK_DIVIDEND':
          q = tx.quantity && tx.quantity > 0 ? q + tx.quantity : q * (1 + (tx.ratio ?? 0));
          break;
        default:
          break;
      }
    } else if (tx.type === 'SPLIT' && tx.targetInstrumentId === instrumentId && tx.instrumentId) {
      // units received from a merger / ticker change / spin-off
      const parent = heldBefore(txs.filter((t) => t !== tx), tx.instrumentId, d);
      q += parent * (tx.ratio ?? 1);
    }
  }
  return Math.max(0, Math.round(q * 1e9) / 1e9);
}

export function applyCorporateActions(
  transactions: Transaction[],
  actions: CorporateAction[],
  instruments: Instrument[],
  opts: { portfolioId?: string; dividendToleranceDays?: number; splitToleranceDays?: number } = {},
): CorporateActionResult {
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const out: CorporateActionResult = { suggested: [], skipped: [], review: [] };
  const divTol = opts.dividendToleranceDays ?? 10;
  const splitTol = opts.splitToleranceDays ?? 3;
  const portfolioId = opts.portfolioId ?? transactions[0]?.portfolioId ?? '';
  const sortedActions = actions
    .filter((a) => a && a.instrumentId && isStrictIsoDate(a.exDate ?? a.date))
    .slice()
    .sort((a, b) => ((a.exDate ?? a.date) < (b.exDate ?? b.date) ? -1 : 1));
  for (const a of actions) if (!a || !a.instrumentId || !isStrictIsoDate(a.exDate ?? a.date)) out.skipped.push({ action: a, reason: 'INVALID' });

  for (const a of sortedActions) {
    if (a.reviewRequired) {
      out.review.push(a);
      continue;
    }
    const ex = (a.exDate ?? a.date) as ISODate;
    const exDay = isoToDay(ex);
    const all = [...transactions, ...out.suggested];
    const near = (t: Transaction, dates: ISODate[], tol: number) => dates.some((d) => Math.abs(isoToDay(t.date) - isoToDay(d)) <= tol);
    const inst = byId.get(a.instrumentId);
    const id = `ca:${a.instrumentId}:${a.type}:${ex}${a.subtype ? `:${a.subtype}` : ''}`;
    const base = { id, portfolioId, importHash: id, source: `corporate-action${a.source ? `:${a.source}` : ''}`, note: a.note };
    if (a.type === 'DIVIDEND') {
      if (!(a.amountPerShare && a.amountPerShare > 0)) {
        out.skipped.push({ action: a, reason: 'INVALID' });
        continue;
      }
      const dates = [ex, a.payDate ?? ex];
      if (all.some((t) => t.instrumentId === a.instrumentId && (t.type === 'DIVIDEND' || t.type === 'INTEREST') && near(t, dates, divTol))) {
        out.skipped.push({ action: a, reason: 'ALREADY_RECORDED' });
        continue;
      }
      const q = heldBefore(all, a.instrumentId, exDay);
      if (q <= 0) {
        out.skipped.push({ action: a, reason: 'NO_POSITION' });
        continue;
      }
      const t: Transaction = {
        ...base,
        date: a.payDate && isStrictIsoDate(a.payDate) ? a.payDate : ex,
        type: 'DIVIDEND',
        instrumentId: a.instrumentId,
        quantity: q,
        price: a.amountPerShare,
        amount: q * a.amountPerShare,
        currency: a.currency ?? inst?.currency ?? 'USD',
      };
      if (a.subtype) t.subtype = a.subtype;
      out.suggested.push(t);
      continue;
    }
    // SPLIT (incl. restructurings) and STOCK_DIVIDEND
    const kindMatch = (t: Transaction) =>
      t.instrumentId === a.instrumentId && (t.type === 'SPLIT' || t.type === 'STOCK_DIVIDEND') && near(t, [ex], splitTol);
    if (all.some(kindMatch)) {
      out.skipped.push({ action: a, reason: 'ALREADY_RECORDED' });
      continue;
    }
    const restructure = a.subtype === 'SPINOFF' || a.subtype === 'MERGER' || a.subtype === 'TICKER_CHANGE';
    if (restructure && !a.targetInstrumentId) {
      out.skipped.push({ action: a, reason: 'INVALID' });
      continue;
    }
    if (!restructure && !(a.ratio && a.ratio > 0)) {
      out.skipped.push({ action: a, reason: 'INVALID' });
      continue;
    }
    if (heldBefore(all, a.instrumentId, exDay) <= 0) {
      out.skipped.push({ action: a, reason: 'NO_POSITION' });
      continue;
    }
    const t: Transaction = {
      ...base,
      date: ex,
      type: a.type === 'STOCK_DIVIDEND' ? 'STOCK_DIVIDEND' : 'SPLIT',
      instrumentId: a.instrumentId,
      currency: inst?.currency ?? a.currency ?? 'USD',
    };
    if (a.ratio !== undefined) t.ratio = a.ratio;
    if (a.subtype) t.subtype = a.subtype;
    if (a.targetInstrumentId) t.targetInstrumentId = a.targetInstrumentId;
    if (a.costFraction !== undefined) t.costFraction = a.costFraction;
    out.suggested.push(t);
  }
  return out;
}
