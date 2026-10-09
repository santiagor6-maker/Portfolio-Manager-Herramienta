/**
 * Price resolution and position valuation shared by valuation, performance and position
 * analytics (one function, so values and the money waterfall always reconcile).
 *
 * Price of an instrument on day d (instrument currency):
 *   1. the most recent of: market/manual close on or before d, trade print (BUY/SELL price) on
 *      or before d. On the same date the market close wins over the trade print.
 *   2. fixed income with `accrual`: each lot is valued at its anchor (latest price/trade print
 *      on or after the lot's open date, else its own purchase price) grown by the accrual
 *      factor from the anchor date to d (stopping at maturity).
 *   3. otherwise the position is valued at cost.
 * An `override` price (first trade of the day) is used for the intra-day "pre-flow" valuation.
 */
import type { AccrualSpec, DayCount, Instrument } from './types';
import { isoToDay, lastIndexAtOrBefore } from './dates';
import { fixedGrowth } from './indices';
import { calendarForCurrency } from './calendars';
import type { LotBook, LotState } from './lots';
import type { EngineContext, Ledger } from './ledger';

export type PriceSource = 'market' | 'trade' | 'accrual' | 'cost';

export interface PriceInfo {
  price: number;
  day: number;
  source: 'market' | 'trade';
}

function multiplier(m: number | undefined): number {
  return m && m > 0 ? m : 1;
}

/** Latest market/manual close on or before day (instrument currency), without trade prints. */
export function marketInfo(ctx: EngineContext, inst: Instrument, day: number): PriceInfo | undefined {
  const m = ctx.market;
  const pt = m.pricePointAt(inst.id, day);
  if (!pt) return undefined;
  const pc = m.priceCurrency(inst.id);
  let p: number | undefined = pt.close;
  if (pc && pc !== inst.currency) {
    const r = m.fxAt(pc, inst.currency, day) ?? m.fxNearest(pc, inst.currency, day);
    p = r === undefined ? undefined : p * r;
  }
  return p === undefined ? undefined : { price: p, day: pt.day, source: 'market' };
}

/** Latest price observation (market close or trade print) on or before day, instrument currency. */
export function priceInfo(ctx: EngineContext, inst: Instrument, day: number): PriceInfo | undefined {
  const m = ctx.market;
  let best: PriceInfo | undefined;
  const pt = m.pricePointAt(inst.id, day);
  if (pt) {
    const pc = m.priceCurrency(inst.id);
    let p: number | undefined = pt.close;
    if (pc && pc !== inst.currency) {
      const r = m.fxAt(pc, inst.currency, day) ?? m.fxNearest(pc, inst.currency, day);
      p = r === undefined ? undefined : p * r;
    }
    if (p !== undefined) best = { price: p, day: pt.day, source: 'market' };
  }
  const obs = ctx.observations.get(inst.id);
  if (obs) {
    const i = lastIndexAtOrBefore(obs.days, day);
    if (i >= 0) {
      const od = obs.days[i] as number;
      if (!best || od > best.day) best = { price: obs.prices[i] as number, day: od, source: 'trade' };
    }
  }
  return best;
}

export function defaultDayCount(spec: AccrualSpec, inst: Instrument): DayCount {
  if (spec.dayCount) return spec.dayCount;
  if (spec.index === 'CDI' || spec.index === 'SELIC' || inst.currency === 'BRL') return 'BUS/252';
  return 'ACT/365';
}

