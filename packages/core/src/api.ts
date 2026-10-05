/**
 * Public engine API (signatures are the contract the web app codes against).
 * The core-engine agent implements these; bodies here are placeholders until then.
 */
import type {
  AllocationDimension,
  AllocationSlice,
  CashBalance,
  CurrencyCode,
  FxSeries,
  Holding,
  IncomeEvent,
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
}

export interface MarketDataInput {
  prices: PriceSeries[];
  fx: FxSeries[];
  /** User-entered prices override provider prices on the same date. */
  manualPrices?: PriceSeries[];
}

const todo = (name: string): never => {
  throw new Error(`${name} not implemented yet`);
};

/** Build a fill-forward MarketData from series (with FX triangulation through USD/EUR). */
export function createMarketData(_input: MarketDataInput): MarketData {
  return todo('createMarketData');
}

/** Validate and sort transactions; returns problems found (overselling, missing price, unknown instrument...). */
export function validateTransactions(
  _transactions: Transaction[],
  _instruments: Instrument[],
): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  return todo('validateTransactions');
}

export interface ValidationIssue {
  transactionId?: string;
  code: string;
  message: string;
}

/** Positions, cash and values at a date. */
export function valuePortfolio(_input: EngineInput, _date: ISODate): Valuation {
  return todo('valuePortfolio');
}

export function computeHoldings(_input: EngineInput, _date: ISODate): Holding[] {
  return todo('computeHoldings');
}

export function computeCash(_input: EngineInput, _date: ISODate): CashBalance[] {
  return todo('computeCash');
}

export function realizedGains(_input: EngineInput, _from?: ISODate, _to?: ISODate): RealizedGain[] {
  return todo('realizedGains');
}

export function incomeEvents(_input: EngineInput, _from?: ISODate, _to?: ISODate): IncomeEvent[] {
  return todo('incomeEvents');
}

/** Monthly tracking table from first transaction month (or `from`) to `to` (default today). */
export function monthlyPerformance(
  _input: EngineInput,
  _opts?: { from?: YearMonth; to?: YearMonth; benchmarks?: string[] },
): MonthlyRow[] {
  return todo('monthlyPerformance');
}

export type PeriodKey = 'MTD' | 'QTD' | 'YTD' | '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | 'SI' | 'CUSTOM';

export function performanceSummary(
  _input: EngineInput,
  _period: PeriodKey,
  _asOf: ISODate,
  _custom?: { from: ISODate; to: ISODate },
): PerformanceSummary {
  return todo('performanceSummary');
}

/** Daily (or month-end) value series for charts. */
export function valueSeries(
  _input: EngineInput,
  _opts: { from: ISODate; to: ISODate; step: 'day' | 'week' | 'month' },
): { date: ISODate; valueBase: number; netInvestedBase: number; cumulativeTwr: number }[] {
  return todo('valueSeries');
}

export function riskMetrics(
  _monthly: MonthlyRow[],
  _opts?: { riskFreeAnnual?: number; benchmarkMonthly?: number[] },
): RiskMetrics {
  return todo('riskMetrics');
}

export function allocation(_valuation: Valuation, _instruments: Instrument[], _by: AllocationDimension): AllocationSlice[] {
  return todo('allocation');
}

/** Annualized money-weighted return. Cash flows: negative = invested, positive = received/terminal value. */
export function xirr(_flows: { date: ISODate; amount: number }[]): number | undefined {
  return todo('xirr');
}
