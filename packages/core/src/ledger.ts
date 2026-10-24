/**
 * Ledger: replays transactions chronologically and maintains lots, multi-currency cash,
 * external flows, realized gains, income, cost events, a per-transaction money attribution
 * (for the reconciling waterfall) and per-position cash flows (for position performance).
 *
 * Intra-day order (stable by input order inside each rank):
 *  -1 SPLIT, STOCK_DIVIDEND (ex-date semantics: quantities traded that day are post-split)
 *   0 DEPOSIT, TRANSFER_IN  1 FX_CONVERSION  2 BUY  4 DIVIDEND, INTEREST, RETURN_OF_CAPITAL
 *   5 SELL  6 FEE, TAX  7 TRANSFER_OUT, WITHDRAWAL  8 automatic maturity redemption
 *
 * The ledger is incremental: `applyUntil(day)` processes every transaction dated on or
 * before `day`, so a single pass can serve thousands of valuation dates.
 */
import type {
  CostMethod,
  CurrencyCode,
  IncomeEvent,
  Instrument,
  ISODate,
  RealizedGain,
  Transaction,
  TransactionType,
} from './types';
import type { EngineInput, EngineOptions } from './api';
import { dayToIso, days360, isStrictIsoDate, isoToDay, lastIndexAtOrBefore } from './dates';
import { type BookView, LotBook, type LotState, PortfolioBooks, QTY_EPS, roundQty } from './lots';
import { type EngineMarket, toEngineMarket } from './market';
import { accrualFactor, accruedLotValues, payableFactor, priceInfo } from './pricing';
import { addBusinessDays, calendarForCurrency, nextBusinessDay } from './calendars';
import { fixedIncomeTax, irRate, residenceOf, taxRegimeFor } from './fitax';
import { renamedTickerId } from './tickerRenames';

export const TYPE_RANK: Record<TransactionType, number> = {
  SPLIT: -1,
  STOCK_DIVIDEND: -1,
  DEPOSIT: 0,
  TRANSFER_IN: 0,
  FX_CONVERSION: 1,
  BUY: 2,
  DIVIDEND: 4,
  INTEREST: 4,
  RETURN_OF_CAPITAL: 4,
  SELL: 5,
  FEE: 6,
  TAX: 6,
  TRANSFER_OUT: 7,
  WITHDRAWAL: 7,
};

export interface SortedTx {
  tx: Transaction;
  day: number;
  rank: number;
  index: number;
}

/** Sort chronologically with the intra-day rank order; stable on input order. Invalid dates are dropped. */
/**
 * Intra-day order. C55: on the same day, mergers and ticker changes (which consume the whole
 * parent) come after splits, bonus shares and spin-offs, so a unit dissolution emitted as MERGER +
 * SPINOFF (CPLE11 = 1 CPLE3 + 4 CPLE6) hands over every component.
 */
function rankOf(tx: Transaction): number {
  const r = TYPE_RANK[tx?.type] ?? 9;
  if (tx?.type === 'SPLIT' && (tx.subtype === 'MERGER' || tx.subtype === 'TICKER_CHANGE')) return -0.5;
  return r;
}

export function sortTransactions(transactions: Transaction[]): SortedTx[] {
  return transactions
    .map((tx, index) => ({ tx, day: isStrictIsoDate(tx?.date) ? isoToDay(tx.date) : NaN, rank: rankOf(tx), index }))
    .filter((s) => Number.isFinite(s.day))
    .sort((a, b) => a.day - b.day || a.rank - b.rank || a.index - b.index);
}

export type FlowKind =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'IMPLICIT_DEPOSIT'
  | 'IMPLICIT_WITHDRAWAL';

/** External investor flow. `amount` is signed: + into the portfolio, - out of it. */
export interface ExternalFlow {
  day: number;
  currency: CurrencyCode;
  amount: number;
  kind: FlowKind;
  transactionId?: string;
  /** Rate to base to use if the market has no FX for the day. */
  rateHint?: number;
  /** Amount in the reporting base currency at the flow-date market FX (same FX as cash valuation). */
  base: number;
}

export interface CostEvent {
  day: number;
  instrumentId?: string;
  feesBase: number;
  taxesBase: number;
}

/**
 * Money attribution of one transaction. For every transaction:
 *   cashMovesBase - flowsBase + deltaCostBase = realized + income + otherCosts + fxConversion
 *                                               + transfer + corporate + rateDiff
 * so over any period gain = sum(attributions) + delta unrealized + foreign-cash revaluation.
 */
export interface Attribution {
  day: number;
  instrumentId?: string;
  /** Realized gain (base, historical FX both sides) and its currency part. */
  realized: number;
  realizedFx: number;
  /** Dividends/interest net of withholding at the transaction rate. */
  income: number;
  /** Standalone fees and taxes (FEE, TAX, fees on deposits/conversions/transfers). Negative = cost. */
  otherCosts: number;
  /** FX conversions vs market rate (negative = spread paid). */
  fxConversion: number;
  /** Explicit conversions only: spread cost (positive = cost). */
  spread: number;
  /** Transfers of securities: cost basis brought in vs market value flow. */
  transfer: number;
  /** Corporate actions that change cost without cash (attributed cost of bonus shares...). */
  corporate: number;
  /** Executed rate (fxRateToBase / trade-currency conversion) vs market FX. */
  rateDiff: number;
  /** Sum of cash moves of the transaction valued at market FX. */
  cashBase: number;
}

/** Cash flows of one position (base currency at market FX of the day). */
export interface PositionFlow {
  day: number;
  instrumentId: string;
  /** Money into the position at the trade (buys incl. fees, transfers in). */
  inBase: number;
  /** Money out of the position at the trade (net sale proceeds, transfers out, redemptions). */
  outBase: number;
  /** Money out at the end of the day (dividends, interest, return of capital), net. */
  endOutBase: number;
  /** Of endOutBase: dividends/interest (rest is return of capital). */
  incomeBase: number;
  /** Fees and taxes of the transaction (informational). */
  feesBase: number;
  /** Restructurings (spin-off, merger, ticker change, merger cash) at the START of the ex-date. */
  startInBase: number;
  startOutBase: number;
}

export interface Diagnostic {
  transactionId?: string;
  date: string;
  code: string;
  message: string;
  severity?: 'error' | 'warning' | 'info';
  /**
   * Round 8: structured fields for the UI (no text parsing). POSSIBLE_UNRECORDED_SPLIT /
   * POSSIBLE_REDENOMINATION: `ratioFrom` old shares -> `ratioTo` new shares (a 10:1 split is 1 -> 10,
   * a 1:10 reverse split is 10 -> 1), `splitRatio` = ratioTo / ratioFrom (the SPLIT `ratio` to
   * record), `priceFrom`/`priceTo`, `dateFrom`/`dateTo`, `instrumentId`, `source`
   * ('provider' | 'prices').
   */
  data?: Record<string, string | number>;
}

export interface ResolvedOptions {
  implicitCashFlows: boolean;
  implicitFx: 'fromBaseCash' | 'none';
  sellProceeds: 'cash' | 'withdraw';
  twrMethod: 'daily' | 'modifiedDietz';
  costMethod: CostMethod;
  tradePriceObservations: boolean;
  autoRedeemAtMaturity: boolean;
  staleDaysListed: number;
  staleDaysManual: number;
}

export interface EngineContext {
  base: CurrencyCode;
  portfolioBase: CurrencyCode;
  market: EngineMarket;
  instruments: Map<string, Instrument>;
  options: ResolvedOptions;
  raw: EngineOptions;
  sorted: SortedTx[];
  /** Rows rejected before processing (invalid date, filtered out...). */
  rejected: { tx: Transaction; code: string; message: string }[];
  /**
   * C52: recorded quantity-changing corporate actions per instrument (SPLIT, STOCK_DIVIDEND, SPINOFF
   * with costFraction): day and cumulative factor. A price observed before such a day is divided by
   * the factor accumulated up to the valuation day (prices are unadjusted; see splitAdjust).
   */
  splitAdj: Map<string, { days: number[]; cum: number[] }>;
  /** Trade prints per instrument (instrument currency, last trade of each day). */
  observations: Map<string, { days: number[]; prices: number[] }>;
  /** First trade price per day per instrument (intra-day pre-flow valuation). */
  firstTradePrice: Map<number, Map<string, number>>;
  /** Automatic redemptions: payment day (next business day after maturity), ascending. */
  maturities: { day: number; maturityDay: number; instrumentId: string }[];
  /**
   * Diagnostics found while building the context: trade prints rejected (TRADE_PRICE_OUTLIER) or
   * used but unconfirmed (TRADE_PRICE_UNCONFIRMED), late recorded redemptions (LATE_REDEMPTION).
   */
  outliers: { tx: Transaction; code: string; severity: Diagnostic['severity']; message: string; day?: number; data?: Diagnostic['data'] }[];
  /** C44: questionable trade prints (TRADE_PRICE_OUTLIER rejected, TRADE_PRICE_UNCONFIRMED used). */
  priceFlags: { day: number; instrumentId: string; code: PriceFlagCode }[];
  /** Tax residence (explicit or inferred from the portfolio base currency). */
  taxResidence: string | undefined;
  /**
   * Currency whose cash funds implicit FX conversions: options.fundingCurrency, else the currency
   * of the first recorded DEPOSIT, else the portfolio base. Independent of the reporting view.
   */
  fundingCurrency: CurrencyCode;
  /** isolatePortfolioCash: funding currency per portfolioId. */
  fundingByPortfolio?: Map<string, CurrencyCode>;
}

export function resolveOptions(input: EngineInput, extra?: EngineOptions): ResolvedOptions {
  const o: EngineOptions = { ...(input.options ?? {}), ...(extra ?? {}) };
  return {
    implicitCashFlows: o.implicitCashFlows ?? true,
    implicitFx: o.implicitFx ?? 'fromBaseCash',
    sellProceeds: o.sellProceeds ?? 'cash',
    twrMethod: o.twrMethod ?? 'daily',
    costMethod: o.costMethod ?? input.portfolio.costMethod ?? 'FIFO',
    tradePriceObservations: o.tradePriceObservations ?? true,
    autoRedeemAtMaturity: o.autoRedeemAtMaturity ?? true,
    staleDaysListed: o.staleDays?.listed ?? 7,
    staleDaysManual: o.staleDays?.manual ?? 45,
  };
}

function num(v: number | undefined | null): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function mult(inst: Instrument | undefined): number {
  return inst?.priceMultiplier && inst.priceMultiplier > 0 ? inst.priceMultiplier : 1;
}