/** Accrual growth between two days (undefined when the index data is missing). */
export function accrualFactor(ctx: EngineContext, inst: Instrument, a: number, b: number): number | undefined {
  const spec = inst.accrual;
  if (!spec) return 1;
  let start = a;
  let end = b;
  if (spec.issueDate) start = Math.max(start, isoToDay(spec.issueDate));
  if (spec.maturity) end = Math.min(end, isoToDay(spec.maturity));
  if (end <= start) return 1;
  const dc = defaultDayCount(spec, inst);
  const cal = calendarForCurrency(inst.currency); // C29: ANBIMA for BRL, Colombia for COP
  if (spec.kind === 'fixed') return fixedGrowth(spec.annualRate ?? 0, start, end, dc, cal);
  let g = 1;
  if (spec.index) {
    const idx = ctx.market.index(spec.index);
    if (!idx) return undefined;
    let p = spec.percentOfIndex ?? 1;
    if (p > 3) p /= 100;
    const f = idx.factor(start, end, { percent: p, extrapolate: true });
    if (f === undefined) return undefined;
    g = f;
  }
  if (spec.spread) g *= fixedGrowth(spec.spread, start, end, dc, cal);
  return g;
}

/** The accrual on `day` uses an index projected beyond its last published value (C4/C32). */
export function accrualEstimated(ctx: EngineContext, inst: Instrument, day: number): boolean {
  const spec = inst.accrual;
  if (!spec || spec.kind !== 'indexed' || !spec.index) return false;
  const idx = ctx.market.index(spec.index);
  if (!idx) return false;
  const end = spec.maturity ? Math.min(day, isoToDay(spec.maturity)) : day;
  return end > idx.lastDay + (idx.kind === 'annualRate' ? 31 : 1);
}

export interface PositionValue {
  /** Market value, instrument currency. */
  mv: number;
  /** Market value, base currency (falls back to historical cost when there is no FX at all). */
  mvBase: number;
  source: PriceSource;
  price?: number;
  priceDay?: number;
  /** FX instrument->base used (undefined = none available). */
  rate?: number;
  missingFx: boolean;
  missingIndex: boolean;
  /** Accrual uses a projected (unpublished) index value. */
  estimated: boolean;
  /** Per-lot values in instrument currency (accrual instruments), for taxes on the yield. */
  lotValues?: number[];
}

/** Accrued per-lot values (instrument currency) for an accrual instrument. */
export function accruedLotValues(
  ctx: EngineContext,
  inst: Instrument,
  lots: LotState[],
  day: number,
): { values: number[]; missingIndex: boolean; anchor?: PriceInfo; principal: number[] } {
  const mult = multiplier(inst.priceMultiplier);
  // Anchor = market/manual price only. Trade prints of other lots do not re-anchor: each
  // CDT/CDB purchase is its own contract with its own rate (round 3, F8).
  const info = marketInfo(ctx, inst, day);
  let missingIndex = false;
  // value of each lot at its anchor (values - principal = interest accrued since the anchor)
  const principal: number[] = [];
  const values = lots.map((l) => {
    let unit: number;
    let anchor: number;
    const own = l.anchorDay ?? l.openDay;
    // A market/manual price re-anchors when it is newer than the lot's own anchor (a price on
    // the day of a coupon reset does not override the ex-coupon value).
    if (info && (l.anchorDay !== undefined ? info.day > own : info.day >= own)) {
      unit = info.price / mult;
      anchor = info.day;
    } else {
      unit = l.unitValue;
      anchor = own;
    }
    let f = accrualFactor(ctx, inst, anchor, day);
    if (f === undefined) {
      missingIndex = true;
      f = 1;
    }
    principal.push(l.quantity * unit);
    return l.quantity * unit * f;
  });
  return { values, missingIndex, anchor: info, principal };
}

/** Per-currency FX memo for the last fxDay seen (the daily loop values many positions per day). */
const fxMemo = new Map<string, { day: number; market: unknown; base: string; exact: number | undefined; rate: number | undefined }>();

/** Scratch result of quickValue (reused to avoid allocations in the daily loop). */
export const quick = { mv: 0, mvBase: 0, rate: 0 as number | undefined, missingFx: false, cost: false };

/**
 * Allocation-free valuation for the hot loops (daily chain). Same rules as valuePosition for
 * instruments without accrual and without an override; returns false otherwise (use valuePosition).
 */
