/**
 * Ledger: replays transactions chronologically and maintains lots, multi-currency cash,
 * external flows, realized gains, income and cost events.
 *
 * Intra-day order (stable by input order inside each rank):
 *   0 DEPOSIT, TRANSFER_IN  1 FX_CONVERSION  2 BUY  3 SPLIT, STOCK_DIVIDEND
 *   4 DIVIDEND, INTEREST, RETURN_OF_CAPITAL  5 SELL  6 FEE, TAX  7 TRANSFER_OUT, WITHDRAWAL
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
import { dayToIso, isoToDay } from './dates';
import { LotBook, QTY_EPS, roundQty } from './lots';
import { type EngineMarket, toEngineMarket } from './market';

export const TYPE_RANK: Record<TransactionType, number> = {
  DEPOSIT: 0,
  TRANSFER_IN: 0,
  FX_CONVERSION: 1,
  BUY: 2,
  SPLIT: 3,
  STOCK_DIVIDEND: 3,
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

/** Sort chronologically with the intra-day rank order; stable on input order. */
export function sortTransactions(transactions: Transaction[]): SortedTx[] {
  return transactions
    .map((tx, index) => ({ tx, day: isoToDay(tx.date), rank: TYPE_RANK[tx.type] ?? 9, index }))
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
}

export interface CostEvent {
  day: number;
  feesBase: number;
  taxesBase: number;
}

export interface Diagnostic {
  transactionId?: string;
  date: string;
  code: string;
  message: string;
}

export interface ResolvedOptions {
  implicitCashFlows: boolean;
  sellProceeds: 'cash' | 'withdraw';
  twrMethod: 'daily' | 'modifiedDietz';
  costMethod: CostMethod;
}

export interface EngineContext {
  base: CurrencyCode;
  portfolioBase: CurrencyCode;
  market: EngineMarket;
  instruments: Map<string, Instrument>;
  options: ResolvedOptions;
  sorted: SortedTx[];
}

export function resolveOptions(input: EngineInput, extra?: EngineOptions): ResolvedOptions {
  const o = { ...(input.options ?? {}), ...(extra ?? {}) };
  return {
    implicitCashFlows: o.implicitCashFlows ?? true,
    sellProceeds: o.sellProceeds ?? 'cash',
    twrMethod: o.twrMethod ?? 'daily',
    costMethod: o.costMethod ?? input.portfolio.costMethod ?? 'FIFO',
  };
}

export function createContext(input: EngineInput, extra?: EngineOptions): EngineContext {
  const instruments = new Map<string, Instrument>();
  for (const i of input.instruments ?? []) instruments.set(i.id, i);
  return {
    base: input.baseCurrency ?? input.portfolio.baseCurrency,
    portfolioBase: input.portfolio.baseCurrency,
    market: toEngineMarket(input.market),
    instruments,
    options: resolveOptions(input, extra),
    sorted: sortTransactions(input.transactions ?? []),
  };
}

const CASH_EPS = 1e-7;
const NO_ACCOUNT = '';