export function createContext(input: EngineInput, extra?: EngineOptions): EngineContext {
  const instruments = new Map<string, Instrument>();
  for (const i of input.instruments ?? []) instruments.set(i.id, i);
  const raw: EngineOptions = { ...(input.options ?? {}), ...(extra ?? {}) };
  const options = resolveOptions(input, extra);
  let market = toEngineMarket(input.market);
  // C56: pure renames of the shared table (same security, same price series)
  const renames = new Map<string, string>(); // old id -> current id, for ids used here
  const canon = (id: string | undefined): string | undefined => {
    if (!id || raw.tickerRenames === false) return id;
    const to = renamedTickerId(id);
    if (!to) return id;
    renames.set(id, to);
    return to;
  };
  const base = input.baseCurrency ?? input.portfolio.baseCurrency;
  const rejected: EngineContext['rejected'] = [];
  const accounts = raw.filter?.accounts;
  const kept: Transaction[] = [];
  for (const tx of input.transactions ?? []) {
    if (!tx) continue;
    if (!isStrictIsoDate(tx.date)) {
      rejected.push({ tx, code: 'INVALID_DATE', message: `Date ${String(tx.date)} is not YYYY-MM-DD; row ignored` });
      continue;
    }
    if (accounts && !accounts.includes(tx.account ?? '')) continue;
    const ci = canon(tx.instrumentId);
    const ct = canon(tx.targetInstrumentId);
    if (ci !== tx.instrumentId || ct !== tx.targetInstrumentId) {
      const c: Transaction = { ...tx };
      if (ci !== undefined) c.instrumentId = ci;
      if (ct !== undefined) c.targetInstrumentId = ct;
      kept.push(c);
    } else kept.push(tx);
  }
  const sorted = sortTransactions(kept);
  const renameNotes: EngineContext['outliers'] = [];
  if (renames.size) {
    const aliases = new Map<string, string>(); // current id -> old id whose prices to use
    for (const [from, to] of renames) {
      const old = instruments.get(from);
      if (old && !instruments.has(to)) instruments.set(to, { ...old, id: to });
      if (market.priceDayAt(to, Infinity) === -Infinity && market.priceDayAt(from, Infinity) > -Infinity) aliases.set(to, from);
      const first = sorted.find((x) => x.tx.instrumentId === to || x.tx.targetInstrumentId === to);
      if (first) renameNotes.push({ tx: first.tx, code: 'INSTRUMENT_RENAMED', severity: 'info', message: `${from} is now ${to} (same security, ticker rename); its transactions are booked under ${to}`, data: { fromId: from, toId: to } });
    }
    if (aliases.size) {
      const base = market;
      const al = (id: string) => aliases.get(id) ?? id;
      const w = Object.create(base) as EngineMarket & Record<string, unknown>;
      w.price = (id: string, d: ISODate) => base.price(al(id), d);
      w.priceAt = (id: string, d: number) => base.priceAt(al(id), d);
      w.pricePointAt = (id: string, d: number) => base.pricePointAt(al(id), d);
      w.priceDayAt = (id: string, d: number) => base.priceDayAt(al(id), d);
      w.pricePointAfter = (id: string, d: number) => base.pricePointAfter(al(id), d);
      w.priceCurrency = (id: string) => base.priceCurrency(al(id));
      w.dividends = (id: string, a: number, b: number) => base.dividends(al(id), a, b);
      w.splitFactor = (id: string, a: number, b: number) => base.splitFactor(al(id), a, b);
      market = w;
    }
  }

  // C52: split/bonus/spin-off factors per instrument from the recorded ledger.
  const splitAdj: EngineContext['splitAdj'] = new Map();
  {
    const q = new Map<string, number>();
    for (const { tx, day } of sorted) {
      const id = tx.instrumentId;
      if (!id) continue;
      const q0 = q.get(id) ?? 0;
      const n = num(tx.quantity);
      let f = 1;
      if (tx.type === 'BUY' || tx.type === 'TRANSFER_IN') q.set(id, q0 + n);
      else if (tx.type === 'SELL' || tx.type === 'TRANSFER_OUT') q.set(id, q0 - n);
      else if (tx.type === 'SPLIT' && !tx.subtype) {
        f = num(tx.ratio) > 0 ? num(tx.ratio) : 1;
        q.set(id, q0 * f);
      } else if (tx.type === 'STOCK_DIVIDEND') {
        if (n > 0) f = q0 > 0 ? (q0 + n) / q0 : 1;
        else f = 1 + num(tx.ratio);
        q.set(id, q0 * f);
      } else if (tx.type === 'SPLIT' && tx.subtype === 'SPINOFF') {
        const cf = num(tx.costFraction);
        if (cf > 0 && cf < 1) f = 1 / (1 - cf);
      }
      if (!(f > 0) || f === 1) continue;
      let e = splitAdj.get(id);
      if (!e) splitAdj.set(id, (e = { days: [], cum: [] }));
      const prev = e.cum.length ? (e.cum[e.cum.length - 1] as number) : 1;
      if (e.days[e.days.length - 1] === day) e.cum[e.cum.length - 1] = prev * f;
      else {
        e.days.push(day);
        e.cum.push(prev * f);
      }
    }
  }
  const adj = (id: string, from: number, to: number): number => {
    const e = splitAdj.get(id);
    if (!e || from === to) return 1;
    const ca = (x: number) => {
      const i = lastIndexAtOrBefore(e.days, x);
      return i < 0 ? 1 : (e.cum[i] as number);
    };
    return ca(to) / ca(from);
  };

  // Trade prints as price observations (BUY/SELL only; transfer prices are historical costs).
  // C25/C37: a print that deviates more than `tradePriceTolerance` (default 30 %, x2 for crypto,
  // widened with the square root of the gap in months) from BOTH the previous reference (market
  // close or accepted print) AND the confirming close (same-day close or the next close, at any
  // distance) is an outlier (typo): not used as a price, reported as TRADE_PRICE_OUTLIER.
  // C44: a confirming close within tolerance accepts the print silently (genuine -52 % gap). Without
  // a confirming close, a print beyond the hard band (x3 / ÷3 of the reference, x5 for crypto,
  // widened for gaps over a year; also applied when the reference is very old) is not used until the
  // user confirms it (`Transaction.priceConfirmed`); inside the band it is used and reported as
  // TRADE_PRICE_UNCONFIRMED (genuine +40 % in a fund, BTC +45 %). Both codes also reach
  // MonthlyRow.warnings and PerformanceSummary.warnings (see priceFlagWarnings).
  // Tiny trades (< 0.5 % of the position) are not used when a market close exists that week.
  const observations = new Map<string, { days: number[]; prices: number[] }>();
  const firstTradePrice = new Map<number, Map<string, number>>();
  const outliers: EngineContext['outliers'] = renameNotes;
  const priceFlags: EngineContext['priceFlags'] = [];
  const tol = raw.tradePriceTolerance ?? 0.3;
  const held = new Map<string, number>();
  const toInstCcy = (inst: Instrument | undefined, id: string, p: { day: number; close: number } | undefined): { day: number; price: number } | undefined => {
    if (!p) return undefined;
    const pc = market.priceCurrency(id);
    const ccy = inst?.currency;
    let price = p.close;
    if (pc && ccy && pc !== ccy) {
      const r = market.fxAt(pc, ccy, p.day) ?? market.fxNearest(pc, ccy, p.day);
      if (r === undefined) return undefined;
      price *= r;
    }
    return { day: p.day, price };
  };
  const deviates = (p: number, ref: { day: number; price: number } | undefined, day: number, inst: Instrument | undefined): boolean | undefined => {
    if (!ref || !(ref.price > 0)) return undefined;
    const gap = Math.abs(day - ref.day);
    const t = tol * (inst?.assetClass === 'crypto' ? 2 : 1) * Math.max(1, Math.sqrt(gap / 30));
    return Math.abs(p / ref.price - 1) > t;
  };
  const beyondHard = (p: number, ref: { day: number; price: number } | undefined, day: number, inst: Instrument | undefined): boolean => {
    if (!ref || !(ref.price > 0)) return false;
    const h = (inst?.assetClass === 'crypto' ? 5 : 3) * Math.max(1, Math.sqrt(Math.abs(day - ref.day) / 365));
    const ratio = p / ref.price;
    return ratio > h || ratio < 1 / h;
  };
  // C48: a factor close to a power of ten (>= ~x8 or <= ~/8, or within 10 % of x10^k) looks like a
  // unit or format error; returns that factor.
  const unitSuspect = (ratio: number): number | undefined => {
    if (!(ratio > 0)) return undefined;
    const l = Math.log10(ratio);
    const k = Math.round(l);
    if (k === 0) return undefined;
    if (Math.abs(l) >= 0.9 || Math.abs(l - k) <= Math.log10(1.1)) return Math.pow(10, k);
    return undefined;
  };
  // C46: rejected prints waiting for a consistent successor, and the last unconfirmed print.
  type Outlier = EngineContext['outliers'][number];
  type Flag = EngineContext['priceFlags'][number];
  const pending = new Map<string, { day: number; price: number; tx: Transaction; outlier: Outlier; flag: Flag; unit?: number }[]>();
  const unconfirmed = new Map<string, { day: number; outlier: Outlier; flag: Flag }>();
  const dropped = new Set<object>();
  const accept = (id: string, day: number, p: number) => {
    let o = observations.get(id);
    if (!o) observations.set(id, (o = { days: [], prices: [] }));
    if (o.days[o.days.length - 1] === day) o.prices[o.prices.length - 1] = p;
    else {
      o.days.push(day);
      o.prices.push(p);
    }
    let m = firstTradePrice.get(day);
    if (!m) firstTradePrice.set(day, (m = new Map()));
    if (!m.has(id)) m.set(id, p);
  };
  if (options.tradePriceObservations) {
    for (const { tx, day } of sorted) {
      const id = tx.instrumentId;
      if (id && (tx.type === 'SPLIT' || tx.type === 'STOCK_DIVIDEND')) {
        const f = tx.type === 'SPLIT' ? (tx.subtype ? 1 : num(tx.ratio) || 1) : tx.quantity ? 1 : 1 + num(tx.ratio);
        held.set(id, (held.get(id) ?? 0) * f + (tx.type === 'STOCK_DIVIDEND' && tx.quantity ? num(tx.quantity) : 0));
        // previous observations stay unadjusted: references are split-adjusted on read (C52)
        if (f !== 1) {
          pending.delete(id);
          unconfirmed.delete(id);
        }
      }
      if ((tx.type !== 'BUY' && tx.type !== 'SELL') || !id || !(num(tx.quantity) > 0)) continue;
      const inst = instruments.get(id);
      const q = num(tx.quantity);
      const before = held.get(id) ?? 0;
      held.set(id, before + (tx.type === 'BUY' ? q : -q));
      let p = num(tx.price);
      if (!(p > 0) && num(tx.amount) > 0) p = (num(tx.amount) / q) * mult(inst);
      if (!(p > 0)) continue;
      const ccy = inst?.currency ?? tx.currency;
      if (tx.currency !== ccy) {
        const r = market.fxAt(tx.currency, ccy, day) ?? market.fxNearest(tx.currency, ccy, day);
        if (r === undefined) continue;
        p *= r;
      }
      const o = observations.get(id);
      // C52: references observed before a recorded split are expressed in post-split terms
      const pm0 = toInstCcy(inst, id, market.pricePointAt(id, day - 1));
      const prevMarket = pm0 && { day: pm0.day, price: pm0.price / adj(id, pm0.day, day) };
      const prevObs = o && o.days.length ? { day: o.days[o.days.length - 1] as number, price: (o.prices[o.prices.length - 1] as number) / adj(id, o.days[o.days.length - 1] as number, day) } : undefined;
      const prevRef = prevObs && (!prevMarket || prevObs.day > prevMarket.day) ? prevObs : prevMarket;
      if (tx.priceConfirmed === true) {
        // C46: a confirmed print is a new reference for the following ones
        pending.delete(id);
        unconfirmed.delete(id);
        accept(id, day, p);
        continue;
      }
      const sameDay = market.pricePointAt(id, day);
      const nr0 = toInstCcy(inst, id, sameDay && sameDay.day === day ? sameDay : market.pricePointAfter(id, day));
      const nextRef = nr0 && { day: nr0.day, price: nr0.price * adj(id, day, nr0.day) };
      const d1 = deviates(p, prevRef, day, inst);
      const d2 = deviates(p, nextRef, day, inst);
      const pct = Math.round(tol * 100);
      let reject: { message: string; unit?: number } | undefined;
      let flagUnconfirmed = false;
      if (d2 !== false) {
        if (d1 === true && d2 === true) {
          reject = { message: `Trade price ${p} of ${id} deviates more than ${pct} % from both the previous reference ${prevRef!.price.toFixed(4)} and the next close ${nextRef!.price.toFixed(4)}; not used as a price observation (typo?)` };
        } else {
          const hardRef = prevRef ?? nextRef;
          if (beyondHard(p, hardRef, day, inst)) {
            const unit = unitSuspect(p / hardRef!.price);
            if (unit) {
              reject = {
                unit,
                message: `Trade price ${p} of ${id} is ${(p / hardRef!.price).toPrecision(3)}x the ${hardRef === prevRef ? 'previous reference' : 'next close'} ${hardRef!.price.toFixed(4)} (${dayToIso(hardRef!.day)}), close to a factor of ${unit >= 1 ? unit : `1/${Math.round(1 / unit)}`}: likely a unit or format error (thousands/decimal separator, pence vs pounds, price per lot). Not used as a price until confirmed with priceConfirmed`,
              };
            } else reject = { message: `Trade price ${p} of ${id} is ${(p / hardRef!.price).toFixed(2)}x the ${hardRef === prevRef ? 'previous reference' : 'next close'} ${hardRef!.price.toFixed(4)} (${dayToIso(hardRef!.day)}) and no close confirms it; not used as a price observation until confirmed (priceConfirmed, or a later consistent trade price)` };
          } else if (d1 === true && d2 === undefined) flagUnconfirmed = true;
        }
      }
      if (reject) {
        // C46/C48: two or more consecutive prints from DIFFERENT days that agree with each other
        // (and no close contradicts them) confirm the new level: the earlier ones are re-accepted
        // with this one (TRADE_PRICE_CONFIRMED_BY_RUN, a warning that reaches rows and summaries).
        // Same-day fills are one piece of evidence. Unit-like factors (x100, /1000...) are never
        // confirmed automatically (TRADE_PRICE_UNIT_SUSPECT, needs priceConfirmed, which also
        // re-anchors the following prints). C53: a factor of about x10 or /10 is accepted as a real
        // move after 3 consistent prints on distinct days, keeping the UNIT_SUSPECT warnings.
        const run = pending.get(id) ?? [];
        const lastP = run[run.length - 1];
        const tenish = (u: number | undefined) => u === undefined || u === 10 || u === 0.1;
        const unitRun = !!reject.unit || run.some((r) => r.unit !== undefined);
        const days = new Set([...run.map((r) => r.day), day]).size;
        const enough = unitRun ? days >= 3 && tenish(reject.unit) && run.every((r) => tenish(r.unit)) : days >= 2;
        if (d2 !== true && lastP && enough && deviates(p, lastP, day, inst) === false) {
          for (const r of run) {
            if (r.unit === undefined) {
              dropped.add(r.outlier);
              dropped.add(r.flag);
            }
            outliers.push({ tx: r.tx, code: 'TRADE_PRICE_CONFIRMED_BY_RUN', severity: 'warning', message: `Trade price ${r.price} of ${id} was rejected and then confirmed by later consistent trade prices (${dayToIso(day)}: ${p}); used as the price — check that it is not a systematic import error` });
            priceFlags.push({ day: r.day, instrumentId: id, code: 'TRADE_PRICE_CONFIRMED_BY_RUN' });
            accept(id, r.day, r.price);
          }
          if (reject.unit) {
            // Structured: `accepted` 1 = the price is already used; `unitFactor` = the suspected factor.
            outliers.push({ tx, code: 'TRADE_PRICE_UNIT_SUSPECT', severity: 'warning', data: { unitFactor: reject.unit, accepted: 1 }, message: `${reject.message} — accepted because ${days} consistent prices on distinct days confirm the new level` });
            priceFlags.push({ day, instrumentId: id, code: 'TRADE_PRICE_UNIT_SUSPECT' });
          }
          priceFlags.push({ day, instrumentId: id, code: 'TRADE_PRICE_CONFIRMED_BY_RUN' });
          pending.delete(id);
          unconfirmed.delete(id);
          accept(id, day, p);
          continue;
        }
        const code = reject.unit ? ('TRADE_PRICE_UNIT_SUSPECT' as const) : ('TRADE_PRICE_OUTLIER' as const);
        const outlier = { tx, code, severity: 'warning' as const, message: reject.message, ...(reject.unit ? { data: { unitFactor: reject.unit, accepted: 0 } } : {}) };
        const flag = { day, instrumentId: id, code };
        outliers.push(outlier);
        priceFlags.push(flag);
        if (reject.unit && !tenish(reject.unit)) continue;
        if (d2 !== true) {
          // keep only the latest run of mutually consistent rejected prints
          const keep = lastP && deviates(p, lastP, day, inst) === false ? run : [];
          keep.push({ day, price: p, tx, outlier, flag, unit: reject.unit });
          pending.set(id, keep.slice(-5));
        }
        continue;
      }
      pending.delete(id);
      // C46: a print that agrees with a previous unconfirmed print (no close against it) confirms it
      const prevUnc = unconfirmed.get(id);
      if (prevUnc && prevUnc.day !== day && d1 === false && d2 !== true) {
        dropped.add(prevUnc.outlier);
        dropped.add(prevUnc.flag);
        unconfirmed.delete(id);
      }
      if (flagUnconfirmed) {
        const outlier = { tx, code: 'TRADE_PRICE_UNCONFIRMED', severity: 'info' as const, message: `Trade price ${p} of ${id} moved more than ${pct} % from ${prevRef!.price.toFixed(4)} and there is no later close to confirm it; used as the price — please confirm` };
        const flag = { day, instrumentId: id, code: 'TRADE_PRICE_UNCONFIRMED' as const };
        outliers.push(outlier);
        priceFlags.push(flag);
        unconfirmed.set(id, { day, outlier, flag });
      }
      if (before > 0 && q < 0.005 * before && sameDay && day - sameDay.day <= 7) continue;
      accept(id, day, p);
    }
  }

  // C50/C54: a jump between two consecutive prices (market closes, or accepted trade prints) close to
  // a split ratio while the position is held, with no SPLIT/STOCK_DIVIDEND recorded around it:
  // - the provider lists a split there (MarketData corporate actions): warning, source 'provider';
  // - price-only evidence: ratios 4, 5, 8, 10, 20, 25, 50, 100 (or inverses) within 3 % on daily
  //   gaps (widening to ~11 % for month-end series) and a level that persists: warning; ratios 2 and
  //   3 need gaps up to 4 days and 1 % and are info only (real crashes look the same);
  // - a fall to about 1/1000 is POSSIBLE_REDENOMINATION (cash is not redenominated by the engine).
  // Crypto is excluded (no splits). Warnings also reach rows and summaries; the diagnostic carries
  // the ratio as structured `data` (ratioFrom old shares -> ratioTo new shares).
  {
    const RATIOS = [2, 3, 4, 5, 8, 10, 20, 25, 50, 100, 1000];
    const qty = new Map<string, number>();
    const intervals = new Map<string, [number, number][]>();
    const splits = new Map<string, number[]>();
    const txsOf = new Map<string, SortedTx[]>();
    for (const st of sorted) {
      const { tx, day } = st;
      const id = tx.instrumentId;
      if (!id) continue;
      let list = txsOf.get(id);
      if (!list) txsOf.set(id, (list = []));
      list.push(st);
      const q0 = qty.get(id) ?? 0;
      let q1 = q0;
      const n = num(tx.quantity);
      if (tx.type === 'BUY' || tx.type === 'TRANSFER_IN') q1 = q0 + n;
      else if (tx.type === 'SELL' || tx.type === 'TRANSFER_OUT') q1 = q0 - n;
      else if (tx.type === 'SPLIT' || tx.type === 'STOCK_DIVIDEND') {
        let sp = splits.get(id);
        if (!sp) splits.set(id, (sp = []));
        sp.push(day);
        if (tx.type === 'SPLIT' && !tx.subtype) q1 = q0 * (num(tx.ratio) || 1);
      }
      if (q1 === q0) continue;
      qty.set(id, q1);
      let iv = intervals.get(id);
      if (!iv) intervals.set(id, (iv = []));
      if (q0 <= QTY_EPS && q1 > QTY_EPS) iv.push([day, Infinity]);
      else if (q0 > QTY_EPS && q1 <= QTY_EPS && iv.length) (iv[iv.length - 1] as [number, number])[1] = day;
    }
    type Pt = { day: number; close: number };
    // returns new shares per old share (k for a k:1 split, 1/k for a 1:k reverse split)
    const near = (a: Pt, b: Pt, after: Pt | undefined): { shares: number; strong: boolean } | undefined => {
      if (!(a.close > 0) || !(b.close > 0)) return undefined;
      const r = b.close / a.close;
      const gap = b.day - a.day;
      if (after && after.day - b.day <= 10 && Math.abs(after.close / b.close - 1) > 0.25) return undefined; // level must persist
      for (const k of RATIOS) {
        const small = k <= 3;
        if (small && gap > 4) continue;
        const t = small ? 0.01 : Math.min(0.15, 0.03 * Math.max(1, Math.sqrt(gap / 2)));
        if (Math.abs(r * k - 1) <= t) return { shares: k, strong: !small };
        if (k < 1000 && Math.abs(r / k - 1) <= t) return { shares: 1 / k, strong: !small };
      }
      return undefined;
    };
    for (const [id, ivs] of intervals) {
      if (instruments.get(id)?.assetClass === 'crypto') continue;
      const sp = splits.get(id) ?? [];
      const obs = observations.get(id);
      const flagged = new Set<number>();
      const report = (a: Pt, b: Pt, after: Pt | undefined) => {
        if (flagged.has(b.day) || sp.some((d) => d >= a.day - 3 && d <= b.day + 3)) return;
        const provider = market.splitFactor(id, a.day, b.day);
        let hit = near(a, b, after);
        let source = 'prices';
        if (provider !== 1 && provider > 0) {
          hit = { shares: provider, strong: true };
          source = 'provider';
        }
        if (!hit) return;
        flagged.add(b.day);
        const list = txsOf.get(id) ?? [];
        const ref = list.find((x) => x.day >= b.day) ?? list[list.length - 1];
        if (!ref) return;
        const k = hit.shares;
        const redenom = source === 'prices' && k > 999;
        const ratioFrom = k >= 1 ? 1 : Math.round(1 / k);
        const ratioTo = k >= 1 ? Math.round(k) : 1;
        const data = { instrumentId: id, ratioFrom, ratioTo, splitRatio: ratioTo / ratioFrom, priceFrom: a.close, priceTo: b.close, dateFrom: dayToIso(a.day), dateTo: dayToIso(b.day), source };
        if (redenom) {
          outliers.push({ tx: ref.tx, day: b.day, data, code: 'POSSIBLE_REDENOMINATION', severity: 'warning', message: `The price of ${id} went from ${a.close} (${dayToIso(a.day)}) to ${b.close} (${dayToIso(b.day)}), about 1/1000: a currency redenomination or a 1000:1 split? Record a SPLIT if it was a split; the engine does not redenominate cash or past flows` });
          priceFlags.push({ day: b.day, instrumentId: id, code: 'POSSIBLE_REDENOMINATION' });
          return;
        }
        const label = k >= 1 ? `${ratioTo}:1 split (${ratioTo} new shares per share)` : `1:${ratioFrom} reverse split (1 new share per ${ratioFrom})`;
        outliers.push({ tx: ref.tx, day: b.day, data, code: 'POSSIBLE_UNRECORDED_SPLIT', severity: hit.strong ? 'warning' : 'info', message: `The price of ${id} went from ${a.close} (${dayToIso(a.day)}) to ${b.close} (${dayToIso(b.day)}), consistent with a ${label}${source === 'provider' ? ' listed by the data provider' : ''}, and no split is recorded; if there was one, record it (SPLIT ratio ${ratioTo / ratioFrom}; applyCorporateActions can suggest it)` });
        if (hit.strong) priceFlags.push({ day: b.day, instrumentId: id, code: 'POSSIBLE_UNRECORDED_SPLIT' });
      };
      for (const [s0, e0] of ivs) {
        let prev = market.pricePointAt(id, s0);
        let guard = 0;
        for (let nx = market.pricePointAfter(id, prev ? prev.day : s0 - 1); nx && nx.day <= e0 && guard < 1_000_000; nx = market.pricePointAfter(id, nx.day), guard++) {
          if (prev) report(prev, nx, market.pricePointAfter(id, nx.day));
          prev = nx;
        }
        if (obs) {
          for (let i = 1; i < obs.days.length; i++) {
            const d = obs.days[i] as number;
            const d0 = obs.days[i - 1] as number;
            if (d0 < s0 || d > e0) continue;
            // only when no market close lies between them (closes are checked above)
            const pm = market.pricePointAt(id, d);
            if (pm && pm.day >= d0) continue;
            const nd = obs.days[i + 1];
            report({ day: d0, close: obs.prices[i - 1] as number }, { day: d, close: obs.prices[i] as number }, nd === undefined ? undefined : { day: nd, close: obs.prices[i + 1] as number });
          }
        }
      }
    }
  }

  // C24/C39: maturities are paid on the next business day of the instrument's calendar. A recorded
  // SELL/TRANSFER_OUT of the instrument on or after the maturity date is the real payment and
  // replaces the automatic redemption (a matured instrument cannot be sold later); when it comes
  // after `settlementWindowDays` business days (default 5) it is reported as LATE_REDEMPTION.
  const maturities: EngineContext['maturities'] = [];
  if (options.autoRedeemAtMaturity) {
    const used = new Set(sorted.map((x) => x.tx.instrumentId).filter(Boolean) as string[]);
    for (const id of used) {
      const inst = instruments.get(id);
      const m = inst?.accrual?.maturity;
      if (!m || !isStrictIsoDate(m)) continue;
      const cal = calendarForCurrency(inst?.currency);
      const mDay = isoToDay(m);
      const payDay = nextBusinessDay(mDay, cal);
      const windowEnd = addBusinessDays(payDay, inst?.accrual?.settlementWindowDays ?? 5, cal);
      const recorded = sorted.find((x) => x.tx.instrumentId === id && (x.tx.type === 'SELL' || x.tx.type === 'TRANSFER_OUT') && x.day >= mDay);
      if (!recorded) maturities.push({ day: payDay, maturityDay: mDay, instrumentId: id });
      else if (recorded.day > windowEnd) {
        outliers.push({ tx: recorded.tx, code: 'LATE_REDEMPTION', severity: 'info', message: `${id} matured on ${m} and its redemption was recorded on ${recorded.tx.date}, after the ${inst?.accrual?.settlementWindowDays ?? 5}-business-day window; the recorded payment is used and the value stays at the maturity value until then` });
      }
    }
    maturities.sort((a, b) => a.day - b.day);
  }

  return {
    base,
    portfolioBase: input.portfolio.baseCurrency,
    taxResidence: residenceOf(input.portfolio.taxResidence, input.portfolio.baseCurrency),
    fundingCurrency: raw.fundingCurrency ?? sorted.find((x) => x.tx.type === 'DEPOSIT')?.tx.currency ?? input.portfolio.baseCurrency,
    ...(raw.isolatePortfolioCash ? { fundingByPortfolio: fundingByPortfolio(sorted.map((x) => x.tx), raw, input.portfolio.baseCurrency) } : {}),
    market,
    instruments,
    options,
    raw,
    sorted,
    rejected,
    observations,
    firstTradePrice,
    splitAdj,
    maturities,
    outliers: dropped.size ? outliers.filter((x) => !dropped.has(x)) : outliers,
    priceFlags: dropped.size ? priceFlags.filter((x) => !dropped.has(x)) : priceFlags,
  };
}

