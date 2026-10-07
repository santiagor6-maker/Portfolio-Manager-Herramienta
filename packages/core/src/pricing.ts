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
): { values: number[]; missingIndex: boolean; anchor?: PriceInfo } {
  const mult = multiplier(inst.priceMultiplier);
  // Anchor = market/manual price only. Trade prints of other lots do not re-anchor: each
  // CDT/CDB purchase is its own contract with its own rate (round 3, F8).
  const info = marketInfo(ctx, inst, day);
  let missingIndex = false;
  const values = lots.map((l) => {
    let unit: number;
    let anchor: number;
    if (info && info.day >= l.openDay) {
      unit = info.price / mult;
      anchor = info.day;
    } else {
      unit = l.unitValue;
      anchor = l.openDay;
    }
    let f = accrualFactor(ctx, inst, anchor, day);
    if (f === undefined) {
      missingIndex = true;
      f = 1;
    }
    return l.quantity * unit * f;
  });
  return { values, missingIndex, anchor: info };
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