export function quickValue(ledger: Ledger, book: LotBook, inst: Instrument, day: number, fxDay: number): boolean {
  if (inst.accrual) return false;
  const ctx = ledger.ctx;
  const m = ctx.market;
  const id = inst.id;
  let price: number | undefined;
  const pd = m.priceDayAt(id, day);
  const obs = ctx.observations.get(id);
  let od = -Infinity;
  let oi = -1;
  if (obs) {
    oi = lastIndexAtOrBefore(obs.days, day);
    if (oi >= 0) od = obs.days[oi] as number;
  }
  if (od > pd) price = obs!.prices[oi] as number;
  else if (pd > -Infinity) {
    const p = m.priceAt(id, day) as number;
    const pc = m.priceCurrency(id);
    if (pc && pc !== inst.currency) {
      const r = m.fxAt(pc, inst.currency, day) ?? m.fxNearest(pc, inst.currency, day);
      price = r === undefined ? (od > -Infinity ? (obs!.prices[oi] as number) : undefined) : p * r;
    } else price = p;
  }
  const base = ctx.base;
  let exact: number | undefined;
  let rate: number | undefined;
  if (inst.currency === base) exact = rate = 1;
  else {
    const key = inst.currency;
    const c = fxMemo.get(key);
    if (c && c.day === fxDay && c.market === m && c.base === base) {
      exact = c.exact;
      rate = c.rate;
    } else {
      exact = m.fxAt(inst.currency, base, fxDay);
      rate = exact ?? m.fxNearest(inst.currency, base, fxDay);
      fxMemo.set(key, { day: fxDay, market: m, base, exact, rate });
    }
  }
  quick.missingFx = exact === undefined;
  quick.rate = rate;
  quick.cost = price === undefined;
  const mv = price === undefined ? book.costBasis : (book.quantity * price) / multiplier(inst.priceMultiplier);
  quick.mv = mv;
  if (rate !== undefined) quick.mvBase = mv * rate;
  else if (price === undefined) quick.mvBase = book.costBasisBase;
  else quick.mvBase = book.costBasis !== 0 ? mv * (book.costBasisBase / book.costBasis) : 0;
  return true;
}

/** Value one position. `override` = intra-day trade price (instrument currency, quote units). */
export function valuePosition(ledger: Ledger, book: LotBook, inst: Instrument, day: number, fxDay: number, override?: number): PositionValue {
  const ctx = ledger.ctx;
  const { base, market } = ctx;
  const q = book.quantity;
  const mult = multiplier(inst.priceMultiplier);
  const exact = inst.currency === base ? 1 : market.fxAt(inst.currency, base, fxDay);
  const rate = exact ?? market.fxNearest(inst.currency, base, fxDay);
  let mv: number;
  let source: PriceSource;
  let price: number | undefined;
  let priceDay: number | undefined;
  let missingIndex = false;
  let estimated = false;
  let lotValues: number[] | undefined;
  if (override !== undefined && !inst.accrual) {
    mv = (q * override) / mult;
    source = 'trade';
    price = override;
    priceDay = day;
  } else if (inst.accrual) {
    const r = accruedLotValues(ctx, inst, book.lots, day);
    mv = r.values.reduce((s, v) => s + v, 0);
    lotValues = r.values;
    missingIndex = r.missingIndex;
    estimated = !missingIndex && accrualEstimated(ctx, inst, day);
    source = missingIndex ? 'cost' : 'accrual';
    price = q !== 0 ? (mv * mult) / q : undefined;
    priceDay = day;
  } else {
    const info = priceInfo(ctx, inst, day);
    if (info) {
      mv = (q * info.price) / mult;
      source = info.source;
      price = info.price;
      priceDay = info.day;
    } else {
      mv = book.costBasis;
      source = 'cost';
    }
  }
  let mvBase: number;
  if (rate !== undefined) mvBase = mv * rate;
  else if (source === 'cost') mvBase = book.costBasisBase;
  else mvBase = book.costBasis !== 0 ? mv * (book.costBasisBase / book.costBasis) : 0;
  return { mv, mvBase, source, price, priceDay, rate, missingFx: exact === undefined, missingIndex, estimated, lotValues };
}