/**
 * C44: warnings for questionable trade prints affecting the period (startDay, endDay]: prints
 * recorded inside it, and unconfirmed prints recorded earlier that still set the price at the end
 * (no market close since). Format `CODE:id1,id2`.
 */
export function priceFlagWarnings(ctx: EngineContext, startDay: number, endDay: number): string[] {
  if (!ctx.priceFlags.length) return [];
  const by = new Map<string, Set<string>>();
  for (const f of ctx.priceFlags) {
    if (f.day > endDay) continue;
    let hit = f.day > startDay;
    if (!hit && f.code === 'TRADE_PRICE_UNCONFIRMED') {
      const last = ctx.market.priceDayAt(f.instrumentId, endDay);
      const obs = ctx.observations.get(f.instrumentId);
      const lastObs = obs ? (obs.days.filter((d) => d <= endDay).pop() ?? -Infinity) : -Infinity;
      hit = (last === undefined || last < f.day) && lastObs <= f.day;
    }
    if (!hit) continue;
    let set = by.get(f.code);
    if (!set) by.set(f.code, (set = new Set()));
    set.add(f.instrumentId);
  }
  return Array.from(by, ([code, ids]) => `${code}:${Array.from(ids).sort().join(',')}`);
}

const CASH_EPS = 1e-7;

