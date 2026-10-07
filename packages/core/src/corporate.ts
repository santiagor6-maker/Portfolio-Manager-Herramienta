/**
 * Turn provider corporate actions into suggested transactions without duplicating the ones
 * the user already recorded. Nothing is applied silently: the caller shows `suggested` for
 * confirmation; actions flagged `reviewRequired` are returned in `review` and never suggested.
 *
 * - DIVIDEND: amount = units held at the close before the ex-date x amountPerShare, dated on the
 *   payment date (or the ex-date), in the action's currency (or the instrument's). Subtype kept
 *   (JCP...). A suggested withholding is filled in (editable): JCP 15 %, US-source dividends 30 %
 *   (no treaty for CO/BR residents); `withholding: 'none'` or a custom table overrides it.
 * - SPLIT: plain split, or SPINOFF / MERGER / TICKER_CHANGE with targetInstrumentId/costFraction.
 * - STOCK_DIVIDEND: bonus shares by ratio (new shares per share held).
 *
 * De-duplication (C26): a recorded transaction matches an action when it is the same instrument
 * and kind, dated within the tolerance window of the ex/pay date, AND (same subtype, or amount
 * within 2 % of units x amountPerShare, or same price per share). Each recorded row matches at
 * most one action, so a JCP and a dividend with the same ex-date are both handled. Duplicate
 * provider rows (same instrument, kind, ex-date, subtype and amount) are reported once.
 *
 * Market-data conventions (round 3):
 * - DIVIDEND with subtype COUPON (NTN-B / NTN-F / bond coupons) is suggested as INTEREST income.
 * - A merger arrives as SPLIT/MERGER (ratio, targetInstrumentId) plus, on the same instrument
 *   and ex-date, a DIVIDEND/EXTRAORDINARY carrying the cash per share (e.g. CPLE6 -> R$ 0.7749).
 *   Both become ONE SPLIT/MERGER transaction with amount = units x cash per share (merger cash,
 *   allocated by the ledger as a partial disposal of the parent); the dividend is reported as
 *   skipped with reason ABSORBED_IN_MERGER.
 *
 * Complexity (C27): one sort of the transactions and the actions and a single chronological
 * sweep of the holdings: O((n + m) log n).
 */
import type { CorporateAction, Instrument, ISODate, Transaction } from './types';
import { isoToDay, isStrictIsoDate } from './dates';
import { sortTransactions } from './ledger';

export interface CorporateActionResult {
  suggested: Transaction[];
  /** Actions skipped with the reason: ALREADY_RECORDED, NO_POSITION, DUPLICATE_ACTION, ABSORBED_IN_MERGER, INVALID. */
  skipped: { action: CorporateAction; reason: string }[];
  /** Actions flagged reviewRequired by the provider (heuristic classification). */
  review: CorporateAction[];
}

export interface CorporateActionOptions {
  portfolioId?: string;
  dividendToleranceDays?: number;
  splitToleranceDays?: number;
  /** 'auto' (default): JCP 15 %, US dividends 30 %; 'none'; or rates by subtype / 'US' / 'DEFAULT'. */
  withholding?: 'auto' | 'none' | Record<string, number>;
}

interface Recorded {
  day: number;
  tx: Transaction;
  used: boolean;
}

function lowerBound(arr: Recorded[], day: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] as Recorded).day < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const near = (a: number, b: number, rel: number, abs = 1e-9) => Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));

