import Dexie, { type Table } from 'dexie';
import type {
  CorporateAction,
  CurrencyCode,
  FxPoint,
  IndexSeries,
  Instrument,
  ISODate,
  Portfolio,
  PricePoint,
  ProviderId,
  Transaction,
} from '@pm/core';

/** Portfolio as stored locally (adds UI-only flags to the contract type). */
export interface StoredPortfolio extends Portfolio {
  /** Seeded sample data ("Datos de ejemplo"). */
  isDemo?: boolean;
  color?: string;
  archived?: boolean;
}

export interface StoredInstrument extends Instrument {
  isDemo?: boolean;
}

export interface StoredTransaction extends Transaction {
  isDemo?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** User-entered price (month-end close for funds, CDTs, private assets...). */
export interface ManualPrice {
  instrumentId: string;
  date: ISODate;
  close: number;
  currency: CurrencyCode;
  note?: string;
  updatedAt: number;
}

export interface CachedPriceSeries {
  instrumentId: string;
  currency: CurrencyCode;
  points: PricePoint[];
  source: ProviderId;
  updatedAt: number;
  isDemo?: boolean;
}

export interface CachedFxSeries {
  /** `${base}/${quote}`, e.g. `USD/COP`. */
  pair: string;
  base: CurrencyCode;
  quote: CurrencyCode;
  points: FxPoint[];
  source: ProviderId;
  updatedAt: number;
  isDemo?: boolean;
}

/** Latest intraday quote (from the market-data server). Added in schema v2. */
export interface CachedQuote {
  instrumentId: string;
  price: number;
  previousClose?: number;
  currency: CurrencyCode;
  date: ISODate;
  source: ProviderId;
  updatedAt: number;
}

/** Cached rate/inflation index (CDI, IPCA, IPC_CO, IBR...). Added in schema v3. */
export interface CachedIndexSeries extends IndexSeries {
  updatedAt: number;
  isDemo?: boolean;
}

/** Provider corporate action (dividend/split...) for a held instrument. Added in schema v3. */
export interface StoredCorporateAction extends CorporateAction {
  /** `${instrumentId}|${type}|${date}` */
  id: string;
  updatedAt: number;
}

export interface WatchItem {
  instrumentId: string;
  addedAt: number;
  note?: string;
}

export type AlertKind = 'priceAbove' | 'priceBelow' | 'monthClose' | 'dividend' | 'dayMove';

export interface AlertRule {
  id: string;
  kind: AlertKind;
  instrumentId?: string;
  /** priceAbove/priceBelow: price in instrument currency; dayMove: absolute decimal change (0.05). */
  threshold?: number;
  enabled: boolean;
  createdAt: number;
  /** Last time it fired (ms) and the key of what fired (avoids repeating). */
  lastFiredAt?: number;
  lastFiredKey?: string;
}

export interface AlertEvent {
  id: string;
  ruleId?: string;
  kind: AlertKind;
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
  href?: string;
}

export interface Goal {
  id: string;
  name: string;
  target: number;
  currency: CurrencyCode;
  targetDate: ISODate;
  monthlyContribution: number;
  expectedReturn: number;
  /** Portfolio id or 'all' whose value counts toward the goal. */
  portfolioId: string;
  createdAt: number;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export const DB_NAME = 'portafolio-pro';

export class PortfolioDB extends Dexie {
  portfolios!: Table<StoredPortfolio, string>;
  instruments!: Table<StoredInstrument, string>;
  transactions!: Table<StoredTransaction, string>;
  manualPrices!: Table<ManualPrice, [string, string]>;
  priceSeries!: Table<CachedPriceSeries, string>;
  fxSeries!: Table<CachedFxSeries, string>;
  quotes!: Table<CachedQuote, string>;
  settings!: Table<SettingRow, string>;
  meta!: Table<MetaRow, string>;
  indexSeries!: Table<CachedIndexSeries, string>;
  corporateActions!: Table<StoredCorporateAction, string>;
  watchlist!: Table<WatchItem, string>;
  alerts!: Table<AlertRule, string>;
  alertEvents!: Table<AlertEvent, string>;
  goals!: Table<Goal, string>;

  constructor(name = DB_NAME) {
    super(name);

    // v1: initial schema.
    this.version(1).stores({
      portfolios: 'id, name',
      instruments: 'id, symbol, exchange, country, currency',
      transactions: 'id, portfolioId, date, type, instrumentId, importHash, [portfolioId+date]',
      manualPrices: '[instrumentId+date], instrumentId, date',
      priceSeries: 'instrumentId, updatedAt',
      fxSeries: 'pair, updatedAt',
      settings: 'key',
    });

    // v2: latest quotes cache, meta table (refresh timestamps, onboarding flags),
    // and backfill `source` on transactions created before it existed.
    this.version(2)
      .stores({
        quotes: 'instrumentId, updatedAt',
        meta: 'key',
        transactions: 'id, portfolioId, date, type, instrumentId, importHash, source, [portfolioId+date]',
      })
      .upgrade(async (tx) => {
        await tx
          .table('transactions')
          .toCollection()
          .modify((t: StoredTransaction) => {
            if (!t.source) t.source = 'manual';
          });
      });

    // v3: rate/inflation indices, provider corporate actions, watchlist, alerts and goals.
    this.version(3).stores({
      indexSeries: 'id, updatedAt',
      corporateActions: 'id, instrumentId, date',
      watchlist: 'instrumentId',
      alerts: 'id, kind',
      alertEvents: 'id, createdAt, read',
      goals: 'id',
    });
  }
}

export const SCHEMA_VERSION = 3;

export let db = new PortfolioDB();

/** Test hook: use a fresh database (e.g. with fake-indexeddb). */
export function resetDbInstance(name = DB_NAME): PortfolioDB {
  db.close();
  db = new PortfolioDB(name);
  return db;
}