/** Codes of questionable prices that reach MonthlyRow/PerformanceSummary warnings. */
export type PriceFlagCode = 'TRADE_PRICE_OUTLIER' | 'TRADE_PRICE_UNCONFIRMED' | 'TRADE_PRICE_UNIT_SUSPECT' | 'TRADE_PRICE_CONFIRMED_BY_RUN' | 'POSSIBLE_UNRECORDED_SPLIT' | 'POSSIBLE_REDENOMINATION';

/** Who a coupon belongs to and how much interest accrued over its period (see Ledger.couponPlan). */
interface CouponPlan {
  values: number[];
  principal: number[];
  since: number[];
  ent: number[];
  units: number;
  totalQ: number;
  p: number;
  pStart: number;
  conv: number;
}
const NO_ACCOUNT = '';
/** isolatePortfolioCash: cash keys are `${portfolioId}${PF_SEP}${account}`; `${portfolioId}${PF_SEP}` is its unassigned cash. */
const PF_SEP = '\u0000';

function fundingByPortfolio(txs: Transaction[], raw: EngineOptions, fallback: CurrencyCode): Map<string, CurrencyCode> {
  const out = new Map<string, CurrencyCode>();
  for (const t of txs) if (t.type === 'DEPOSIT' && !out.has(t.portfolioId)) out.set(t.portfolioId, t.currency);
  for (const t of txs) if (!out.has(t.portfolioId)) out.set(t.portfolioId, raw.fundingCurrency ?? raw.portfolioBaseCurrencies?.[t.portfolioId] ?? fallback);
  if (raw.fundingCurrency) for (const k of out.keys()) out.set(k, raw.fundingCurrency);
  return out;
}

/** Account part of a cash key (drops the portfolio scope of isolatePortfolioCash). */
export function cashAccountLabel(key: string): string {
  const i = key.indexOf(PF_SEP);
  return i < 0 ? key : key.slice(i + 1);
}

interface InternalRealized extends RealizedGain {
  day: number;
}
interface InternalIncome extends IncomeEvent {
  day: number;
}

type Buckets = Omit<Attribution, 'day' | 'instrumentId' | 'rateDiff' | 'cashBase'>;
const emptyBuckets = (): Buckets => ({ realized: 0, realizedFx: 0, income: 0, otherCosts: 0, fxConversion: 0, spread: 0, transfer: 0, corporate: 0 });

export class Ledger {
  /** Position books by instrument (PortfolioBooks with isolatePortfolioCash: read the sum). */
  readonly books = new Map<string, BookView>();
  /** portfolioId of the transaction being applied (isolatePortfolioCash). */
  private curPid = '';
  readonly instrumentOf = new Map<string, Instrument>();
  readonly accountQty = new Map<string, Map<string, number>>();
  readonly cash = new Map<CurrencyCode, number>();
  readonly cashByAccount = new Map<CurrencyCode, Map<string, number>>();
  readonly realized: InternalRealized[] = [];
  readonly income: InternalIncome[] = [];
  readonly flows: ExternalFlow[] = [];
  readonly costs: CostEvent[] = [];
  readonly attributions: Attribution[] = [];
  readonly positionFlows: PositionFlow[] = [];
  readonly diagnostics: Diagnostic[] = [];
  /** Index into ctx.sorted of the next transaction to process. */
  cursor = 0;
  private matCursor = 0;
  /** C56: merger cash receivables (credited on the ex-date, paid on payDay). */
  readonly receivables: { currency: CurrencyCode; amount: number; payDay: number; account: string }[] = [];
  /** C42: day of the last coupon paid per accrual instrument. */
  private readonly lastCoupon = new Map<string, number>();
  /** Day of the last processed transaction (or -Infinity). */
  lastDay = -Infinity;

  // per-transaction scratch
  private curTx: Transaction | undefined;
  private curDay = 0;
  private txCash = 0;
  private txFlow = 0;
  private bk: Buckets = emptyBuckets();
  private pf: PositionFlow | undefined;

  constructor(readonly ctx: EngineContext) {
    for (const r of ctx.rejected) this.diag(r.tx, NaN, r.code, r.message, 'error');
    for (const o of ctx.outliers) this.diag(o.tx, o.day ?? isoToDay(o.tx.date), o.code, o.message, o.severity, o.data);
  }

  get done(): boolean {
    return this.cursor >= this.ctx.sorted.length && this.matCursor >= this.ctx.maturities.length;
  }

  applyUntil(day: number): void {
    const sorted = this.ctx.sorted;
    const mats = this.ctx.maturities;
    for (;;) {
      const s = sorted[this.cursor];
      const m = mats[this.matCursor];
      const txDay = s ? s.day : Infinity;
      const matDay = m ? m.day : Infinity;
      if (matDay < txDay && matDay <= day) {
        this.matCursor++;
        this.redeemAtMaturity(m!.instrumentId, matDay);
        continue;
      }
      if (txDay <= day && txDay !== Infinity) {
        this.cursor++;
        this.lastDay = s!.day;
        this.applyWrapped(s!.tx, s!.day);
        continue;
      }
      break;
    }
  }

  applyAll(): void {
    this.applyUntil(Infinity);
  }

  /**
   * State "before the trades" of `day`: everything up to the previous day plus the start-of-day
   * corporate actions of `day` (rank < 0: splits, bonus shares, spin-offs, mergers). Used for
   * the pre-flow valuation P(f), whose prices are already post-split on an ex-date (C22).
   */
  applyStartOfDay(day: number): void {
    this.applyUntil(day - 1);
    const sorted = this.ctx.sorted;
    while (this.cursor < sorted.length) {
      const s = sorted[this.cursor] as SortedTx;
      if (s.day !== day || s.rank >= 0) break;
      this.cursor++;
      this.lastDay = s.day;
      this.applyWrapped(s.tx, s.day);
    }
  }

  // ---- helpers --------------------------------------------------------------

  diag(tx: Transaction | undefined, day: number, code: string, message: string, severity: Diagnostic['severity'] = 'warning', data?: Diagnostic['data']): void {
    if (this.diagnostics.length < 5000) {
      const d: Diagnostic = { transactionId: tx?.id, date: Number.isFinite(day) ? dayToIso(day) : String(tx?.date ?? ''), code, message, severity };
      if (data) d.data = data;
      this.diagnostics.push(d);
    }
  }

  instrument(id: string, tx?: Transaction): Instrument {
    let inst = this.instrumentOf.get(id) ?? this.ctx.instruments.get(id);
    if (!inst) {
      inst = {
        id,
        symbol: id.includes(':') ? id.slice(id.indexOf(':') + 1) : id,
        name: id,
        exchange: 'MANUAL',
        currency: tx?.currency ?? this.ctx.base,
        country: '',
        assetClass: 'other',
      };
      this.diag(tx, tx && isStrictIsoDate(tx.date) ? isoToDay(tx.date) : NaN, 'UNKNOWN_INSTRUMENT', `Instrument ${id} not found; using transaction currency`, 'error');
    }
    this.instrumentOf.set(id, inst);
    return inst;
  }

  /** The book a transaction mutates: the instrument's, or its portfolio's part with isolatePortfolioCash. */
  book(id: string): LotBook {
    let b = this.books.get(id);
    if (this.ctx.fundingByPortfolio) {
      if (!b) this.books.set(id, (b = new PortfolioBooks(this.ctx.options.costMethod)));
      return (b as PortfolioBooks).part(this.curPid);
    }
    if (!b) this.books.set(id, (b = new LotBook(this.ctx.options.costMethod)));
    return b as LotBook;
  }

  /** Read-only lookup of the book `book(id)` would return (undefined when there is none). */
  private peek(id: string): LotBook | undefined {
    const b = this.books.get(id);
    if (!b) return undefined;
    return this.ctx.fundingByPortfolio ? (b as PortfolioBooks).parts.get(this.curPid) : (b as LotBook);
  }

  /** Market FX (base per unit) used for cash valuation; same function everywhere. */
  X(ccy: CurrencyCode, day: number, hint?: number): number {
    if (ccy === this.ctx.base) return 1;
    const r = this.ctx.market.fxAt(ccy, this.ctx.base, day) ?? this.ctx.market.fxNearest(ccy, this.ctx.base, day) ?? hint;
    if (r === undefined) {
      this.diag(this.curTx, day, 'MISSING_FX', `No FX ${ccy}/${this.ctx.base} for ${dayToIso(day)}; valued at 0`, 'error');
      return 0;
    }
    return r;
  }

  private hintFor(ccy: CurrencyCode): number | undefined {
    const tx = this.curTx;
    if (!tx || ccy !== tx.currency) return undefined;
    if (ccy === this.ctx.base) return 1;
    if (this.ctx.base === this.ctx.portfolioBase && tx.fxRateToBase && tx.fxRateToBase > 0) return tx.fxRateToBase;
    return undefined;
  }

  /** Units of base per unit of `ccy` for historical cost of a transaction (executed rate first). */
  txRate(tx: Transaction, day: number, ccy: CurrencyCode = tx.currency): number {
    const { base, portfolioBase, market } = this.ctx;
    if (ccy === base) return 1;
    if (ccy === tx.currency && base === portfolioBase && tx.fxRateToBase && tx.fxRateToBase > 0) return tx.fxRateToBase;
    const r = market.fxAt(ccy, base, day) ?? market.fxNearest(ccy, base, day);
    if (r === undefined) {
      this.diag(tx, day, 'MISSING_FX', `No FX ${ccy}/${base} for ${dayToIso(day)}`, 'error');
      return 0;
    }
    return r;
  }

  /** Units of `to` per unit of `from` at day, for converting a transaction amount. */
  private convert(tx: Transaction, day: number, from: CurrencyCode, to: CurrencyCode): number {
    if (from === to) return 1;
    const r = this.ctx.market.fxAt(from, to, day) ?? this.ctx.market.fxNearest(from, to, day);
    if (r === undefined) {
      this.diag(tx, day, 'MISSING_FX', `No FX ${from}/${to} for ${dayToIso(day)}; assuming 1`, 'error');
      return 1;
    }
    return r;
  }

  private addFlow(tx: Transaction, day: number, ccy: CurrencyCode, amount: number, kind: FlowKind): void {
    if (amount === 0 || !Number.isFinite(amount)) return;
    const hint = this.hintFor(ccy);
    const base = amount * this.X(ccy, day, hint);
    this.txFlow += base;
    this.flows.push({ day, currency: ccy, amount, kind, transactionId: tx.id, rateHint: hint, base });
  }

  private moveCash(ccy: CurrencyCode, account: string, delta: number): void {
    if (delta === 0) return;
    this.txCash += delta * this.X(ccy, this.curDay, this.hintFor(ccy));
    let v = (this.cash.get(ccy) ?? 0) + delta;
    if (Math.abs(v) < CASH_EPS) v = 0;
    this.cash.set(ccy, v);
    let m = this.cashByAccount.get(ccy);
    if (!m) this.cashByAccount.set(ccy, (m = new Map()));
    let a = (m.get(account) ?? 0) + delta;
    if (Math.abs(a) < CASH_EPS) a = 0;
    m.set(account, a);
  }

  private credit(tx: Transaction, ccy: CurrencyCode, amount: number): void {
    if (amount !== 0) this.moveCash(ccy, this.cashAcct(tx), amount);
  }

  /** Cash key of a transaction: its account, scoped by portfolio with isolatePortfolioCash. */
  private cashAcct(tx: Transaction): string {
    const acct = tx.account ?? NO_ACCOUNT;
    return this.ctx.fundingByPortfolio ? `${tx.portfolioId}${PF_SEP}${acct}` : acct;
  }