export function applyCorporateActions(
  transactions: Transaction[],
  actions: CorporateAction[],
  instruments: Instrument[],
  opts: CorporateActionOptions = {},
): CorporateActionResult {
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const out: CorporateActionResult = { suggested: [], skipped: [], review: [] };
  const divTol = opts.dividendToleranceDays ?? 10;
  const splitTol = opts.splitToleranceDays ?? 3;
  const portfolioId = opts.portfolioId ?? transactions[0]?.portfolioId ?? '';

  // Recorded income / split rows per instrument, sorted by day.
  const incomeRec = new Map<string, Recorded[]>();
  const splitRec = new Map<string, Recorded[]>();
  const sorted = sortTransactions(transactions);
  for (const { tx, day } of sorted) {
    if (!tx.instrumentId) continue;
    const map = tx.type === 'DIVIDEND' || tx.type === 'INTEREST' ? incomeRec : tx.type === 'SPLIT' || tx.type === 'STOCK_DIVIDEND' ? splitRec : undefined;
    if (!map) continue;
    let arr = map.get(tx.instrumentId);
    if (!arr) map.set(tx.instrumentId, (arr = []));
    arr.push({ day, tx, used: false });
  }

  const valid: { a: CorporateAction; ex: number }[] = [];
  for (const a of actions ?? []) {
    if (!a || !a.instrumentId || !isStrictIsoDate(a.exDate ?? a.date)) {
      out.skipped.push({ action: a, reason: 'INVALID' });
      continue;
    }
    if (a.reviewRequired) {
      out.review.push(a);
      continue;
    }
    valid.push({ a, ex: isoToDay((a.exDate ?? a.date) as ISODate) });
  }
  valid.sort((x, y) => x.ex - y.ex);

  // Merger cash: DIVIDEND/EXTRAORDINARY on the same instrument and ex-date as a SPLIT/MERGER.
  const mergerKeys = new Set(valid.filter(({ a }) => a.type === 'SPLIT' && a.subtype === 'MERGER').map(({ a, ex }) => `${a.instrumentId}|${ex}`));
  const mergerCash = new Map<string, CorporateAction>();
  for (const { a, ex } of valid) {
    const k = `${a.instrumentId}|${ex}`;
    if (a.type === 'DIVIDEND' && a.subtype === 'EXTRAORDINARY' && mergerKeys.has(k) && !mergerCash.has(k)) mergerCash.set(k, a);
  }

  // Chronological sweep of holdings.
  const qty = new Map<string, number>();
  const get = (id: string) => qty.get(id) ?? 0;
  const applyTx = (tx: Transaction) => {
    const id = tx.instrumentId;
    if (!id) return;
    const q = get(id);
    switch (tx.type) {
      case 'BUY':
      case 'TRANSFER_IN':
        qty.set(id, q + (tx.quantity ?? 0));
        break;
      case 'SELL':
      case 'TRANSFER_OUT':
        qty.set(id, Math.max(0, q - (tx.quantity ?? 0)));
        break;
      case 'SPLIT': {
        const r = tx.ratio && tx.ratio > 0 ? tx.ratio : 1;
        if ((tx.subtype === 'SPINOFF' || tx.subtype === 'MERGER' || tx.subtype === 'TICKER_CHANGE') && tx.targetInstrumentId) {
          qty.set(tx.targetInstrumentId, get(tx.targetInstrumentId) + q * r);
          if (tx.subtype !== 'SPINOFF') qty.set(id, 0);
        } else qty.set(id, q * r);
        break;
      }
      case 'STOCK_DIVIDEND':
        qty.set(id, tx.quantity && tx.quantity > 0 ? q + tx.quantity : q * (1 + (tx.ratio ?? 0)));
        break;
      default:
        break;
    }
  };
  let ti = 0;
  const seenActions = new Set<string>();
  const rates = opts.withholding ?? 'auto';
  const withholdingFor = (a: CorporateAction, inst: Instrument | undefined): number => {
    if (rates === 'none') return 0;
    const table: Record<string, number> = rates === 'auto' ? { JCP: 0.15, US: 0.3 } : rates;
    if (a.subtype && table[a.subtype] !== undefined) return table[a.subtype] as number;
    if (inst?.country && table[inst.country] !== undefined) return table[inst.country] as number;
    return table.DEFAULT ?? 0;
  };

  for (const { a, ex } of valid) {
    while (ti < sorted.length && (sorted[ti] as { day: number }).day < ex) applyTx(sorted[ti++]!.tx);
    const inst = byId.get(a.instrumentId);
    const key = `${a.instrumentId}|${a.type}|${ex}|${a.subtype ?? ''}|${a.amountPerShare ?? a.ratio ?? ''}|${a.targetInstrumentId ?? ''}`;
    if (seenActions.has(key)) {
      out.skipped.push({ action: a, reason: 'DUPLICATE_ACTION' });
      continue;
    }
    seenActions.add(key);
    const id = `ca:${a.instrumentId}:${a.type}:${a.exDate ?? a.date}${a.subtype ? `:${a.subtype}` : ''}${a.type === 'DIVIDEND' ? `:${a.amountPerShare}` : ''}`;
    const base = { id, portfolioId, importHash: id, source: `corporate-action${a.source ? `:${a.source}` : ''}`, note: a.note };
    const q = get(a.instrumentId);

    if (a.type === 'DIVIDEND' && mergerCash.get(`${a.instrumentId}|${ex}`) === a) {
      out.skipped.push({ action: a, reason: 'ABSORBED_IN_MERGER' });
      continue;
    }
    if (a.type === 'DIVIDEND') {
      const aps = a.amountPerShare ?? 0;
      if (!(aps > 0)) {
        out.skipped.push({ action: a, reason: 'INVALID' });
        continue;
      }
      const pay = a.payDate && isStrictIsoDate(a.payDate) ? isoToDay(a.payDate) : ex;
      const rec = incomeRec.get(a.instrumentId) ?? [];
      let matched: Recorded | undefined;
      for (let k = lowerBound(rec, Math.min(ex, pay) - divTol); k < rec.length; k++) {
        const r = rec[k] as Recorded;
        if (r.day > Math.max(ex, pay) + divTol) break;
        if (r.used) continue;
        const t = r.tx;
        if (t.subtype && a.subtype && t.subtype !== a.subtype) continue;
        const sameSubtype = !!t.subtype && t.subtype === a.subtype;
        const sameAmount = t.amount !== undefined && q > 0 && near(t.amount, q * aps, 0.02, 0.01);
        const samePrice = t.price !== undefined && near(t.price, aps, 0.01);
        if (sameSubtype || sameAmount || samePrice) {
          matched = r;
          break;
        }
      }
      if (matched) {
        matched.used = true;
        out.skipped.push({ action: a, reason: 'ALREADY_RECORDED' });
        continue;
      }
      if (q <= 0) {
        out.skipped.push({ action: a, reason: 'NO_POSITION' });
        continue;
      }
      const amount = Math.round(q * aps * 1e6) / 1e6;
      const t: Transaction = {
        ...base,
        date: a.payDate && isStrictIsoDate(a.payDate) ? a.payDate : (a.exDate ?? a.date),
        type: a.subtype === 'COUPON' ? 'INTEREST' : 'DIVIDEND',
        instrumentId: a.instrumentId,
        quantity: q,
        price: aps,
        amount,
        currency: a.currency ?? inst?.currency ?? 'USD',
      };
      const w = withholdingFor(a, inst);
      if (w > 0) {
        t.taxes = Math.round(amount * w * 100) / 100;
        t.note = `${a.note ? `${a.note} · ` : ''}retención sugerida ${(w * 100).toFixed(1)} % (editable)`;
      }
      if (a.subtype) t.subtype = a.subtype;
      out.suggested.push(t);
      const arr = incomeRec.get(a.instrumentId) ?? [];
      arr.splice(lowerBound(arr, isoToDay(t.date)), 0, { day: isoToDay(t.date), tx: t, used: true });
      incomeRec.set(a.instrumentId, arr);
      continue;
    }

    // SPLIT (incl. restructurings) and STOCK_DIVIDEND
    const rec = splitRec.get(a.instrumentId) ?? [];
    let dup = false;
    for (let k = lowerBound(rec, ex - splitTol); k < rec.length; k++) {
      const r = rec[k] as Recorded;
      if (r.day > ex + splitTol) break;
      if (!r.used) {
        r.used = true;
        dup = true;
        break;
      }
    }
    if (dup) {
      out.skipped.push({ action: a, reason: 'ALREADY_RECORDED' });
      continue;
    }
    const restructure = a.subtype === 'SPINOFF' || a.subtype === 'MERGER' || a.subtype === 'TICKER_CHANGE';
    if ((restructure && !a.targetInstrumentId) || (!restructure && !(a.ratio && a.ratio > 0))) {
      out.skipped.push({ action: a, reason: 'INVALID' });
      continue;
    }
    if (q <= 0) {
      out.skipped.push({ action: a, reason: 'NO_POSITION' });
      continue;
    }
    const t: Transaction = {
      ...base,
      date: (a.exDate ?? a.date) as ISODate,
      type: a.type === 'STOCK_DIVIDEND' ? 'STOCK_DIVIDEND' : 'SPLIT',
      instrumentId: a.instrumentId,
      currency: inst?.currency ?? a.currency ?? 'USD',
    };
    if (a.ratio !== undefined) t.ratio = a.ratio;
    if (a.subtype) t.subtype = a.subtype;
    if (a.targetInstrumentId) t.targetInstrumentId = a.targetInstrumentId;
    if (a.costFraction !== undefined) t.costFraction = a.costFraction;
    const cash = a.subtype === 'MERGER' ? mergerCash.get(`${a.instrumentId}|${ex}`) : undefined;
    if (cash?.amountPerShare && cash.amountPerShare > 0) {
      t.amount = Math.round(q * cash.amountPerShare * 1e6) / 1e6;
      t.currency = cash.currency ?? t.currency;
      t.note = `${t.note ? `${t.note} · ` : ''}efectivo de la fusión ${cash.amountPerShare} por acción`;
    }
    out.suggested.push(t);
    applyTx(t); // the suggested event changes the holdings for later actions
  }
  out.suggested.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return out;
}
