/**
 * Shared domain contract for Portafolio Pro.
 *
 * Every package (core engine, market data, importers, tax, web, server) codes against
 * these types. Change them only additively; breaking changes need coordination.
 *
 * Conventions
 * - Dates are ISO calendar dates `YYYY-MM-DD` (no time zone; the trade/settlement date
 *   as the investor sees it). Months are `YYYY-MM`.
 * - Money is a plain `number` in major units of its currency. Engines keep full precision
 *   and only round for display.
 * - Every monetary amount travels with its currency. Nothing is implicitly in the base currency.
 * - Currency codes are ISO 4217 (COP, BRL, USD, EUR, MXN, CLP, PEN, GBP, CHF, ...).
 */

export type ISODate = string;
export type YearMonth = string;
export type CurrencyCode = string;
export type CountryCode = string; // ISO 3166-1 alpha-2: CO, BR, US, ES, DE, FR, NL, MX, CL, PE...

export interface Money {
  amount: number;
  currency: CurrencyCode;
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export type AssetClass =
  | 'equity'
  | 'etf'
  | 'fund' // mutual fund, FIC (Colombia), FII (Brazil real-estate funds are 'reit')
  | 'reit'
  | 'bond'
  | 'fixed_income' // CDT (CO), CDB/LCI/LCA/Tesouro Direto (BR), term deposits
  | 'cash'
  | 'crypto'
  | 'commodity'
  | 'other';

/** Exchange identifiers. Prefer ISO 10383 MIC codes; free-form allowed for OTC/manual. */
export type ExchangeCode =
  | 'XBOG' // Bolsa de Valores de Colombia (BVC)
  | 'BVMF' // B3 Brasil
  | 'XNYS' // NYSE
  | 'XNAS' // Nasdaq
  | 'ARCX' // NYSE Arca
  | 'XMEX' // BMV Mexico
  | 'XSGO' // Bolsa de Santiago
  | 'XLIM' // BVL Lima
  | 'XMAD' // BME Madrid
  | 'XETR' // Xetra
  | 'XPAR' // Euronext Paris
  | 'XAMS' // Euronext Amsterdam
  | 'XMIL' // Borsa Italiana
  | 'XLON' // London
  | 'XSWX' // SIX Swiss
  | 'OTC'
  | 'MANUAL'
  | (string & {});

export type ProviderId = 'yahoo' | 'manual' | (string & {});

export interface Instrument {
  /** Stable internal id. Convention: `${exchange}:${symbol}` e.g. `BVMF:PETR4`, `XBOG:ECOPETROL`. */
  id: string;
  symbol: string;
  name: string;
  exchange: ExchangeCode;
  /** Trading / quotation currency. Prices for this instrument are in this currency. */
  currency: CurrencyCode;
  /** Country of listing or primary economic exposure. */
  country: CountryCode;
  assetClass: AssetClass;
  sector?: string;
  industry?: string;
  isin?: string;
  /** Symbol per data provider, e.g. `{ yahoo: 'PETR4.SA' }`, `{ yahoo: 'ECOPETROL.CL' }`. */
  providerSymbols?: Partial<Record<ProviderId, string>>;
  /** 'manual' = the user enters prices (unlisted funds, CDTs, private equity). */
  pricing?: 'auto' | 'manual';
  /** Price quoted per N units (some bonds quote per 100). Defaults to 1. */
  priceMultiplier?: number;
}

// ---------------------------------------------------------------------------
// Portfolios and transactions
// ---------------------------------------------------------------------------

export interface Portfolio {
  id: string;
  name: string;
  /** Reporting currency for this portfolio (user can switch views to any other). */
  baseCurrency: CurrencyCode;
  /** Tax residency drives tax reports (CO, BR, ...). */
  taxResidence?: CountryCode;
  costMethod: CostMethod;
  createdAt: ISODate;
  /** Optional benchmark instrument ids for comparisons. */
  benchmarks?: string[];
  /** Optional free-form tags for grouping (e.g. 'Pensión', 'Hijos'). */
  tags?: string[];
}

/** FIFO is the legal default in Colombia; Brazil uses weighted average (preço médio). */
export type CostMethod = 'FIFO' | 'AVERAGE' | 'LIFO';

export type TransactionType =
  | 'BUY'
  | 'SELL'
  | 'DIVIDEND' // cash dividend / JCP (BR) / dividendos (CO)
  | 'INTEREST'
  | 'DEPOSIT' // external cash in (counts as investor flow)
  | 'WITHDRAWAL' // external cash out (counts as investor flow)
  | 'FEE' // standalone fee (custody, admin)
  | 'TAX' // standalone tax payment / refund (negative amount = refund)
  | 'SPLIT' // stock split / reverse split / bonificación (ratio)
  | 'STOCK_DIVIDEND' // dividend paid in shares
  | 'TRANSFER_IN' // securities moved in from outside (counts as investor flow at market value)
  | 'TRANSFER_OUT'
  | 'FX_CONVERSION' // convert cash between currencies inside the portfolio
  | 'RETURN_OF_CAPITAL';

export interface Transaction {
  id: string;
  portfolioId: string;
  /** Optional broker/account (e.g. 'Interactive Brokers', 'XP', 'Trii', 'Davivienda Corredores'). */
  account?: string;
  date: ISODate;
  type: TransactionType;
  instrumentId?: string;
  /** Units. Always positive; direction is given by `type`. */
  quantity?: number;
  /** Per-unit price in `currency`. */
  price?: number;
  /** Currency of price/amount/fees/taxes on this row. */
  currency: CurrencyCode;
  /**
   * Gross cash amount in `currency`, always positive. For BUY/SELL defaults to quantity*price.
   * For DIVIDEND/INTEREST: gross before withholding. For DEPOSIT/WITHDRAWAL/FEE: the amount.
   */
  amount?: number;
  /** Commissions and fees in `currency` (positive). */
  fees?: number;
  /** Taxes withheld or paid in `currency` (positive), e.g. dividend withholding, IOF, GMF 4x1000. */
  taxes?: number;
  /** SPLIT / STOCK_DIVIDEND: new shares per old share (2 = 2-for-1, 0.1 = 1-for-10 reverse). */
  ratio?: number;
  /** FX_CONVERSION: target currency and amount received. */
  toCurrency?: CurrencyCode;
  toAmount?: number;
  /**
   * Optional explicit FX rate (units of portfolio base currency per 1 unit of `currency`) at the
   * transaction date, as actually executed. When present the engine uses it for historical cost
   * in base currency instead of the market rate (e.g. TRM, PTAX or broker rate).
   */
  fxRateToBase?: number;
  note?: string;
  /** Where the row came from: 'manual', 'import:ibkr', 'import:b3', ... */
  source?: string;
  /** Hash of the source row for de-duplication on re-import. */
  importHash?: string;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export interface PricePoint {
  date: ISODate;
  /** Close price in the instrument's currency (unadjusted for dividends). */
  close: number;
}

export interface PriceSeries {
  instrumentId: string;
  currency: CurrencyCode;
  /** Sorted ascending by date. May be daily or month-end. */
  points: PricePoint[];
  source: ProviderId;
}

export interface FxPoint {
  date: ISODate;
  /** Units of `quote` per 1 unit of `base`. E.g. base USD, quote COP: 4100.5 */
  rate: number;
}

export interface FxSeries {
  base: CurrencyCode;
  quote: CurrencyCode;
  points: FxPoint[];
  /** 'yahoo', 'banrep-trm', 'bcb-ptax', 'ecb', 'manual' */
  source: ProviderId;
}

export interface CorporateAction {
  instrumentId: string;
  date: ISODate;
  type: 'DIVIDEND' | 'SPLIT';
  /** DIVIDEND: amount per share in instrument currency. */
  amountPerShare?: number;
  /** SPLIT: new shares per old share. */
  ratio?: number;
}

/**
 * In-memory market data the engine reads from. Lookups must fill forward:
 * the price/rate for a date is the last known point on or before that date.
 */
export interface MarketData {
  /** Close in instrument currency, or undefined if no point on/before date. */
  price(instrumentId: string, date: ISODate): number | undefined;
  /** Units of `to` per 1 unit of `from` on date (fill-forward, triangulate via USD if needed). 1 when equal. */
  fx(from: CurrencyCode, to: CurrencyCode, date: ISODate): number | undefined;
}

// ---------------------------------------------------------------------------
// Engine outputs
// ---------------------------------------------------------------------------

export interface Lot {
  instrumentId: string;
  openDate: ISODate;
  quantity: number;
  /** Cost per unit in instrument currency (fees included). */
  unitCost: number;
  /** Cost per unit in base currency using the FX of the open date. */
  unitCostBase: number;
}

export interface Holding {
  instrumentId: string;
  quantity: number;
  currency: CurrencyCode;
  /** Total cost basis in instrument currency (fees included). */
  costBasis: number;
  /** Total cost basis in base currency at historical FX. */
  costBasisBase: number;
  price?: number;
  priceDate?: ISODate;
  marketValue?: number; // instrument currency
  marketValueBase?: number; // base currency at valuation date FX
  unrealizedGain?: number; // instrument currency
  unrealizedGainBase?: number; // base currency, includes FX effect
  /** Portion of unrealizedGainBase due to currency moves vs. due to price moves. */
  fxGainBase?: number;
  priceGainBase?: number;
  weight?: number; // share of total portfolio value (0..1)
  lots: Lot[];
  /** Quantity held per account/broker ('' = no account). Additive; used by allocation('account'). */
  accountQuantities?: Record<string, number>;
}

export interface CashBalance {
  currency: CurrencyCode;
  amount: number;
  amountBase?: number;
  /** Balance per account/broker ('' = no account). Additive; used by allocation('account'). */
  accountAmounts?: Record<string, number>;
}

export interface Valuation {
  date: ISODate;
  baseCurrency: CurrencyCode;
  holdings: Holding[];
  cash: CashBalance[];
  totalMarketValueBase: number; // securities + cash
  totalCostBase: number;
  /** Instruments with no price on/before date (valued at cost, flagged in UI). */
  missingPrices: string[];
  missingFx: CurrencyCode[];
}

export interface RealizedGain {
  instrumentId: string;
  sellDate: ISODate;
  openDate: ISODate;
  quantity: number;
  proceeds: number; // instrument currency, net of fees
  cost: number; // instrument currency
  gain: number; // instrument currency
  proceedsBase: number;
  costBase: number;
  gainBase: number; // includes FX effect
  holdingDays: number;
}

export interface IncomeEvent {
  date: ISODate;
  instrumentId?: string;
  type: 'DIVIDEND' | 'INTEREST';
  gross: number;
  taxes: number;
  net: number;
  currency: CurrencyCode;
  netBase: number;
}

/** One row of the monthly tracking table (the heart of the product). */
export interface MonthlyRow {
  month: YearMonth;
  startValueBase: number;
  endValueBase: number;
  /** External investor flows (deposits - withdrawals + transfers in - out), base currency. */
  netFlowsBase: number;
  incomeBase: number; // dividends + interest, net of withholding
  feesBase: number;
  taxesBase: number;
  /** Market gain = end - start - netFlows. */
  gainBase: number;
  /** Time-weighted return for the month (decimal, 0.012 = 1.2%). */
  twr: number;
  /** Cumulative TWR since inception through this month. */
  cumulativeTwr: number;
  /** Return decomposition in base currency: local price effect vs currency effect (decimals). */
  localReturn?: number;
  fxReturn?: number;
  benchmarkReturns?: Record<string, number>;
}

export interface PerformanceSummary {
  from: ISODate;
  to: ISODate;
  baseCurrency: CurrencyCode;
  startValueBase: number;
  endValueBase: number;
  netFlowsBase: number;
  gainBase: number;
  incomeBase: number;
  feesBase: number;
  realizedGainBase: number;
  unrealizedGainBase: number;
  twr: number;
  twrAnnualized?: number;
  /** Money-weighted return (XIRR), annualized. */
  mwr?: number;
}

export interface RiskMetrics {
  /** Annualized volatility of monthly returns. */
  volatility: number;
  sharpe?: number;
  sortino?: number;
  maxDrawdown: number; // negative decimal
  maxDrawdownStart?: YearMonth;
  maxDrawdownEnd?: YearMonth;
  beta?: number;
  correlation?: number;
  bestMonth?: { month: YearMonth; twr: number };
  worstMonth?: { month: YearMonth; twr: number };
  positiveMonthsRatio: number;
}

export type AllocationDimension =
  | 'assetClass'
  | 'country'
  | 'currency'
  | 'sector'
  | 'exchange'
  | 'instrument'
  | 'account';

export interface AllocationSlice {
  key: string;
  label: string;
  valueBase: number;
  weight: number;
}
