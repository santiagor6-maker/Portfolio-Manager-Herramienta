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
  RealizedGain,
  Transaction,
  TransactionType,
} from './types';
import type { EngineInput, EngineOptions } from './api';
import { dayToIso, isStrictIsoDate, isoToDay } from './dates';
import { LotBook, type LotState, QTY_EPS, roundQty } from './lots';
import { type EngineMarket, toEngineMarket } from './market';
import { accruedLotValues, priceInfo } from './pricing';

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
export function sortTransactions(transactions: Transaction[]): SortedTx[] {
  return transactions
    .map((tx, index) => ({ tx, day: isStrictIsoDate(tx?.date) ? isoToDay(tx.date) : NaN, rank: TYPE_RANK[tx?.type] ?? 9, index }))
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
}

export interface Diagnostic {
  transactionId?: string;
  date: string;
  code: string;
  message: string;
  severity?: 'error' | 'warning' | 'info';
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
  /** Trade prints per instrument (instrument currency, last trade of each day). */
  observations: Map<string, { days: number[]; prices: number[] }>;
  /** First trade price per day per instrument (intra-day pre-flow valuation). */
  firstTradePrice: Map<number, Map<string, number>>;
  /** Maturity days of accrual instruments, ascending. */
  maturities: { day: number; instrumentId: string }[];
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
  const market = toEngineMarket(input.market);
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
    kept.push(tx);
  }
  const sorted = sortTransactions(kept);

  // Trade prints as price observations (BUY/SELL only; transfer prices are historical costs).
  const observations = new Map<string, { days: number[]; prices: number[] }>();
  const firstTradePrice = new Map<number, Map<string, number>>();
  if (options.tradePriceObservations) {
    for (const { tx, day } of sorted) {
      if ((tx.type !== 'BUY' && tx.type !== 'SELL') || !tx.instrumentId || !(num(tx.quantity) > 0)) continue;
      const inst = instruments.get(tx.instrumentId);
      let p = num(tx.price);
      if (!(p > 0) && num(tx.amount) > 0) p = (num(tx.amount) / num(tx.quantity)) * mult(inst);
      if (!(p > 0)) continue;
      const ccy = inst?.currency ?? tx.currency;
      if (tx.currency !== ccy) {
        const r = market.fxAt(tx.currency, ccy, day) ?? market.fxNearest(tx.currency, ccy, day);
        if (r === undefined) continue;
        p *= r;
      }
      let o = observations.get(tx.instrumentId);
      if (!o) observations.set(tx.instrumentId, (o = { days: [], prices: [] }));
      if (o.days[o.days.length - 1] === day) o.prices[o.prices.length - 1] = p;
      else {
        o.days.push(day);
        o.prices.push(p);
      }
      let m = firstTradePrice.get(day);
      if (!m) firstTradePrice.set(day, (m = new Map()));
      if (!m.has(tx.instrumentId)) m.set(tx.instrumentId, p);
    }
  }

  const maturities: EngineContext['maturities'] = [];
  if (options.autoRedeemAtMaturity) {
    const used = new Set(sorted.map((s) => s.tx.instrumentId).filter(Boolean) as string[]);
    for (const id of used) {
      const m = instruments.get(id)?.accrual?.maturity;
      if (m && isStrictIsoDate(m)) maturities.push({ day: isoToDay(m), instrumentId: id });
    }
    maturities.sort((a, b) => a.day - b.day);
  }

  return { base, portfolioBase: input.portfolio.baseCurrency, market, instruments, options, raw, sorted, rejected, observations, firstTradePrice, maturities };
}

const CASH_EPS = 1e-7;
const NO_ACCOUNT = '';

interface InternalRealized extends RealizedGain {
  day: number;
}
interface InternalIncome extends IncomeEvent {
  day: number;
}

type Buckets = Omit<Attribution, 'day' | 'instrumentId' | 'rateDiff' | 'cashBase'>;
const emptyBuckets = (): Buckets => ({ realized: 0, realizedFx: 0, income: 0, otherCosts: 0, fxConversion: 0, spread: 0, transfer: 0, corporate: 0 });

export class Ledger {
  readonly books = new Map<string, LotBook>();
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

  // ---- helpers --------------------------------------------------------------

