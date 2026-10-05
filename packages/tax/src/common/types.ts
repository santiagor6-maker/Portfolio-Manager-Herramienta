import type { CurrencyCode, Instrument, ISODate, MarketData, Transaction } from '@pm/core';

/** Whether a dated legal parameter was checked against an official/primary source. */
export type ParamStatus = 'verified' | 'needs-verification';

/** Provenance of a tax parameter (rate, threshold, UVT...). */
export interface ParamMeta {
  status: ParamStatus;
  /** Legal reference and/or where the value was checked. */
  source: string;
  /** Date the value was last checked by the maintainers. */
  checkedOn?: ISODate;
  note?: string;
}

export type IssueLevel = 'info' | 'warning' | 'error';

/**
 * A problem or remark found while building a report. `code` is stable and meant for i18n in the
 * UI; `message` is a Spanish (CO) or Portuguese (BR) default text.
 */
export interface TaxIssue {
  level: IssueLevel;
  code: string;
  message: string;
  transactionId?: string;
  instrumentId?: string;
}

/** Common input for every tax report. Transactions may cover several years; reports filter. */
export interface TaxInput {
  transactions: Transaction[];
  instruments: Instrument[];
  market: MarketData;
}

export interface LocalizedText {
  es: string;
  pt: string;
  en: string;
}

/** Rate lookup in a specific tax currency (e.g. TRM for COP, PTAX for BRL). */
export type RateFn = (currency: CurrencyCode, date: ISODate) => number | undefined;