  /** The unassigned-cash key that `acct` may draw on (the portfolio's, with isolatePortfolioCash). */
  private unassignedOf(acct: string): string {
    const i = acct.indexOf(PF_SEP);
    return i < 0 ? NO_ACCOUNT : acct.slice(0, i + 1);
  }

  /** Total cash in `ccy` that an unassigned row can use (the portfolio's, with isolatePortfolioCash). */
  private cashOfScope(ccy: CurrencyCode, acct: string): number {
    if (!this.ctx.fundingByPortfolio) return this.cash.get(ccy) ?? 0;
    const prefix = this.unassignedOf(acct);
    let s = 0;
    for (const [k, v] of this.cashByAccount.get(ccy) ?? []) if (k.startsWith(prefix)) s += v;
    return s;
  }

  private acctCash(ccy: CurrencyCode, acct: string): number {
    return this.cashByAccount.get(ccy)?.get(acct) ?? 0;
  }

  /**
   * Cash usable by a transaction of account `acct` (C30): its own balance plus cash recorded
   * without an account. Rows without an account may use the whole balance of the currency.
   */
  private availableFor(ccy: CurrencyCode, acct: string): number {
    const pending = this.receivables.length ? this.pendingReceivable(ccy, this.curDay, acct) : 0;
    const free = this.unassignedOf(acct);
    if (acct === free) return Math.max(this.cashOfScope(ccy, acct) - pending, 0);
    return Math.max(this.acctCash(ccy, acct) + Math.max(this.acctCash(ccy, free), 0) - pending, 0);
  }

  /** C56: merger cash credited on the ex-date but paid later (not yet available on `day`). */
  pendingReceivable(ccy: CurrencyCode, day: number, acct?: string): number {
    let s = 0;
    for (const r of this.receivables) if (r.currency === ccy && r.payDay > day && (acct === undefined || r.account === acct || r.account === this.unassignedOf(acct))) s += r.amount;
    return s;
  }

  /** Move unassigned cash ('' account) into `acct` (bookkeeping only; totals unchanged). */
  private pullUnassigned(ccy: CurrencyCode, acct: string, need: number): void {
    const unassigned = this.unassignedOf(acct);
    if (acct === unassigned || need <= 0) return;
    const free = Math.max(this.acctCash(ccy, unassigned), 0);
    const take = Math.min(free, need);
    if (take <= 0) return;
    const m = this.cashByAccount.get(ccy)!;
    m.set(unassigned, (m.get(unassigned) ?? 0) - take);
    m.set(acct, (m.get(acct) ?? 0) + take);
  }

  /**
   * Debit cash. With implicit cash flows enabled, a shortfall (amount above the cash available
   * to the transaction's account) is first covered by converting base-currency cash of the SAME
   * account at the market rate (implicitFx 'fromBaseCash', when the debit is in another
   * currency), then by an implicit external deposit.
   */
  private debit(tx: Transaction, day: number, ccy: CurrencyCode, amount: number, opts: { implicit?: boolean; fx?: boolean } = {}): void {
    if (amount === 0 || !Number.isFinite(amount)) return;
    const acct = this.cashAcct(tx);
    const implicit = (opts.implicit ?? true) && this.ctx.options.implicitCashFlows;
    if (amount > 0) this.pullUnassigned(ccy, acct, amount - Math.max(this.acctCash(ccy, acct), 0));
    if (amount > 0 && implicit) {
      let shortfall = amount - this.availableFor(ccy, acct);
      const pb = this.ctx.fundingByPortfolio?.get(tx.portfolioId) ?? this.ctx.fundingCurrency;
      if (shortfall > CASH_EPS && (opts.fx ?? true) && this.ctx.options.implicitFx === 'fromBaseCash' && ccy !== pb) {
        const avail = this.availableFor(pb, acct);
        const r = this.ctx.market.fxAt(ccy, pb, day) ?? this.ctx.market.fxNearest(ccy, pb, day); // pb per ccy
        if (avail > CASH_EPS && r !== undefined && r > 0) {
          const usePb = Math.min(avail, shortfall * r);
          const got = usePb / r;
          this.pullUnassigned(pb, acct, usePb - Math.max(this.acctCash(pb, acct), 0));
          const before = this.txCash;
          this.moveCash(pb, acct, -usePb);
          this.moveCash(ccy, acct, got);
          this.bk.fxConversion += this.txCash - before;
          shortfall -= got;
          this.diag(tx, day, 'IMPLICIT_FX_CONVERSION', `Converted ${usePb.toFixed(2)} ${pb} to ${got.toFixed(2)} ${ccy} at market rate to fund ${tx.type}`, 'info');
        } else if (this.cashOfScope(pb, acct) > CASH_EPS && acct !== this.unassignedOf(acct)) {
          this.diag(tx, day, 'IMPLICIT_FX_OTHER_ACCOUNT', `${pb} cash exists only in other accounts; not used to fund ${tx.type} in '${cashAccountLabel(acct)}' (implicit deposit booked instead)`, 'info');
        }
      }
      if (shortfall > CASH_EPS) {
        this.moveCash(ccy, acct, shortfall);
        this.addFlow(tx, day, ccy, shortfall, 'IMPLICIT_DEPOSIT');
        if (tx.type === 'WITHDRAWAL' || tx.type === 'TRANSFER_OUT') {
          this.diag(tx, day, 'WITHDRAWAL_EXCEEDS_CASH', `${tx.type} of ${amount} ${ccy} exceeds cash; shortfall ${shortfall.toFixed(2)} booked as an implicit deposit (unrecorded deposit?)`, 'warning');
        }
      }
    }
    this.moveCash(ccy, acct, -amount);
    const after = this.cash.get(ccy) ?? 0;
    if (after < -CASH_EPS) {
      this.diag(tx, day, 'NEGATIVE_CASH', `Cash ${ccy} negative (${after.toFixed(2)}) after ${tx.type}`, 'warning');
    }
  }

  private recordCosts(tx: Transaction, day: number, fees: number, taxes: number, ccy: CurrencyCode = tx.currency): void {
    if (!fees && !taxes) return;
    const r = this.txRate(tx, day, ccy);
    this.costs.push({ day, instrumentId: tx.instrumentId, feesBase: fees * r, taxesBase: taxes * r });
    if (this.pf) this.pf.feesBase += (fees + taxes) * r;
  }

  private moveAccountQty(instrumentId: string, account: string, delta: number, tx?: Transaction, day?: number): void {
    let m = this.accountQty.get(instrumentId);
    if (!m) this.accountQty.set(instrumentId, (m = new Map()));
    const v = (m.get(account) ?? 0) + delta;
    m.set(account, v);
    if (v < -QTY_EPS && tx) {
      this.diag(tx, day ?? NaN, 'NEGATIVE_ACCOUNT_QTY', `Account '${account}' holds ${roundQty(v)} ${instrumentId} (sold from an account that did not buy it)`, 'warning');
    }
  }

  private scaleAccountQty(instrumentId: string, factor: number): void {
    const m = this.accountQty.get(instrumentId);
    if (!m) return;
    for (const [k, v] of m) m.set(k, v * factor);
  }

  /** Price in instrument currency at day (market close or trade print), for flows valued at market. */
  marketPrice(inst: Instrument, day: number): number | undefined {
    return priceInfo(this.ctx, inst, day)?.price;
  }

  private positionFlow(instrumentId: string, day: number): PositionFlow {
    if (!this.pf || this.pf.instrumentId !== instrumentId) {
      this.pf = { day, instrumentId, inBase: 0, outBase: 0, endOutBase: 0, incomeBase: 0, feesBase: 0, startInBase: 0, startOutBase: 0 };
      this.positionFlows.push(this.pf);
    }
    return this.pf;
  }

  private pushRealized(r: Omit<InternalRealized, 'priceGainBase' | 'fxGainBase'>): void {
    const X0 = r.cost !== 0 ? r.costBase / r.cost : r.proceeds !== 0 ? r.proceedsBase / r.proceeds : 0;
    const priceGainBase = (r.proceeds - r.cost) * X0;
    const fxGainBase = r.gainBase - priceGainBase;
    this.realized.push({ ...r, priceGainBase, fxGainBase });
    this.bk.realized += r.gainBase;
    this.bk.realizedFx += fxGainBase;
  }

  // ---- transaction processing ------------------------------------------------

  private applyWrapped(tx: Transaction, day: number): void {
    this.curTx = tx;
    this.curPid = tx.portfolioId;
    this.curDay = day;
    this.txCash = 0;
    this.txFlow = 0;
    this.bk = emptyBuckets();
    this.pf = undefined;
    const ids = [tx.instrumentId, tx.targetInstrumentId].filter((x): x is string => !!x);
    const cbBefore = ids.reduce((s, id) => s + (this.books.get(id)?.costBasisBase ?? 0), 0);
    this.apply(tx, day);
    const cbAfter = ids.reduce((s, id) => s + (this.books.get(id)?.costBasisBase ?? 0), 0);
    this.closeAttribution(day, tx.instrumentId, cbAfter - cbBefore);
    this.curTx = undefined;
  }

  private closeAttribution(day: number, instrumentId: string | undefined, dCost: number): void {
    const c = this.txCash - this.txFlow + dCost;
    const b = this.bk;
    const known = b.realized + b.income + b.otherCosts + b.fxConversion + b.transfer + b.corporate;
    this.attributions.push({ day, instrumentId, ...b, rateDiff: c - known, cashBase: this.txCash });
  }

  private apply(tx: Transaction, day: number): void {
    const fees = num(tx.fees);
    const taxes = num(tx.taxes);
    const ccy = tx.currency;
    switch (tx.type) {
      case 'DEPOSIT': {
        const amt = num(tx.amount);
        this.credit(tx, ccy, amt);
        this.addFlow(tx, day, ccy, amt, 'DEPOSIT');
        this.standaloneCost(tx, day, ccy, fees + taxes, { implicit: false });
        this.recordCosts(tx, day, fees, taxes);
        return;
      }
      case 'WITHDRAWAL': {
        const amt = num(tx.amount);
        this.addFlow(tx, day, ccy, -amt, 'WITHDRAWAL');
        this.debit(tx, day, ccy, amt, { fx: false });
        this.standaloneCost(tx, day, ccy, fees + taxes, { fx: false });
        this.recordCosts(tx, day, fees, taxes);
        return;
      }
      case 'BUY':
        return this.buy(tx, day, fees, taxes);
      case 'SELL':
        return this.sell(tx, day, fees, taxes);
      case 'SPLIT':
        return this.split(tx, day);
      case 'STOCK_DIVIDEND':
        return this.stockDividend(tx, day);
      case 'DIVIDEND':
      case 'INTEREST':
        return this.income_(tx, day, fees, taxes);
      case 'RETURN_OF_CAPITAL':
        return this.returnOfCapital(tx, day, fees, taxes);
      case 'FEE': {
        const amt = tx.amount !== undefined ? num(tx.amount) : fees;
        this.standaloneCost(tx, day, ccy, amt + taxes);
        this.recordCosts(tx, day, amt, taxes);
        return;
      }
      case 'TAX': {
        const amt = tx.amount !== undefined ? num(tx.amount) : taxes;
        if (amt >= 0) this.standaloneCost(tx, day, ccy, amt + fees);
        else {
          const before = this.txCash;
          this.credit(tx, ccy, -amt);
          this.bk.otherCosts += this.txCash - before;
          this.standaloneCost(tx, day, ccy, fees);
        }
        this.recordCosts(tx, day, fees, amt);
        return;
      }
      case 'FX_CONVERSION':
        return this.fxConversion(tx, day, fees, taxes);
      case 'TRANSFER_IN':
        return this.transferIn(tx, day, fees, taxes);
      case 'TRANSFER_OUT':
        return this.transferOut(tx, day, fees, taxes);
      default:
        this.diag(tx, day, 'UNKNOWN_TYPE', `Unknown transaction type ${String((tx as Transaction).type)}`, 'error');
    }
  }

  /**
   * Debit a standalone cost and attribute it to otherCosts: cash moves of the debit minus any
   * implicit deposit, minus any implicit FX conversion (attributed to fxConversion). Returns it.
   */
  private standaloneCost(tx: Transaction, day: number, ccy: CurrencyCode, amount: number, opts: { implicit?: boolean; fx?: boolean } = {}): number {
    if (!amount) return 0;
    const before = this.txCash - this.txFlow;
    const fxBefore = this.bk.fxConversion;
    this.debit(tx, day, ccy, amount, opts);
    const net = this.txCash - this.txFlow - before - (this.bk.fxConversion - fxBefore);
    this.bk.otherCosts += net;
    return net;
  }

  private gross(tx: Transaction, inst: Instrument): number {
    if (tx.amount !== undefined && tx.amount !== null) return num(tx.amount);
    return (num(tx.quantity) * num(tx.price)) / mult(inst);
  }