  diag(tx: Transaction | undefined, day: number, code: string, message: string, severity: Diagnostic['severity'] = 'warning'): void {
    if (this.diagnostics.length < 5000) {
      this.diagnostics.push({ transactionId: tx?.id, date: Number.isFinite(day) ? dayToIso(day) : String(tx?.date ?? ''), code, message, severity });
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

  book(id: string): LotBook {
    let b = this.books.get(id);
    if (!b) this.books.set(id, (b = new LotBook(this.ctx.options.costMethod)));
    return b;
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
    if (amount !== 0) this.moveCash(ccy, tx.account ?? NO_ACCOUNT, amount);
  }

  /**
   * Debit cash. With implicit cash flows enabled, a shortfall (amount above the available
   * positive balance) is first covered by converting base-currency cash at the market rate
   * (implicitFx 'fromBaseCash', when the debit is in another currency), then by an implicit
   * external deposit.
   */
  private debit(tx: Transaction, day: number, ccy: CurrencyCode, amount: number, opts: { implicit?: boolean; fx?: boolean } = {}): void {
    if (amount === 0 || !Number.isFinite(amount)) return;
    const acct = tx.account ?? NO_ACCOUNT;
    const implicit = (opts.implicit ?? true) && this.ctx.options.implicitCashFlows;
    if (amount > 0 && implicit) {
      let shortfall = amount - Math.max(this.cash.get(ccy) ?? 0, 0);
      const pb = this.ctx.portfolioBase;
      if (shortfall > CASH_EPS && (opts.fx ?? true) && this.ctx.options.implicitFx === 'fromBaseCash' && ccy !== pb) {
        const avail = Math.max(this.cash.get(pb) ?? 0, 0);
        const r = this.ctx.market.fxAt(ccy, pb, day) ?? this.ctx.market.fxNearest(ccy, pb, day); // pb per ccy
        if (avail > CASH_EPS && r !== undefined && r > 0) {
          const usePb = Math.min(avail, shortfall * r);
          const got = usePb / r;
          const before = this.txCash;
          this.moveCash(pb, acct, -usePb);
          this.moveCash(ccy, acct, got);
          this.bk.fxConversion += this.txCash - before;
          shortfall -= got;
          this.diag(tx, day, 'IMPLICIT_FX_CONVERSION', `Converted ${usePb.toFixed(2)} ${pb} to ${got.toFixed(2)} ${ccy} at market rate to fund ${tx.type}`, 'info');
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
      this.pf = { day, instrumentId, inBase: 0, outBase: 0, endOutBase: 0, incomeBase: 0, feesBase: 0 };
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
      const share = p.quantity / q;
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
      const q = b.quantity;
      const frac = q - Math.floor(q + 1e-9);
      if (frac > QTY_EPS) {
        const k = this.convert(tx, day, tx.currency, inst.currency);
        const rate = this.txRate(tx, day);
        const { pieces } = b.remove(frac);
        for (const p of pieces) {
          const share = p.quantity / frac;
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

  /** Spin-off, merger, ticker change: move lots / cost between instruments. */
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
    let moved: LotState[];
    if (tx.subtype === 'SPINOFF') {
      const f = tx.costFraction ?? 0;
      moved = pb.carveOutCost(f);
    } else {
      moved = pb.extractAll();
    }
    const scaled = moved.map((l) => ({ ...l, quantity: l.quantity * r, unitCost: l.unitCost / r, unitCostBase: l.unitCostBase / r, unitValue: l.unitValue / r }));
    const qty = scaled.reduce((s, l) => s + l.quantity, 0);
    const costBase = scaled.reduce((s, l) => s + l.quantity * l.unitCostBase, 0);
    tb.insert(scaled);
    const acc = this.accountQty.get(parent.id);
    if (acc) for (const [a, v] of acc) this.moveAccountQty(target.id, a, v * r);
    if (tx.subtype !== 'SPINOFF' && acc) for (const a of acc.keys()) acc.set(a, 0);
    // Position flows: value leaves the parent and enters the target.
    const v = valueOf(target, qty, costBase);
    this.positionFlow(parent.id, day).outBase += v;
    this.pf = undefined;
    this.positionFlow(target.id, day).inBase += v;
    this.pf = undefined;
    // Cash component of a merger: treated as return of capital on the target.
    const cashPart = num(tx.amount);
    if (cashPart > 0 && tx.subtype !== 'SPINOFF') {
      this.credit(tx, tx.currency, cashPart);
      const k = this.convert(tx, day, tx.currency, target.currency);
      const { excess, excessBase } = tb.reduceCost(cashPart * k, cashPart * this.txRate(tx, day));
      if (excess > 1e-9 || excessBase > 1e-9) {
        this.pushRealized({ day, instrumentId: target.id, sellDate: tx.date, openDate: tx.date, quantity: 0, proceeds: excess, cost: 0, gain: excess, proceedsBase: excessBase, costBase: 0, gainBase: excessBase, holdingDays: 0 });
      }
      this.positionFlow(target.id, day).endOutBase += cashPart * this.X(tx.currency, day, this.hintFor(tx.currency));
    }
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
    const held = tx.instrumentId ? (this.books.get(tx.instrumentId)?.quantity ?? 0) : 0;
    if (tx.amount === undefined) {
      if (tx.quantity && tx.price) gross = tx.quantity * tx.price;
      else if (tx.price && tx.instrumentId) gross = held * tx.price;
    }
    if (tx.instrumentId) {
      this.instrument(tx.instrumentId, tx);
      if (held <= 0) this.diag(tx, day, 'INCOME_WITHOUT_POSITION', `${tx.type} for ${tx.instrumentId} while no units are held`, 'warning');
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
    this.income.push(ev);
    this.bk.income += net * rate;
    if (tx.instrumentId) {
      const pf = this.positionFlow(tx.instrumentId, day);
      const nb = net * this.X(tx.currency, day, this.hintFor(tx.currency));
      pf.endOutBase += nb;
      pf.incomeBase += nb;
    }
    this.recordCosts(tx, day, fees, taxes);
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
    const b = this.books.get(id);
    const inst = this.instrumentOf.get(id) ?? this.ctx.instruments.get(id);
    if (!b || !inst || b.quantity <= 0) return;
    const acct = Array.from(this.accountQty.get(id)?.entries() ?? []).find(([, v]) => v > QTY_EPS)?.[0] ?? NO_ACCOUNT;
    const tx: Transaction = {
      id: `maturity:${id}:${dayToIso(day)}`,
      portfolioId: '',
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
    let total = 0;
    b.lots.forEach((l, i) => {
      const v = values[i] ?? 0;
      total += v;
      this.pushRealized({
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
      });
    });
    b.extractAll();
    const acc = this.accountQty.get(id);
    if (acc) for (const a of acc.keys()) acc.set(a, 0);
    this.credit(tx, inst.currency, total);
    this.positionFlow(id, day).outBase += total * X;
    this.diag(tx, day, 'MATURITY_REDEEMED', `${id} redeemed at maturity for ${total.toFixed(2)} ${inst.currency}`, 'info');
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
