/**
 * Public engine API (signatures are the contract the web app codes against).
 * Implementations live in the sibling modules (market, ledger, lots, valuation,
 * performance, risk, allocation, xirr, validate); this file is the stable facade.
 * See packages/core/README.md for the methodology.
 */
import type {
  AllocationDimension,
  AllocationSlice,
  CashBalance,
  CorporateAction,
  CostMethod,
  CurrencyCode,
  FxSeries,
  Holding,
  IncomeEvent,
  IndexId,
  IndexSeries,
  Instrument,
  ISODate,
  MarketData,
  MonthlyRow,
  PerformanceSummary,
  Portfolio,
  PriceSeries,
  RealizedGain,
  RiskMetrics,
  Transaction,
  Valuation,
  YearMonth,
} from './types';

export interface EngineInput {
  portfolio: Portfolio;
  transactions: Transaction[];
  instruments: Instrument[];
  market: MarketData;
  /** Reporting currency; defaults to portfolio.baseCurrency. */
  baseCurrency?: CurrencyCode;
  /** Engine behaviour switches (all optional, sensible defaults). */
  options?: EngineOptions;
}

export interface EngineOptions {
  /**
   * When a cash debit (BUY, FEE, FX_CONVERSION...) exceeds the available cash in that
   * currency, book the shortfall as an implicit external deposit on that day. Default true:
   * most users only log trades. When false, cash goes negative (margin) and is reported.
   */
  implicitCashFlows?: boolean;
  /**
   * What to do with SELL net proceeds: 'cash' keeps them as cash in the portfolio (default);
   * 'withdraw' books them as an implicit external withdrawal (for users who do not track cash).
   */
  sellProceeds?: 'cash' | 'withdraw';
  /** 'daily' (default): true TWR chained at every flow date. 'modifiedDietz': one MD per period. */
  twrMethod?: 'daily' | 'modifiedDietz';
  /** Overrides portfolio.costMethod (e.g. to preview AVERAGE vs FIFO). */
  costMethod?: CostMethod;
  /** "Today" for defaults (end of the monthly table). Defaults to the machine's local date. */
  asOf?: ISODate;
  // ---- round 2 (all optional) ----
  /**
   * When a debit in a foreign currency lacks cash, convert portfolio-base-currency cash at the
   * market rate before booking an implicit deposit ('fromBaseCash', default) or not ('none').
   * Avoids double-counting "deposit COP + buy in USD" without a conversion row.
   */
  implicitFx?: 'fromBaseCash' | 'none';
  /** Use BUY/SELL prices as price observations when no market close exists that day (default true). */
  tradePriceObservations?: boolean;
  /** Redeem accrual instruments automatically at maturity (default true). */
  autoRedeemAtMaturity?: boolean;
  /** Staleness thresholds in days: listed instruments (default 7) and manual/unlisted (default 45). */
  staleDays?: { listed?: number; manual?: number };
  /** Restrict the analysis to these accounts ('' = rows without account). Per-account TWR/table/summary. */
  filter?: { accounts?: string[] };
  /** Inflation index for real returns. Default by base currency: COP -> IPC_CO, BRL -> IPCA, USD -> CPI_US, EUR -> HICP_EA. null disables. */
  inflationIndex?: IndexId | null;
  /** Rate indices to compare against (CDI, IBR...). Default: CDI for BRL, IBR for COP, when loaded. */
  indices?: IndexId[];
  /** Benchmark kind override: 'total' = the price series is already total return (adjusted) or dividends are reinvested. */
  benchmarkKinds?: Record<string, 'price' | 'total'>;
}

export interface MarketDataInput {
  prices: PriceSeries[];
  fx: FxSeries[];
  /** User-entered prices override provider prices on the same date. */
  manualPrices?: PriceSeries[];
  /** Rate and inflation indices: CDI, SELIC, IPCA, IPC_CO, IBR, UVR... (additive, round 2). */
  indexSeries?: IndexSeries[];
  /** Provider corporate actions: dividends per share make benchmarks total-return (additive). */
  corporateActions?: CorporateAction[];
  /** A preferred FX route older than this many days loses to a fresher route (default 7). */
  fxStaleDays?: number;
}

import { allocationImpl } from './allocation';
import { isoToDay } from './dates';
import { type Diagnostic, createContext, runLedger } from './ledger';
import { createMarketDataImpl, type MarketDataEx } from './market';
import { monthlyPerformanceImpl, performanceSummaryImpl, valueSeriesImpl } from './performance';
import { riskMetricsImpl } from './risk';
import { buildValuation } from './valuation';
import { validateTransactionsImpl } from './validate';
import { xirrImpl } from './xirr';

/**
 * Build a fill-forward MarketData from series (with FX triangulation through USD/EUR).
 * The returned object also implements `MarketDataEx` (pricePoint, fxPairs, ...).
 */
export function createMarketData(input: MarketDataInput): MarketData & MarketDataEx {
  return createMarketDataImpl(input);
}