  /** Per-unit value before fees in instrument currency (accrual anchor). */
  private unitValueOf(tx: Transaction, inst: Instrument, k: number): number {
    const q = num(tx.quantity);
    return q > 0 ? (this.gross(tx, inst) * k) / q : 0;
  }

  private buy(tx: Transaction, day: number, fees: number, taxes: number): void {
    if (!tx.instrumentId) return this.diag(tx, day, 'MISSING_INSTRUMENT', 'Buy without instrument', 'error');
    const q = num(tx.quantity);
    if (!(q > 0)) return this.diag(tx, day, 'INVALID_QUANTITY', 'Buy quantity must be > 0', 'error');
    const inst = this.instrument(tx.instrumentId, tx);
    const total = this.gross(tx, inst) + fees + taxes; // fees and transaction taxes are capitalized
    this.debit(tx, day, tx.currency, total);
    const k = this.convert(tx, day, tx.currency, inst.currency);
    this.book(inst.id).add(day, q, total * k, total * this.txRate(tx, day), this.unitValueOf(tx, inst, k));
    this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, q, tx, day);
    const pf = this.positionFlow(inst.id, day);
    pf.inBase += total * this.X(tx.currency, day, this.hintFor(tx.currency));
    this.recordCosts(tx, day, fees, taxes);
  }

  private sell(tx: Transaction, day: number, fees: number, taxes: number): void {
    if (!tx.instrumentId) return this.diag(tx, day, 'MISSING_INSTRUMENT', 'Sell without instrument', 'error');
    const q = num(tx.quantity);
    if (!(q > 0)) return this.diag(tx, day, 'INVALID_QUANTITY', 'Sell quantity must be > 0', 'error');
    const inst = this.instrument(tx.instrumentId, tx);
    const net = this.gross(tx, inst) - fees - taxes;
    const k = this.convert(tx, day, tx.currency, inst.currency);
    const rate = this.txRate(tx, day);
    const { pieces, unmatched } = this.book(inst.id).remove(q);
    const matched = q - unmatched;
    // Only the matched part of an oversell is credited (no phantom cash).
    const netMatched = net * (matched / q);
    this.credit(tx, tx.currency, netMatched);
    for (const p of pieces) {
      const share = p.exact / q;
      const proceeds = net * k * share;
      const proceedsBase = net * rate * share;
      this.pushRealized({
        day,
        instrumentId: inst.id,
        sellDate: tx.date,
        openDate: dayToIso(p.openDay),
        quantity: p.quantity,
        proceeds,
        cost: p.cost,
        gain: proceeds - p.cost,
        proceedsBase,
        costBase: p.costBase,
        gainBase: proceedsBase - p.costBase,
        holdingDays: day - p.openDay,
      });
    }
    if (unmatched > QTY_EPS) {
      this.diag(tx, day, 'OVERSELL', `Sold ${q} ${inst.id} but only ${roundQty(matched)} held; only the held part was booked`, 'error');
    }
    this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, -matched, tx, day);
    const pf = this.positionFlow(inst.id, day);
    pf.outBase += netMatched * this.X(tx.currency, day, this.hintFor(tx.currency));
    this.recordCosts(tx, day, fees * (matched / q), taxes * (matched / q));
    if (this.ctx.options.sellProceeds === 'withdraw' && netMatched > 0) {
      this.addFlow(tx, day, tx.currency, -netMatched, 'IMPLICIT_WITHDRAWAL');
      this.debit(tx, day, tx.currency, netMatched, { implicit: false });
    }
  }

  private split(tx: Transaction, day: number): void {
    if (!tx.instrumentId) return this.diag(tx, day, 'MISSING_INSTRUMENT', 'Split without instrument', 'error');
    const inst = this.instrument(tx.instrumentId, tx);
    const sub = tx.subtype;
    if (sub === 'SPINOFF' || sub === 'MERGER' || sub === 'TICKER_CHANGE') return this.restructure(tx, day, inst);
    const r = num(tx.ratio);
    if (!(r > 0)) return this.diag(tx, day, 'INVALID_RATIO', 'Split ratio must be > 0', 'error');
    const b = this.book(inst.id);
    b.scale(r);
    this.scaleAccountQty(inst.id, r);
    // Cash in lieu of the fractional share (reverse splits): sell the fraction for `amount`.
    const cil = num(tx.amount);
    if (cil > 0) {
      const q = b.lots.reduce((acc, l) => acc + l.quantity, 0); // exact, not the rounded display quantity
      const frac = q - Math.floor(q + 1e-9);
      if (frac > QTY_EPS) {
        const k = this.convert(tx, day, tx.currency, inst.currency);
        const rate = this.txRate(tx, day);
        const { pieces } = b.remove(frac);
        for (const p of pieces) {
          const share = p.exact / frac;
          this.pushRealized({
            day,
            instrumentId: inst.id,
            sellDate: tx.date,
            openDate: dayToIso(p.openDay),
            quantity: p.quantity,
            proceeds: cil * k * share,
            cost: p.cost,
            gain: cil * k * share - p.cost,
            proceedsBase: cil * rate * share,
            costBase: p.costBase,
            gainBase: cil * rate * share - p.costBase,
            holdingDays: day - p.openDay,
          });
        }
        this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, -frac);
        this.credit(tx, tx.currency, cil);
        this.positionFlow(inst.id, day).outBase += cil * this.X(tx.currency, day, this.hintFor(tx.currency));
      }
    }
  }

  /**
   * Spin-off, merger, ticker change: move lots / cost between instruments at the start of the
   * ex-date. Merger cash ("boot", C28) is a partial disposal of the PARENT: a fraction
   * f = cash / (cash + value of the new shares) of each parent lot's cost is realized against
   * the cash (fallback without a target price: f = cash / parent cost); the rest of the cost
   * moves to the target. Position flows are start-of-day (value handed from parent to target).
   */
  private restructure(tx: Transaction, day: number, parent: Instrument): void {
    const targetId = tx.targetInstrumentId;
    if (!targetId) return this.diag(tx, day, 'MISSING_TARGET', `${tx.subtype} requires targetInstrumentId`, 'error');
    const target = this.instrument(targetId, tx);
    const r = tx.ratio && tx.ratio > 0 ? tx.ratio : 1;
    const pb = this.book(parent.id);
    const tb = this.book(target.id);
    const valueOf = (inst: Instrument, qty: number, fallback: number): number => {
      const p = this.marketPrice(inst, day);
      return p !== undefined ? ((qty * p) / mult(inst)) * this.X(inst.currency, day) : fallback;
    };
    const parentQty = pb.lots.reduce((acc, l) => acc + l.quantity, 0);
    if (!(parentQty > QTY_EPS)) {
      // C55: nothing to hand over (e.g. the parent was already consumed by another action that day)
      this.diag(tx, day, 'CORPORATE_ACTION_WITHOUT_POSITION', `${tx.subtype} of ${parent.id} into ${targetId}: no units of ${parent.id} are held, so no ${targetId} is received; check the order and dates of the corporate actions`, 'warning', { instrumentId: parent.id, targetInstrumentId: targetId });
      return;
    }
    const cashPart = tx.subtype !== 'SPINOFF' ? num(tx.amount) : 0;
    // C38: a merger / ticker change hands over the parent at ITS OWN last close (cash included);
    // any difference to the target's price is the target's return from then on.
    const parentPrice = tx.subtype !== 'SPINOFF' ? this.marketPrice(parent, day) : undefined;
    const parentValue = parentPrice !== undefined ? ((parentQty * parentPrice) / mult(parent)) * this.X(parent.currency, day) : undefined;
    const cashBase = cashPart * this.X(tx.currency, day, this.hintFor(tx.currency));
    if (cashPart > 0 && parentQty > 0) {
      const k = this.convert(tx, day, tx.currency, parent.currency);
      const rate = this.txRate(tx, day);
      const pT = this.marketPrice(target, day);
      const sharesValueTx = pT !== undefined ? ((parentQty * r * pT) / mult(target)) * this.convert(tx, day, target.currency, tx.currency) : undefined;
      const f =
        sharesValueTx !== undefined && cashPart + sharesValueTx > 0
          ? cashPart / (cashPart + sharesValueTx)
          : pb.costBasis > 0
            ? Math.min(1, (cashPart * k) / pb.costBasis)
            : 0;
      const carved = pb.carveOutCost(f);
      for (const l of carved) {
        const share = l.quantity / parentQty;
        const proceeds = cashPart * k * share;
        const proceedsBase = cashPart * rate * share;
        const cost = l.quantity * l.unitCost;
        const costBase = l.quantity * l.unitCostBase;
        this.pushRealized({ day, instrumentId: parent.id, sellDate: tx.date, openDate: dayToIso(l.openDay), quantity: 0, proceeds, cost, gain: proceeds - cost, proceedsBase, costBase, gainBase: proceedsBase - costBase, holdingDays: day - l.openDay });
      }
      this.credit(tx, tx.currency, cashPart);
      if (tx.cashPayDate && isStrictIsoDate(tx.cashPayDate) && isoToDay(tx.cashPayDate) > day) {
        this.receivables.push({ currency: tx.currency, amount: cashPart, payDay: isoToDay(tx.cashPayDate), account: this.cashAcct(tx) });
        this.diag(tx, day, 'MERGER_CASH_PENDING', `Merger cash of ${cashPart} ${tx.currency} for ${parent.id} is paid on ${tx.cashPayDate}; until then it is a receivable (counted in the value, not available to fund trades)`, 'info', { instrumentId: parent.id, amount: cashPart, currency: tx.currency, payDate: tx.cashPayDate });
      }
      this.positionFlow(parent.id, day).startOutBase += cashPart * this.X(tx.currency, day, this.hintFor(tx.currency));
      this.pf = undefined;
    }
    let moved: LotState[];
    if (tx.subtype === 'SPINOFF') {
      let cf = tx.costFraction;
      if (!(cf !== undefined && cf >= 0 && cf <= 1)) {
        // C55: no cost fraction given: split the cost by market value (target / parent before)
        const pp = this.marketPrice(parent, day);
        const pt = this.marketPrice(target, day);
        const vp = pp !== undefined ? ((parentQty * pp) / mult(parent)) * this.X(parent.currency, day) : undefined;
        const vt = pt !== undefined ? ((parentQty * r * pt) / mult(target)) * this.X(target.currency, day) : undefined;
        cf = vp !== undefined && vt !== undefined && vp > 0 ? Math.min(1, vt / vp) : 0;
        this.diag(tx, day, 'COST_FRACTION_ESTIMATED', `SPINOFF of ${parent.id} into ${targetId} without costFraction: ${(cf * 100).toFixed(1)} % of the cost assigned to ${targetId} by market value; record the official split of the cost to override`, 'info', { instrumentId: parent.id, targetInstrumentId: targetId, costFraction: cf });
      }
      moved = pb.carveOutCost(cf);
    } else moved = pb.extractAll();
    const scaled = moved.map((l) => ({ ...l, quantity: l.quantity * r, unitCost: l.unitCost / r, unitCostBase: l.unitCostBase / r, unitValue: l.unitValue / r }));
    const qty = scaled.reduce((acc, l) => acc + l.quantity, 0);
    const costBase = scaled.reduce((acc, l) => acc + l.quantity * l.unitCostBase, 0);
    tb.insert(scaled);
    const acc = this.accountQty.get(parent.id);
    if (acc) for (const [a, v] of acc) this.moveAccountQty(target.id, a, v * r);
    if (tx.subtype !== 'SPINOFF' && acc) for (const a of acc.keys()) acc.set(a, 0);
    // Position flows: value leaves the parent and enters the target at the start of the day.
    const v = parentValue !== undefined ? Math.max(0, parentValue - cashBase) : valueOf(target, qty, costBase);
    this.positionFlow(parent.id, day).startOutBase += v;
    this.pf = undefined;
    this.positionFlow(target.id, day).startInBase += v;
    this.pf = undefined;
  }

  private stockDividend(tx: Transaction, day: number): void {
    if (!tx.instrumentId) return this.diag(tx, day, 'MISSING_INSTRUMENT', 'Stock dividend without instrument', 'error');
    const inst = this.instrument(tx.instrumentId, tx);
    const b = this.book(inst.id);
    const held = b.quantity;
    // Optional attributed cost (e.g. Brazilian bonificação "custo atribuído").
    const attributed = tx.amount !== undefined ? num(tx.amount) : tx.price && tx.quantity ? num(tx.price) * num(tx.quantity) : 0;
    const k = this.convert(tx, day, tx.currency, inst.currency);
    const rate = this.txRate(tx, day);
    const before = b.costBasisBase;
    let factor: number | undefined;
    if (tx.quantity && tx.quantity > 0) {
      if (held <= 0) {
        b.add(day, tx.quantity, attributed * k, attributed * rate, 0);
        this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, tx.quantity);
        this.bk.corporate += b.costBasisBase - before;
        return;
      }
      factor = (held + tx.quantity) / held;
    } else if (tx.ratio && tx.ratio > 0) {
      factor = 1 + tx.ratio; // ratio = new shares received per share held
    }
    if (factor === undefined) return this.diag(tx, day, 'INVALID_RATIO', 'Stock dividend needs quantity or ratio > 0', 'error');
    b.scale(factor, attributed * k, attributed * rate);
    this.scaleAccountQty(inst.id, factor);
    this.bk.corporate += b.costBasisBase - before;
  }

  private income_(tx: Transaction, day: number, fees: number, taxes: number): void {
    let gross = num(tx.amount);
    const held = tx.instrumentId ? (this.peek(tx.instrumentId)?.quantity ?? 0) : 0;
    if (tx.amount === undefined) {
      if (tx.quantity && tx.price) gross = tx.quantity * tx.price;
      else if (tx.price && tx.instrumentId) gross = held * tx.price;
    }
    let plan: CouponPlan | undefined;
    let inst: Instrument | undefined;
    if (tx.instrumentId) {
      inst = this.instrument(tx.instrumentId, tx);
      if (held <= 0) this.diag(tx, day, 'INCOME_WITHOUT_POSITION', `${tx.type} for ${tx.instrumentId} while no units are held`, 'warning');
      if (inst.accrual && held > 0 && gross > 0) plan = this.couponPlan(tx, inst, day, gross);
    }
    let inferred = false;
    if (plan && inst && tx.type === 'INTEREST' && tx.taxes === undefined) {
      const g = this.inferGross(tx, inst, day, gross, plan);
      if (g !== undefined) {
        taxes = g - gross;
        gross = g;
        inferred = true;
      }
    }
    const net = gross - taxes - fees;
    if (net >= 0) this.credit(tx, tx.currency, net);
    else this.debit(tx, day, tx.currency, -net);
    const rate = this.txRate(tx, day);
    const ev: InternalIncome = {
      day,
      date: tx.date,
      instrumentId: tx.instrumentId,
      type: tx.type === 'INTEREST' ? 'INTEREST' : 'DIVIDEND',
      gross,
      taxes,
      net,
      currency: tx.currency,
      netBase: net * rate,
    };
    if (tx.subtype) ev.subtype = tx.subtype;
    if (inferred) ev.taxesEstimated = true;
    this.income.push(ev);
    this.bk.income += net * rate;
    if (tx.instrumentId) {
      const pf = this.positionFlow(tx.instrumentId, day);
      const nb = net * this.X(tx.currency, day, this.hintFor(tx.currency));
      pf.endOutBase += nb;
      pf.incomeBase += nb;
      if (plan && inst) this.payCoupon(tx, inst, day, gross, plan, tx.taxes === undefined && !inferred);
    }
    this.recordCosts(tx, day, fees, taxes);
  }

  /**
   * Who a coupon belongs to (C42): the units held at the record date — `quantity` on the
   * transaction when given (the newest units are the ones bought after the record date). Else:
   * a lot bought in the 15 days before payment is entitled when its price was dirty (closer to the
   * older lots' value with accrued interest than to their value at the anchor), and units sold in
   * that window are added when that explains the amount better (sold ex-coupon). `p` is the
   * interest accrued per unit over the coupon period, from the entitled lot that accrued the
   * longest since its anchor.
   */
  private couponPlan(tx: Transaction, inst: Instrument, day: number, amountTx: number): CouponPlan | undefined {
    const b = this.peek(inst.id);
    if (!b || b.quantity <= 0) return undefined;
    const totalQ = b.lots.reduce((s, l) => s + l.quantity, 0);
    if (!(totalQ > 0)) return undefined;
    const conv = this.convert(tx, day, tx.currency, inst.currency);
    const coupon = amountTx * conv;
    const { values, principal, anchors } = accruedLotValues(this.ctx, inst, b.lots, day);
    // C49: for inflation-indexed instruments only the spread part is payable interest
    const capitalized = inst.accrual?.kind === 'indexed' && !!inst.accrual.index && !!this.ctx.market.index(inst.accrual.index)?.capitalized;
    const since = values.map((v, i) => {
      if (!capitalized) return Math.max(0, v - (principal[i] ?? v));
      const f = payableFactor(this.ctx, inst, anchors[i] as number, day) ?? 1;
      return f > 1 ? v * (1 - 1 / f) : 0;
    });
    const lots = b.lots;
    const ent = lots.map((l) => l.quantity);
    // per-unit interest of the lot that accrued the longest since its anchor
    const periodPerUnit = (): { p: number; pStart: number; ref: number } => {
      let p = 0;
      let pStart = day;
      let ref = -1;
      lots.forEach((l, i) => {
        if (!((ent[i] as number) > 0) || !(l.quantity > 0)) return;
        const per = (since[i] as number) / l.quantity;
        if (per > p) {
          p = per;
          pStart = anchors[i] as number;
          ref = i;
        }
      });
      return { p, pStart, ref };
    };
    let units: number;
    if (num(tx.quantity) > 0) {
      units = num(tx.quantity);
      if (units < totalQ - QTY_EPS) {
        // the newest units were bought after the record date
        let notEntitled = totalQ - units;
        const order = lots.map((_, i) => i).sort((x, y) => (lots[y] as LotState).openDay - (lots[x] as LotState).openDay);
        for (const i of order) {
          if (notEntitled <= 0) break;
          const take = Math.min(notEntitled, ent[i] as number);
          ent[i] = (ent[i] as number) - take;
          notEntitled -= take;
        }
      }
    } else {
      // Lots bought in the 15 days before payment: entitled when bought at a dirty price (closer
      // to the older lots' value with accrued interest than to their value at the anchor).
      const { ref } = periodPerUnit();
      const rl = ref >= 0 ? (lots[ref] as LotState) : undefined;
      let excluded = 0;
      if (rl) {
        const a0 = (principal[ref] as number) / rl.quantity;
        lots.forEach((l, i) => {
          if (i === ref || l.anchorDay !== undefined || l.openDay <= day - 15 || l.openDay <= (anchors[ref] as number)) return;
          const f = accrualFactor(this.ctx, inst, anchors[ref] as number, l.openDay) ?? 1;
          if (!(f > 1)) return;
          if (l.unitValue - a0 < ((f - 1) * a0) / 2) {
            excluded += l.quantity;
            ent[i] = 0;
          }
        });
      }
      const E = totalQ - excluded;
      units = E;
      // units sold between the record date and the payment (sold ex-coupon)
      const { p } = periodPerUnit();
      const cands = this.unitsBeforePayment(tx, inst.id, day, totalQ).map((c) => c - totalQ).filter((x) => x > QTY_EPS);
      if (cands.length && p > 0) {
        let err = Math.abs(Math.log(coupon / (E * p)));
        for (const extra of cands) {
          const e = Math.abs(Math.log(coupon / ((E + extra) * p)));
          if (e < err - 1e-6) {
            err = e;
            units = E + extra;
          }
        }
      }
      if (units !== totalQ) this.diag(tx, day, 'COUPON_RECORD_DATE_UNITS', `${tx.type} of ${amountTx} on ${inst.id} apportioned over the ${units} units held at the record date (${totalQ} held on the payment date)`, 'info');
    }
    const { p, pStart } = periodPerUnit();
    return { values, principal, since, ent, units, totalQ, p, pStart, conv };
  }

  /**
   * Coupon / periodic interest of an accrual instrument (C36): the payment leaves the accrued
   * value and each entitled lot is re-anchored at the payment day, so later accrual, the net value
   * and the redemption at maturity only include interest accrued since the last payment.
   * - Round 6 (C47/C43): a payment between 70 % and 98 % of the interest accrued over the period
   *   settles that interest: each lot drops by the full period interest. The shortfall is
   *   withholding or a day-count/rate convention of the issuer, never interest still owed, so no
   *   phantom accrued interest stays (INTEREST_BELOW_ACCRUED, info, when nothing explains it).
   * - C42: otherwise the reduction of each lot is its share of the coupon, limited to the interest
   *   it accrued (since its anchor, or over the coupon period: since the previous coupon, the issue
   *   date or at most a year, which covers interest bought with a dirty price); a coupon above that
   *   is income that leaves the principal intact (COUPON_EXCEEDS_ACCRUED_INTEREST).
   */
  private payCoupon(tx: Transaction, inst: Instrument, day: number, grossTx: number, plan: CouponPlan, unexplained: boolean): void {
    const b = this.peek(inst.id);
    if (!b || !(grossTx > 0)) return;
    const coupon = grossTx * plan.conv;
    const perUnit = coupon / plan.units;
    const E = plan.ent.reduce((s, x) => s + x, 0);
    const P = plan.p * E;
    const R = P > 1e-12 ? (perUnit * E) / P : Infinity;
    // within ±2 % the coupon itself is subtracted (as in rounds 4-5); a larger shortfall settles
    const settle = R >= 0.7 && R < 0.98;
    const spec = inst.accrual;
    const issue = spec?.issueDate && isStrictIsoDate(spec.issueDate) ? isoToDay(spec.issueDate) : -Infinity;
    const periodStart = Math.max(this.lastCoupon.get(inst.id) ?? -Infinity, issue, day - 366);
    const fPeriod = payableFactor(this.ctx, inst, periodStart, day) ?? 1;
    let excess = 0;
    b.lots.forEach((l, i) => {
      const e = plan.ent[i] ?? 0;
      if (!(e > 0)) return;
      const v = plan.values[i] ?? 0;
      const cap = Math.max(plan.since[i] ?? 0, fPeriod > 1 ? v * (1 - 1 / fPeriod) * (e / l.quantity) : 0);
      const want = perUnit * e;
      let cut: number;
      if (settle) cut = Math.min(plan.p * e, Math.max(cap, want));
      else if (want > cap * 1.02 + 1e-9 * Math.max(1, v)) {
        cut = cap;
        excess += want - cap;
      } else cut = want;
      l.unitValue = Math.max(0, v - cut) / l.quantity;
      l.anchorDay = day;
    });
    this.lastCoupon.set(inst.id, day);
    if (excess > 0) this.diag(tx, day, 'COUPON_EXCEEDS_ACCRUED_INTEREST', `${tx.type} of ${grossTx} on ${inst.id} exceeds the interest accrued by ${excess.toFixed(2)} ${inst.currency}; the excess is income and the principal is kept intact — check the amount`, 'warning');
    if (settle && unexplained) {
      this.diag(tx, day, 'INTEREST_BELOW_ACCRUED', `${tx.type} of ${grossTx} on ${inst.id} is ${(R * 100).toFixed(1)} % of the ${(P / plan.conv).toFixed(2)} accrued over the period; the difference is treated as withholding or the issuer's day-count convention, not as interest still owed. If the amount is net of withholding, set amountIsNet or taxes`, 'info');
    }
  }

  /**
   * C43/C47: gross of an interest recorded net of withholding (CO_RETENCION, BR_IR_REGRESSIVE,
   * IR by each lot's holding period), only when it is unambiguous:
   * - `amountIsNet: true` on the transaction: always inferred;
   * - automatically only when the expected withholding rate is at least 3x the spread between
   *   plausible day counts (ACT/365, ACT/360, 30/360; at least 1.5 %), so the amount is closer to
   *   the net than to the gross under every day count, and the amount is within 0.5 % of the
   *   expected net. A 4 % Colombian withholding never qualifies (INTEREST_POSSIBLY_NET, info).
   * The inferred withholding is marked `IncomeEvent.taxesEstimated` (not certified).
   */
  private inferGross(tx: Transaction, inst: Instrument, day: number, amount: number, plan: CouponPlan): number | undefined {
    if (tx.amountIsNet === false) return undefined;
    const regime = taxRegimeFor(inst, this.ctx.taxResidence);
    if (regime !== 'CO_RETENCION' && regime !== 'BR_IR_REGRESSIVE') return undefined;
    const b = this.peek(inst.id);
    if (!b) return undefined;
    const explicit = tx.amountIsNet === true;
    let I = 0;
    let T = 0;
    let E = 0;
    let wRate = 0;
    b.lots.forEach((l, i) => {
      const e = plan.ent[i] ?? 0;
      if (!(e > 0)) return;
      const rate = regime === 'CO_RETENCION' ? (inst.accrual?.withholdingRate ?? 0.04) : irRate(day - l.openDay);
      const a = plan.p * e;
      I += a;
      T += a * rate;
      E += e;
      wRate += e * rate;
    });
    let tau = I > 0 ? T / I : E > 0 ? wRate / E : 0;
    if (!(tau > 0 && tau < 1)) return undefined;
    if (!explicit) {
      if (!(I > 0)) return undefined;
      const net = ((I - T) / plan.conv);
      const d = day - plan.pStart;
      if (d <= 0) return undefined;
      const spread = Math.max(0.015, 365 / 360 - 1, Math.abs(days360(plan.pStart, day) / d - 1));
      const close = Math.abs(amount / net - 1) <= 0.005;
      if (tau < 3 * spread) {
        if (close) this.diag(tx, day, 'INTEREST_POSSIBLY_NET', `${tx.type} of ${amount} on ${inst.id} matches the accrued interest net of the expected withholding, but a different day count would also explain it as gross; recorded as gross. If it is net, set amountIsNet or taxes`, 'info');
        return undefined;
      }
      if (!close || Math.abs(amount - I / plan.conv) <= Math.abs(amount - net)) return undefined;
      tau = T / I;
    }
    const g = amount / (1 - tau);
    this.diag(tx, day, 'INTEREST_NET_ASSUMED', `${tx.type} of ${amount} on ${inst.id} ${explicit ? 'recorded as net (amountIsNet)' : 'matches the accrued interest net of the expected withholding'}; gross ${g.toFixed(2)} with an estimated ${(g - amount).toFixed(2)} withheld (taxesEstimated; add \`taxes\` from the certificate to override)`, 'info');
    return g;
  }

  /** Holdings of `id` before each quantity change in the 15 days before `day` (latest first). */
  private unitsBeforePayment(tx: Transaction, id: string, day: number, heldNow: number): number[] {
    const sorted = this.ctx.sorted;
    const cur = this.cursor - 1;
    const out = [heldNow];
    if (sorted[cur]?.tx !== tx) return out;
    let q = heldNow;
    for (let k = cur - 1; k >= 0; k--) {
      const s = sorted[k] as SortedTx;
      if (s.day < day - 15) break;
      if (s.tx.instrumentId !== id) continue;
      const t = s.tx.type;
      const n = num(s.tx.quantity);
      if (t === 'SELL' || t === 'TRANSFER_OUT') q += n;
      else if (t === 'BUY' || t === 'TRANSFER_IN') q -= n;
      else if (t === 'SPLIT' || t === 'STOCK_DIVIDEND') break;
      else continue;
      out.push(q);
    }
    return out;
  }

  private returnOfCapital(tx: Transaction, day: number, fees: number, taxes: number): void {
    if (!tx.instrumentId) return this.diag(tx, day, 'MISSING_INSTRUMENT', 'Return of capital without instrument', 'error');
    const inst = this.instrument(tx.instrumentId, tx);
    const b = this.book(inst.id);
    let amt = num(tx.amount);
    if (tx.amount === undefined && tx.price) amt = (tx.quantity ?? b.quantity) * tx.price;
    this.credit(tx, tx.currency, amt);
    const X = this.X(tx.currency, day, this.hintFor(tx.currency));
    this.positionFlow(inst.id, day).endOutBase += amt * X;
    const k = this.convert(tx, day, tx.currency, inst.currency);
    const rate = this.txRate(tx, day);
    const { excess, excessBase } = b.reduceCost(amt * k, amt * rate);
    if (excess > 1e-9 || excessBase > 1e-9) {
      this.pushRealized({ day, instrumentId: inst.id, sellDate: tx.date, openDate: tx.date, quantity: 0, proceeds: excess, cost: 0, gain: excess, proceedsBase: excessBase, costBase: 0, gainBase: excessBase, holdingDays: 0 });
    }
    this.standaloneCost(tx, day, tx.currency, fees + taxes);
    this.recordCosts(tx, day, fees, taxes);
  }

  private fxConversion(tx: Transaction, day: number, fees: number, taxes: number): void {
    const to = tx.toCurrency;
    if (!to) return this.diag(tx, day, 'MISSING_CURRENCY', 'FX conversion without target currency', 'error');
    const amt = num(tx.amount);
    const toAmt = tx.toAmount !== undefined ? num(tx.toAmount) : amt * this.convert(tx, day, tx.currency, to);
    const flowBefore = this.txFlow;
    const cashBefore = this.txCash;
    this.debit(tx, day, tx.currency, amt, { fx: false });
    this.credit(tx, to, toAmt);
    // Result vs market = cash moves at market minus any implicit deposit.
    const result = this.txCash - cashBefore - (this.txFlow - flowBefore);
    this.bk.fxConversion += result;
    this.bk.spread += -result;
    this.standaloneCost(tx, day, tx.currency, fees + taxes, { fx: false });
    this.recordCosts(tx, day, fees, taxes);
  }

  private transferIn(tx: Transaction, day: number, fees: number, taxes: number): void {
    if (!tx.instrumentId) {
      // Cash transferred in from another account: an external inflow.
      const amt = num(tx.amount);
      this.credit(tx, tx.currency, amt);
      this.addFlow(tx, day, tx.currency, amt, 'TRANSFER_IN');
      this.standaloneCost(tx, day, tx.currency, fees + taxes, { implicit: false });
      this.recordCosts(tx, day, fees, taxes);
      return;
    }
    const q = num(tx.quantity);
    if (!(q > 0)) return this.diag(tx, day, 'INVALID_QUANTITY', 'Transfer quantity must be > 0', 'error');
    const inst = this.instrument(tx.instrumentId, tx);
    const m = mult(inst);
    const mkt = this.marketPrice(inst, day);
    const marketValue = mkt !== undefined ? (q * mkt) / m : undefined; // instrument currency
    const b = this.book(inst.id);
    const k = this.convert(tx, day, tx.currency, inst.currency);
    let costInst: number;
    let costBase: number;
    let unitValue: number;
    if (tx.amount !== undefined || tx.price !== undefined) {
      const total = this.gross(tx, inst) + fees + taxes;
      costInst = total * k;
      costBase = total * this.txRate(tx, day);
      unitValue = this.unitValueOf(tx, inst, k);
    } else {
      const v = marketValue ?? 0;
      if (marketValue === undefined) this.diag(tx, day, 'MISSING_PRICE', `Transfer in of ${inst.id} without price`, 'warning');
      costInst = v + (fees + taxes) * k;
      costBase = v * this.txRate(tx, day, inst.currency) + (fees + taxes) * this.txRate(tx, day);
      unitValue = v / q;
    }
    b.add(day, q, costInst, costBase, unitValue);
    this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, q, tx, day);
    // The flow is the market value brought in (falls back to cost without fees).
    const flowValue = marketValue ?? costInst - (fees + taxes) * k;
    const flowBefore = this.txFlow;
    this.addFlow(tx, day, inst.currency, flowValue, 'TRANSFER_IN');
    const flowBase = this.txFlow - flowBefore;
    const feesNet = this.standaloneCost(tx, day, tx.currency, fees + taxes);
    this.bk.transfer += costBase - flowBase;
    const pf = this.positionFlow(inst.id, day);
    pf.inBase += flowBase - feesNet;
    this.recordCosts(tx, day, fees, taxes);
  }

  private transferOut(tx: Transaction, day: number, fees: number, taxes: number): void {
    if (!tx.instrumentId) {
      const amt = num(tx.amount);
      this.addFlow(tx, day, tx.currency, -amt, 'TRANSFER_OUT');
      this.debit(tx, day, tx.currency, amt, { fx: false });
      this.standaloneCost(tx, day, tx.currency, fees + taxes, { fx: false });
      this.recordCosts(tx, day, fees, taxes);
      return;
    }
    const q = num(tx.quantity);
    if (!(q > 0)) return this.diag(tx, day, 'INVALID_QUANTITY', 'Transfer quantity must be > 0', 'error');
    const inst = this.instrument(tx.instrumentId, tx);
    const m = mult(inst);
    const { pieces, unmatched } = this.book(inst.id).remove(q);
    if (unmatched > QTY_EPS) this.diag(tx, day, 'OVERSELL', `Transferred out ${q} ${inst.id} but only ${roundQty(q - unmatched)} held`, 'error');
    const moved = q - unmatched;
    this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, -moved, tx, day);
    const mkt = this.marketPrice(inst, day) ?? (tx.price !== undefined ? num(tx.price) * this.convert(tx, day, tx.currency, inst.currency) : undefined);
    const value = mkt !== undefined ? (moved * mkt) / m : pieces.reduce((s, p) => s + p.cost, 0);
    const removedCostBase = pieces.reduce((s, p) => s + p.costBase, 0);
    const flowBefore = this.txFlow;
    this.addFlow(tx, day, inst.currency, -value, 'TRANSFER_OUT');
    const flowBase = this.txFlow - flowBefore; // negative
    const feesNet = this.standaloneCost(tx, day, tx.currency, fees + taxes);
    this.bk.transfer += -flowBase - removedCostBase;
    this.positionFlow(inst.id, day).outBase += -flowBase + feesNet;
    this.recordCosts(tx, day, fees, taxes);
  }

  /** Automatic redemption of an accrual instrument at maturity, at its accrued value. */
  private redeemAtMaturity(id: string, day: number): void {
    const all = this.books.get(id);
    if (!all) return;
    // isolatePortfolioCash: each portfolio's lots are redeemed into that portfolio's cash.
    if (all instanceof PortfolioBooks) {
      for (const [pid, part] of all.parts) if (part.quantity > 0) this.redeemPart(id, day, part, pid);
    } else this.redeemPart(id, day, all as LotBook, '');
  }

  private redeemPart(id: string, day: number, b: LotBook, portfolioId: string): void {
    const inst = this.instrumentOf.get(id) ?? this.ctx.instruments.get(id);
    if (!inst || b.quantity <= 0) return;
    this.curPid = portfolioId;
    const acct = Array.from(this.accountQty.get(id)?.entries() ?? []).find(([, v]) => v > QTY_EPS)?.[0] ?? NO_ACCOUNT;
    const tx: Transaction = {
      id: `maturity:${id}:${dayToIso(day)}${portfolioId ? `:${portfolioId}` : ''}`,
      portfolioId,
      date: dayToIso(day),
      type: 'SELL',
      instrumentId: id,
      currency: inst.currency,
      account: acct,
      quantity: b.quantity,
      source: 'engine:maturity',
    };
    this.curTx = tx;
    this.curDay = day;
    this.txCash = 0;
    this.txFlow = 0;
    this.bk = emptyBuckets();
    this.pf = undefined;
    const cbBefore = b.costBasisBase;
    const { values } = accruedLotValues(this.ctx, inst, b.lots, day);
    const X = this.X(inst.currency, day);
    const regime = taxRegimeFor(inst, this.ctx.taxResidence);
    const mat = this.ctx.maturities.find((m) => m.instrumentId === id && m.day === day);
    if (mat && b.lots.some((l) => (l.anchorDay ?? -Infinity) >= mat.maturityDay)) {
      this.diag(tx, day, 'INTEREST_ALREADY_RECORDED', `Interest of ${id} was recorded at maturity; the automatic redemption pays the principal plus interest accrued after it only`, 'info');
    }
    let total = 0;
    let taxes = 0;
    b.lots.forEach((l, i) => {
      const gross = values[i] ?? 0;
      // Estimated withholding on the yield (C24/C31): IR/IOF in Brazil, 4 % retención in Colombia.
      const tax = fixedIncomeTax(regime, day - l.openDay, gross - l.quantity * l.unitValue, inst.accrual).total;
      const v = gross - tax;
      total += v;
      taxes += tax;
      const r = {
        day,
        instrumentId: id,
        sellDate: tx.date,
        openDate: dayToIso(l.openDay),
        quantity: l.quantity,
        proceeds: v,
        cost: l.quantity * l.unitCost,
        gain: v - l.quantity * l.unitCost,
        proceedsBase: v * X,
        costBase: l.quantity * l.unitCostBase,
        gainBase: v * X - l.quantity * l.unitCostBase,
        holdingDays: day - l.openDay,
      };
      this.pushRealized(r);
      this.realized[this.realized.length - 1]!.estimated = true;
    });
    if (taxes > 0) this.costs.push({ day, instrumentId: id, feesBase: 0, taxesBase: taxes * X });
    b.extractAll();
    const acc = this.accountQty.get(id);
    if (acc) for (const a of acc.keys()) acc.set(a, 0);
    this.credit(tx, inst.currency, total);
    this.positionFlow(id, day).outBase += total * X;
    this.diag(tx, day, 'MATURITY_REDEEMED', `${id} redeemed automatically (estimated) for ${total.toFixed(2)} ${inst.currency}${taxes > 0 ? ` net of an estimated ${taxes.toFixed(2)} withholding` : ''}; record the real payment to replace it`, 'info');
    this.closeAttribution(day, id, b.costBasisBase - cbBefore);
    this.curTx = undefined;
    if (this.ctx.options.sellProceeds === 'withdraw' && total > 0) {
      // Keep consistency with sale proceeds handling.
      this.curTx = tx;
      this.txCash = 0;
      this.txFlow = 0;
      this.bk = emptyBuckets();
      this.addFlow(tx, day, inst.currency, -total, 'IMPLICIT_WITHDRAWAL');
      this.debit(tx, day, inst.currency, total, { implicit: false });
      this.closeAttribution(day, id, 0);
      this.curTx = undefined;
    }
  }
}

/** Run the whole ledger (all transactions). */
export function runLedger(ctx: EngineContext, untilDay = Infinity): Ledger {
  const l = new Ledger(ctx);
  l.applyUntil(untilDay);
  return l;
}