interface InternalRealized extends RealizedGain {
  day: number;
}
interface InternalIncome extends IncomeEvent {
  day: number;
}

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
  readonly diagnostics: Diagnostic[] = [];
  /** Index into ctx.sorted of the next transaction to process. */
  cursor = 0;
  /** Day of the last processed transaction (or -Infinity). */
  lastDay = -Infinity;

  constructor(readonly ctx: EngineContext) {}

  get done(): boolean {
    return this.cursor >= this.ctx.sorted.length;
  }

  /** Day of the next unprocessed transaction or +Infinity. */
  get nextDay(): number {
    const s = this.ctx.sorted[this.cursor];
    return s ? s.day : Infinity;
  }

  applyUntil(day: number): void {
    const sorted = this.ctx.sorted;
    while (this.cursor < sorted.length && (sorted[this.cursor] as SortedTx).day <= day) {
      const s = sorted[this.cursor++] as SortedTx;
      this.lastDay = s.day;
      this.apply(s.tx, s.day);
    }
  }

  applyAll(): void {
    this.applyUntil(Infinity);
  }

  // ---- helpers --------------------------------------------------------------

  private diag(tx: Transaction | undefined, day: number, code: string, message: string): void {
    if (this.diagnostics.length < 5000) this.diagnostics.push({ transactionId: tx?.id, date: dayToIso(day), code, message });
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
      this.diag(tx, tx ? isoToDay(tx.date) : 0, 'UNKNOWN_INSTRUMENT', `Instrument ${id} not found; using transaction currency`);
    }
    this.instrumentOf.set(id, inst);
    return inst;
  }

  private book(id: string): LotBook {
    let b = this.books.get(id);
    if (!b) this.books.set(id, (b = new LotBook(this.ctx.options.costMethod)));
    return b;
  }

  /** Units of base per unit of `ccy` for historical cost of a transaction. */
  txRate(tx: Transaction, day: number, ccy: CurrencyCode = tx.currency): number {
    const { base, portfolioBase, market } = this.ctx;
    if (ccy === base) return 1;
    if (ccy === tx.currency && base === portfolioBase && tx.fxRateToBase && tx.fxRateToBase > 0) return tx.fxRateToBase;
    const r = market.fxAt(ccy, base, day) ?? market.fxNearest(ccy, base, day);
    if (r === undefined) {
      this.diag(tx, day, 'MISSING_FX', `No FX ${ccy}/${base} for ${dayToIso(day)}`);
      return 0;
    }
    return r;
  }

  /** Units of `to` per unit of `from` at day, for converting a transaction amount. */
  private convert(tx: Transaction, day: number, from: CurrencyCode, to: CurrencyCode): number {
    if (from === to) return 1;
    const r = this.ctx.market.fxAt(from, to, day) ?? this.ctx.market.fxNearest(from, to, day);
    if (r === undefined) {
      this.diag(tx, day, 'MISSING_FX', `No FX ${from}/${to} for ${dayToIso(day)}; assuming 1`);
      return 1;
    }
    return r;
  }

  private flowRateHint(tx: Transaction, ccy: CurrencyCode): number | undefined {
    if (ccy === this.ctx.base) return 1;
    if (ccy === tx.currency && this.ctx.base === this.ctx.portfolioBase && tx.fxRateToBase && tx.fxRateToBase > 0) {
      return tx.fxRateToBase;
    }
    return undefined;
  }

  private addFlow(tx: Transaction, day: number, ccy: CurrencyCode, amount: number, kind: FlowKind): void {
    if (amount === 0 || !Number.isFinite(amount)) return;
    this.flows.push({ day, currency: ccy, amount, kind, transactionId: tx.id, rateHint: this.flowRateHint(tx, ccy) });
  }

  private moveCash(ccy: CurrencyCode, account: string, delta: number): void {
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
   * Debit cash. With implicit cash flows enabled, any shortfall (amount above the
   * available positive balance) is first booked as an implicit external deposit.
   */
  private debit(tx: Transaction, day: number, ccy: CurrencyCode, amount: number, allowImplicit = true): void {
    if (amount === 0 || !Number.isFinite(amount)) return;
    const acct = tx.account ?? NO_ACCOUNT;
    if (amount > 0 && allowImplicit && this.ctx.options.implicitCashFlows) {
      const bal = this.cash.get(ccy) ?? 0;
      const shortfall = amount - Math.max(bal, 0);
      if (shortfall > CASH_EPS) {
        this.moveCash(ccy, acct, shortfall);
        this.addFlow(tx, day, ccy, shortfall, 'IMPLICIT_DEPOSIT');
      }
    }
    this.moveCash(ccy, acct, -amount);
    const after = this.cash.get(ccy) ?? 0;
    if (after < -CASH_EPS) {
      this.diag(tx, day, 'NEGATIVE_CASH', `Cash ${ccy} negative (${after.toFixed(2)}) after ${tx.type}`);
    }
  }

  private recordCosts(tx: Transaction, day: number, fees: number, taxes: number, ccy: CurrencyCode = tx.currency): void {
    if (!fees && !taxes) return;
    const r = this.txRate(tx, day, ccy);
    this.costs.push({ day, feesBase: fees * r, taxesBase: taxes * r });
  }

  private moveAccountQty(instrumentId: string, account: string, delta: number): void {
    let m = this.accountQty.get(instrumentId);
    if (!m) this.accountQty.set(instrumentId, (m = new Map()));
    m.set(account, (m.get(account) ?? 0) + delta);
  }

  private scaleAccountQty(instrumentId: string, factor: number): void {
    const m = this.accountQty.get(instrumentId);
    if (!m) return;
    for (const [k, v] of m) m.set(k, v * factor);
  }

  /** Market price in instrument currency at day (series currency converted if needed). */
  marketPrice(inst: Instrument, day: number): number | undefined {
    const m = this.ctx.market;
    const p = m.priceAt(inst.id, day);
    if (p === undefined) return undefined;
    const pc = m.priceCurrency(inst.id);
    if (pc && pc !== inst.currency) {
      const r = m.fxAt(pc, inst.currency, day);
      return r === undefined ? undefined : p * r;
    }
    return p;
  }

  // ---- transaction processing ------------------------------------------------

  private apply(tx: Transaction, day: number): void {
    const fees = num(tx.fees);
    const taxes = num(tx.taxes);
    const ccy = tx.currency;
    switch (tx.type) {
      case 'DEPOSIT': {
        const amt = num(tx.amount);
        this.credit(tx, ccy, amt);
        this.addFlow(tx, day, ccy, amt, 'DEPOSIT');
        if (fees + taxes) this.debit(tx, day, ccy, fees + taxes, false);
        this.recordCosts(tx, day, fees, taxes);
        return;
      }
      case 'WITHDRAWAL': {
        const amt = num(tx.amount);
        this.debit(tx, day, ccy, amt + fees + taxes, false);
        this.addFlow(tx, day, ccy, -amt, 'WITHDRAWAL');
        this.recordCosts(tx, day, fees, taxes);
        return;
      }
      case 'BUY':
        return this.buy(tx, day, fees, taxes);
      case 'SELL':
        return this.sell(tx, day, fees, taxes);
      case 'SPLIT': {
        if (!tx.instrumentId) return this.diag(tx, day, 'MISSING_INSTRUMENT', 'Split without instrument');
        const r = num(tx.ratio);
        if (!(r > 0)) return this.diag(tx, day, 'INVALID_RATIO', 'Split ratio must be > 0');
        this.instrument(tx.instrumentId, tx);
        this.book(tx.instrumentId).scale(r);
        this.scaleAccountQty(tx.instrumentId, r);
        return;
      }
      case 'STOCK_DIVIDEND':
        return this.stockDividend(tx, day);
      case 'DIVIDEND':
      case 'INTEREST':
        return this.income_(tx, day, fees, taxes);
      case 'RETURN_OF_CAPITAL':
        return this.returnOfCapital(tx, day, fees, taxes);
      case 'FEE': {
        const amt = tx.amount !== undefined ? num(tx.amount) : fees;
        this.debit(tx, day, ccy, amt + taxes);
        this.recordCosts(tx, day, amt, taxes);
        return;
      }
      case 'TAX': {
        const amt = tx.amount !== undefined ? num(tx.amount) : taxes;
        if (amt >= 0) this.debit(tx, day, ccy, amt + fees);
        else {
          this.credit(tx, ccy, -amt);
          if (fees) this.debit(tx, day, ccy, fees);
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
        this.diag(tx, day, 'UNKNOWN_TYPE', `Unknown transaction type ${String((tx as Transaction).type)}`);
    }
  }

  private gross(tx: Transaction, inst: Instrument): number {
    if (tx.amount !== undefined && tx.amount !== null) return num(tx.amount);
    const mult = inst.priceMultiplier && inst.priceMultiplier > 0 ? inst.priceMultiplier : 1;
    return (num(tx.quantity) * num(tx.price)) / mult;
  }

  private buy(tx: Transaction, day: number, fees: number, taxes: number): void {
    if (!tx.instrumentId) return this.diag(tx, day, 'MISSING_INSTRUMENT', 'Buy without instrument');
    const q = num(tx.quantity);
    if (!(q > 0)) return this.diag(tx, day, 'INVALID_QUANTITY', 'Buy quantity must be > 0');
    const inst = this.instrument(tx.instrumentId, tx);
    const total = this.gross(tx, inst) + fees + taxes; // fees and transaction taxes are capitalized
    this.debit(tx, day, tx.currency, total);
    const k = this.convert(tx, day, tx.currency, inst.currency);
    this.book(inst.id).add(day, q, total * k, total * this.txRate(tx, day));
    this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, q);
    this.recordCosts(tx, day, fees, taxes);
  }

  private sell(tx: Transaction, day: number, fees: number, taxes: number): void {
    if (!tx.instrumentId) return this.diag(tx, day, 'MISSING_INSTRUMENT', 'Sell without instrument');
    const q = num(tx.quantity);
    if (!(q > 0)) return this.diag(tx, day, 'INVALID_QUANTITY', 'Sell quantity must be > 0');
    const inst = this.instrument(tx.instrumentId, tx);
    const net = this.gross(tx, inst) - fees - taxes;
    this.credit(tx, tx.currency, net);
    const k = this.convert(tx, day, tx.currency, inst.currency);
    const rate = this.txRate(tx, day);
    const { pieces, unmatched } = this.book(inst.id).remove(q);
    for (const p of pieces) {
      const share = p.quantity / q;
      const proceeds = net * k * share;
      const proceedsBase = net * rate * share;
      this.realized.push({
        day,
        instrumentId: inst.id,
        sellDate: tx.date.slice(0, 10),
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
      this.diag(tx, day, 'OVERSELL', `Sold ${q} ${inst.id} but only ${roundQty(q - unmatched)} held`);
    }
    this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, -(q - unmatched));
    this.recordCosts(tx, day, fees, taxes);
    if (this.ctx.options.sellProceeds === 'withdraw' && net > 0) {
      this.debit(tx, day, tx.currency, net, false);
      this.addFlow(tx, day, tx.currency, -net, 'IMPLICIT_WITHDRAWAL');
    }
  }

  private stockDividend(tx: Transaction, day: number): void {
    if (!tx.instrumentId) return this.diag(tx, day, 'MISSING_INSTRUMENT', 'Stock dividend without instrument');
    const inst = this.instrument(tx.instrumentId, tx);
    const b = this.book(inst.id);
    const held = b.quantity;
    // Optional attributed cost (e.g. Brazilian bonificação "custo atribuído").
    const attributed = tx.amount !== undefined ? num(tx.amount) : tx.price && tx.quantity ? num(tx.price) * num(tx.quantity) : 0;
    const k = this.convert(tx, day, tx.currency, inst.currency);
    const rate = this.txRate(tx, day);
    let factor: number | undefined;
    if (tx.quantity && tx.quantity > 0) {
      if (held <= 0) {
        b.add(day, tx.quantity, attributed * k, attributed * rate);
        this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, tx.quantity);
        return;
      }
      factor = (held + tx.quantity) / held;
    } else if (tx.ratio && tx.ratio > 0) {
      factor = 1 + tx.ratio; // ratio = new shares received per share held
    }
    if (factor === undefined) return this.diag(tx, day, 'INVALID_RATIO', 'Stock dividend needs quantity or ratio > 0');
    b.scale(factor, attributed * k, attributed * rate);
    this.scaleAccountQty(inst.id, factor);
  }

  private income_(tx: Transaction, day: number, fees: number, taxes: number): void {
    let gross = num(tx.amount);
    if (tx.amount === undefined) {
      if (tx.quantity && tx.price) gross = tx.quantity * tx.price;
      else if (tx.price && tx.instrumentId) gross = (this.books.get(tx.instrumentId)?.quantity ?? 0) * tx.price;
    }
    if (tx.instrumentId) this.instrument(tx.instrumentId, tx);
    const net = gross - taxes - fees;
    if (net >= 0) this.credit(tx, tx.currency, net);
    else this.debit(tx, day, tx.currency, -net);
    const rate = this.txRate(tx, day);
    this.income.push({
      day,
      date: tx.date.slice(0, 10),
      instrumentId: tx.instrumentId,
      type: tx.type === 'INTEREST' ? 'INTEREST' : 'DIVIDEND',
      gross,
      taxes,
      net,
      currency: tx.currency,
      netBase: net * rate,
    });
    this.recordCosts(tx, day, fees, taxes);
  }

  private returnOfCapital(tx: Transaction, day: number, fees: number, taxes: number): void {
    if (!tx.instrumentId) return this.diag(tx, day, 'MISSING_INSTRUMENT', 'Return of capital without instrument');
    const inst = this.instrument(tx.instrumentId, tx);
    const b = this.book(inst.id);
    let amt = num(tx.amount);
    if (tx.amount === undefined && tx.price) amt = (tx.quantity ?? b.quantity) * tx.price;
    this.credit(tx, tx.currency, amt - fees - taxes);
    const k = this.convert(tx, day, tx.currency, inst.currency);
    const rate = this.txRate(tx, day);
    const { excess, excessBase } = b.reduceCost(amt * k, amt * rate);
    if (excess > 1e-9 || excessBase > 1e-9) {
      this.realized.push({
        day,
        instrumentId: inst.id,
        sellDate: tx.date.slice(0, 10),
        openDate: tx.date.slice(0, 10),
        quantity: 0,
        proceeds: excess,
        cost: 0,
        gain: excess,
        proceedsBase: excessBase,
        costBase: 0,
        gainBase: excessBase,
        holdingDays: 0,
      });
    }
    this.recordCosts(tx, day, fees, taxes);
  }

  private fxConversion(tx: Transaction, day: number, fees: number, taxes: number): void {
    const to = tx.toCurrency;
    if (!to) return this.diag(tx, day, 'MISSING_CURRENCY', 'FX conversion without target currency');
    const amt = num(tx.amount);
    const toAmt = tx.toAmount !== undefined ? num(tx.toAmount) : amt * this.convert(tx, day, tx.currency, to);
    this.debit(tx, day, tx.currency, amt + fees + taxes);
    this.credit(tx, to, toAmt);
    this.recordCosts(tx, day, fees, taxes);
  }

  private transferIn(tx: Transaction, day: number, fees: number, taxes: number): void {
    if (!tx.instrumentId) {
      // Cash transferred in from another account: an external inflow.
      const amt = num(tx.amount);
      this.credit(tx, tx.currency, amt);
      this.addFlow(tx, day, tx.currency, amt, 'TRANSFER_IN');
      if (fees + taxes) this.debit(tx, day, tx.currency, fees + taxes, false);
      this.recordCosts(tx, day, fees, taxes);
      return;
    }
    const q = num(tx.quantity);
    if (!(q > 0)) return this.diag(tx, day, 'INVALID_QUANTITY', 'Transfer quantity must be > 0');
    const inst = this.instrument(tx.instrumentId, tx);
    const mult = inst.priceMultiplier && inst.priceMultiplier > 0 ? inst.priceMultiplier : 1;
    const mkt = this.marketPrice(inst, day);
    const marketValue = mkt !== undefined ? (q * mkt) / mult : undefined; // instrument currency
    const b = this.book(inst.id);
    let costInst: number;
    let costBase: number;
    if (tx.amount !== undefined || tx.price !== undefined) {
      const total = this.gross(tx, inst) + fees + taxes;
      costInst = total * this.convert(tx, day, tx.currency, inst.currency);
      costBase = total * this.txRate(tx, day);
    } else {
      const v = marketValue ?? 0;
      if (marketValue === undefined) this.diag(tx, day, 'MISSING_PRICE', `Transfer in of ${inst.id} without price`);
      const feesInst = (fees + taxes) * this.convert(tx, day, tx.currency, inst.currency);
      costInst = v + feesInst;
      costBase = v * this.txRate(tx, day, inst.currency) + (fees + taxes) * this.txRate(tx, day);
    }
    b.add(day, q, costInst, costBase);
    this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, q);
    if (fees + taxes) this.debit(tx, day, tx.currency, fees + taxes);
    this.recordCosts(tx, day, fees, taxes);
    // The flow is the market value brought in (falls back to cost without fees).
    const flowValue = marketValue ?? costInst - (fees + taxes) * this.convert(tx, day, tx.currency, inst.currency);
    this.addFlow(tx, day, inst.currency, flowValue, 'TRANSFER_IN');
  }

  private transferOut(tx: Transaction, day: number, fees: number, taxes: number): void {
    if (!tx.instrumentId) {
      const amt = num(tx.amount);
      this.debit(tx, day, tx.currency, amt + fees + taxes, false);
      this.addFlow(tx, day, tx.currency, -amt, 'TRANSFER_OUT');
      this.recordCosts(tx, day, fees, taxes);
      return;
    }
    const q = num(tx.quantity);
    if (!(q > 0)) return this.diag(tx, day, 'INVALID_QUANTITY', 'Transfer quantity must be > 0');
    const inst = this.instrument(tx.instrumentId, tx);
    const mult = inst.priceMultiplier && inst.priceMultiplier > 0 ? inst.priceMultiplier : 1;
    const { pieces, unmatched } = this.book(inst.id).remove(q);
    if (unmatched > QTY_EPS) this.diag(tx, day, 'OVERSELL', `Transferred out ${q} ${inst.id} but only ${roundQty(q - unmatched)} held`);
    const moved = q - unmatched;
    this.moveAccountQty(inst.id, tx.account ?? NO_ACCOUNT, -moved);
    const mkt = this.marketPrice(inst, day) ?? (tx.price !== undefined ? num(tx.price) * this.convert(tx, day, tx.currency, inst.currency) : undefined);
    const value = mkt !== undefined ? (moved * mkt) / mult : pieces.reduce((s, p) => s + p.cost, 0);
    if (fees + taxes) this.debit(tx, day, tx.currency, fees + taxes);
    this.recordCosts(tx, day, fees, taxes);
    this.addFlow(tx, day, inst.currency, -value, 'TRANSFER_OUT');
  }
}

function num(v: number | undefined | null): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Run the whole ledger (all transactions). */
export function runLedger(ctx: EngineContext, untilDay = Infinity): Ledger {
  const l = new Ledger(ctx);
  l.applyUntil(untilDay);
  return l;
}