/** Validate and sort transactions; returns problems found (overselling, missing price, unknown instrument...). */
export function validateTransactions(
  transactions: Transaction[],
  instruments: Instrument[],
  opts?: { today?: ISODate },
): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  return validateTransactionsImpl(transactions, instruments, opts);
}

export interface ValidationIssue {
  transactionId?: string;
  code: string;
  message: string;
}

/** Positions, cash and values at a date. */
export function valuePortfolio(input: EngineInput, date: ISODate): Valuation {
  const ctx = createContext(input);
  const day = isoToDay(date);
  return buildValuation(runLedger(ctx, day), day);
}

export function computeHoldings(input: EngineInput, date: ISODate): Holding[] {
  return valuePortfolio(input, date).holdings;
}

export function computeCash(input: EngineInput, date: ISODate): CashBalance[] {
  return valuePortfolio(input, date).cash;
}

/** Realized gains per closed lot piece with sell date in [from, to] (inclusive). */
export function realizedGains(input: EngineInput, from?: ISODate, to?: ISODate): RealizedGain[] {
  const ledger = runLedger(createContext(input), to ? isoToDay(to) : Infinity);
  const a = from ? isoToDay(from) : -Infinity;
  return ledger.realized.filter((r) => r.day >= a).map(({ day: _d, ...r }) => r);
}

/** Dividend and interest events dated in [from, to] (inclusive). */
export function incomeEvents(input: EngineInput, from?: ISODate, to?: ISODate): IncomeEvent[] {
  const ledger = runLedger(createContext(input), to ? isoToDay(to) : Infinity);
  const a = from ? isoToDay(from) : -Infinity;
  return ledger.income.filter((e) => e.day >= a).map(({ day: _d, ...e }) => e);
}

/** Monthly tracking table from first transaction month (or `from`) to `to` (default today). */
export function monthlyPerformance(
  input: EngineInput,
  opts?: { from?: YearMonth; to?: YearMonth; benchmarks?: string[]; asOf?: ISODate; twrMethod?: 'daily' | 'modifiedDietz' },
): MonthlyRow[] {
  return monthlyPerformanceImpl(input, opts);
}

export type PeriodKey = 'MTD' | 'QTD' | 'YTD' | '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | 'SI' | 'CUSTOM';

/**
 * Performance over a period ending at `asOf` (or custom.to). `from` in the result is the
 * first day included; the start value is the value at the close of the previous day.
 */
export function performanceSummary(
  input: EngineInput,
  period: PeriodKey,
  asOf: ISODate,
  custom?: { from: ISODate; to: ISODate },
): PerformanceSummary {
  return performanceSummaryImpl(input, period, asOf, custom);
}

/** Daily (or month-end) value series for charts. cumulativeTwr is 0 at `from`. */
export function valueSeries(
  input: EngineInput,
  opts: { from: ISODate; to: ISODate; step: 'day' | 'week' | 'month' },
): { date: ISODate; valueBase: number; netInvestedBase: number; cumulativeTwr: number }[] {
  return valueSeriesImpl(input, opts);
}

export function riskMetrics(
  monthly: MonthlyRow[],
  opts?: { riskFreeAnnual?: number; benchmarkMonthly?: number[]; benchmarkId?: string },
): RiskMetrics {
  return riskMetricsImpl(monthly, opts);
}

export function allocation(valuation: Valuation, instruments: Instrument[], by: AllocationDimension): AllocationSlice[] {
  return allocationImpl(valuation, instruments, by);
}

/** Annualized money-weighted return. Cash flows: negative = invested, positive = received/terminal value. */
export function xirr(flows: { date: ISODate; amount: number }[]): number | undefined {
  return xirrImpl(flows);
}

/**
 * Engine diagnostics from replaying the ledger: negative cash (margin), oversells,
 * unknown instruments, missing FX for historical cost, invalid rows skipped.
 */
export function ledgerDiagnostics(input: EngineInput, to?: ISODate): Diagnostic[] {
  return runLedger(createContext(input), to ? isoToDay(to) : Infinity).diagnostics;
}

/** External flows (explicit and implicit) in transaction currency and base currency at flow-date FX. */
export function externalFlows(
  input: EngineInput,
): { date: ISODate; kind: string; currency: CurrencyCode; amount: number; amountBase: number; transactionId?: string }[] {
  const ctx = createContext(input);
  const ledger = runLedger(ctx);
  return ledger.flows.map((f) => {
    const r = f.currency === ctx.base ? 1 : (ctx.market.fxAt(f.currency, ctx.base, f.day) ?? f.rateHint ?? ctx.market.fxNearest(f.currency, ctx.base, f.day) ?? 0);
    return {
      date: new Date(f.day * 86_400_000).toISOString().slice(0, 10),
      kind: f.kind,
      currency: f.currency,
      amount: f.amount,
      amountBase: f.amount * r,
      transactionId: f.transactionId,
    };
  });
}
