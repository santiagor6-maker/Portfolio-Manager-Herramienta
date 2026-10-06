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
  PositionPerformance,
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
import { type CorporateActionResult, applyCorporateActions as applyCorporateActionsImpl } from './corporate';
import { isoToDay } from './dates';
import { Engine, createEngine as createEngineImpl, engineFor } from './engine';
import { type GoalProjectionOptions, type GoalProjectionResult, goalProjection as goalProjectionImpl } from './goals';
import { type Diagnostic, createContext, runLedger } from './ledger';
import { createMarketDataImpl, type MarketDataEx } from './market';
import { type RiskOptions, riskMetricsImpl } from './risk';
import { validateTransactionsImpl } from './validate';
import { xirrDetailed, xirrImpl } from './xirr';

/**
 * Build a fill-forward MarketData from series (with FX triangulation through USD/EUR).
 * The returned object also implements `MarketDataEx` (pricePoint, fxPairs, indexLevel, ...).
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
  return engineFor(input).valuation(date);
}

export function computeHoldings(input: EngineInput, date: ISODate): Holding[] {
  return valuePortfolio(input, date).holdings;
}

export function computeCash(input: EngineInput, date: ISODate): CashBalance[] {
  return valuePortfolio(input, date).cash;
}

/** Realized gains per closed lot piece with sell date in [from, to] (inclusive). */
export function realizedGains(input: EngineInput, from?: ISODate, to?: ISODate): RealizedGain[] {
  return engineFor(input).realized(from, to);
}

/** Dividend and interest events dated in [from, to] (inclusive). */
export function incomeEvents(input: EngineInput, from?: ISODate, to?: ISODate): IncomeEvent[] {
  return engineFor(input).income(from, to);
}

/** Monthly tracking table from first transaction month (or `from`) to `to` (default today). */
export function monthlyPerformance(
  input: EngineInput,
  opts?: { from?: YearMonth; to?: YearMonth; benchmarks?: string[]; asOf?: ISODate; twrMethod?: 'daily' | 'modifiedDietz' },
): MonthlyRow[] {
  return engineFor(input).monthly(opts ?? {});
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
  return engineFor(input).summary(period, asOf, custom);
}

/** Daily (or month-end) value series for charts. cumulativeTwr is 0 at `from`. */
export function valueSeries(
  input: EngineInput,
  opts: { from: ISODate; to: ISODate; step: 'day' | 'week' | 'month' },
): { date: ISODate; valueBase: number; netInvestedBase: number; cumulativeTwr: number }[] {
  return engineFor(input).series(opts);
}

export function riskMetrics(monthly: MonthlyRow[], opts?: RiskOptions): RiskMetrics {
  return riskMetricsImpl(monthly, opts);
}

export function allocation(valuation: Valuation, instruments: Instrument[], by: AllocationDimension): AllocationSlice[] {
  return allocationImpl(valuation, instruments, by);
}

/** Annualized money-weighted return. Cash flows: negative = invested, positive = received/terminal value. */
export function xirr(flows: { date: ISODate; amount: number }[]): number | undefined {
  return xirrImpl(flows);
}

// ---------------------------------------------------------------------------
// Additions (round 2)
// ---------------------------------------------------------------------------

export type { RiskOptions } from './risk';
export type { GoalProjectionOptions, GoalProjectionResult } from './goals';
export type { CorporateActionResult } from './corporate';
export type { XirrResult } from './xirr';
export { Engine };

/** XIRR with a day-count choice ('ACT/ACT' = calendar years) and a multiple-roots flag. */
export function xirrEx(flows: { date: ISODate; amount: number }[], opts?: { dayCount?: 'ACT/365' | 'ACT/ACT'; guess?: number }) {
  return xirrDetailed(flows, opts?.guess ?? 0.1, opts?.dayCount ?? 'ACT/365');
}

/**
 * Memoized engine: one ledger pass and one daily valuation chain shared by every summary,
 * series, monthly table and position report for this input (C20).
 */
export function createEngine(input: EngineInput): Engine {
  return createEngineImpl(input);
}

/** Per-position performance for a period: total return, realized/unrealized, income, FX part, TWR, IRR (C5). */
export function positionPerformance(
  input: EngineInput,
  period: PeriodKey,
  asOf: ISODate,
  custom?: { from: ISODate; to: ISODate },
): PositionPerformance[] {
  return engineFor(input).positions(period, asOf, custom);
}

/** Suggested transactions from provider corporate actions, without duplicating recorded ones (C11). */
export function applyCorporateActions(
  transactions: Transaction[],
  actions: CorporateAction[],
  instruments: Instrument[],
  opts?: { portfolioId?: string; dividendToleranceDays?: number; splitToleranceDays?: number },
): CorporateActionResult {
  return applyCorporateActionsImpl(transactions, actions, instruments, opts);
}

/** Contribution / goal projection with pessimistic, expected and optimistic scenarios (C21). */
export function goalProjection(opts: GoalProjectionOptions): GoalProjectionResult {
  return goalProjectionImpl(opts);
}

/**
 * Engine diagnostics from replaying the ledger: negative cash, oversells, unknown instruments,
 * missing FX, withdrawals above cash, negative account quantities, implicit FX conversions,
 * income without position, maturity redemptions, rejected rows (invalid dates).
 */
export function ledgerDiagnostics(input: EngineInput, to?: ISODate): Diagnostic[] {
  if (!to) return engineFor(input).diagnostics();
  return runLedger(createContext(input), isoToDay(to)).diagnostics;
}

/** External flows (explicit and implicit) in transaction currency and base currency at flow-date FX. */
export function externalFlows(
  input: EngineInput,
): { date: ISODate; kind: string; currency: CurrencyCode; amount: number; amountBase: number; transactionId?: string }[] {
  return engineFor(input).ledger.flows.map((f) => ({
    date: new Date(f.day * 86_400_000).toISOString().slice(0, 10),
    kind: f.kind,
    currency: f.currency,
    amount: f.amount,
    amountBase: f.base,
    transactionId: f.transactionId,
  }));
}
