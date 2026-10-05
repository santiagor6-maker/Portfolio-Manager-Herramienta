/**
 * Public types of @pm/importers.
 *
 * The importer turns broker files (CSV / XLSX / HTML-as-XLS) into `Transaction[]` plus suggested
 * `Instrument[]`, with a per-row preview model (line numbers, issues, duplicate detection) that the
 * web app renders before the user confirms the import.
 */
import type {
  AssetClass,
  CurrencyCode,
  ExchangeCode,
  Instrument,
  ISODate,
  Transaction,
  TransactionType,
} from '@pm/core';

export type Locale = 'es' | 'pt' | 'en';

/** Decimal separator convention of a file: `dot` = 1,234.56 (en) / `comma` = 1.234,56 (es/pt). */
export type NumberFormat = 'dot' | 'comma';

/** Field order of numeric dates: YMD = 2024-01-31, DMY = 31/01/2024, MDY = 01/31/2024. */
export type DateFormat = 'YMD' | 'DMY' | 'MDY';

export type FileKind = 'csv' | 'xlsx' | 'html' | 'json' | 'xls' | 'unknown';

export type Confidence = 'high' | 'medium' | 'low';

export type Severity = 'error' | 'warning' | 'info';

/** Raw cell value as read from CSV (always strings) or XLSX (typed). */
export type Cell = string | number | boolean | Date | null;

/** A grid of cells with the 1-based source line (CSV) or row number (XLSX) of every row. */
export interface RawTable {
  /** Sheet name for XLSX, file name (or 'csv') for CSV. */
  name: string;
  rows: Cell[][];
  /** `lines[i]` is the 1-based line / spreadsheet row number of `rows[i]`. */
  lines: number[];
}

/** Anything the importer can read. `Blob`/`File` in the browser, `ArrayBuffer`/`Uint8Array` anywhere, or already-decoded text. */
export type ImportData = ArrayBuffer | Uint8Array | string | { arrayBuffer(): Promise<ArrayBuffer> };

export interface ImportInput {
  data: ImportData;
  fileName?: string;
}

export interface ImportIssue {
  /** Stable machine code, e.g. `INVALID_DATE`, `UNKNOWN_TYPE`, `DUPLICATE`. */
  code: string;
  severity: Severity;
  /** Human message in the requested locale (default Spanish). */
  message: string;
  /** Interpolation params (also useful for the UI to re-translate). */
  params?: Record<string, string | number>;
  /** 1-based line (CSV) or row (XLSX). */
  line?: number;
  sheet?: string;
  column?: string;
}

/** Hints collected by a parser to resolve an Instrument. */
export interface InstrumentHint {
  symbol?: string;
  isin?: string;
  name?: string;
  /** MIC (XNAS, BVMF, XBOG...) when known. */
  exchange?: ExchangeCode;
  /** Quotation currency when known. */
  currency?: CurrencyCode;
  assetClass?: AssetClass;
  /** Country hint (BR, CO, US...) when the exchange is unknown. */
  country?: string;
  /** Explicit instrument id (canonical template / backups). */
  id?: string;
}

/** Transaction under construction (before instrument resolution, hashing and id assignment). */
export interface DraftTransaction {
  date: ISODate;
  type: TransactionType;
  currency: CurrencyCode;
  instrument?: InstrumentHint;
  quantity?: number;
  price?: number;
  amount?: number;
  fees?: number;
  taxes?: number;
  ratio?: number;
  toCurrency?: CurrencyCode;
  toAmount?: number;
  fxRateToBase?: number;
  note?: string;
  account?: string;
  /** Broker-side unique reference (trade id, order id) used for stable de-duplication hashes. */
  brokerRef?: string;
  /**
   * For SPLIT / STOCK_DIVIDEND rows where the broker reports shares added (or removed, negative)
   * instead of a ratio. The pipeline infers `ratio` from the running position.
   */
  deltaShares?: number;
}

export interface ParsedRow {
  line: number;
  sheet?: string;
  raw?: string[];
  draft?: DraftTransaction;
  issues: ImportIssue[];
  /** Row intentionally ignored (totals, headers, unsupported but harmless movements). */
  skipped?: boolean;
}

export type RowStatus = 'ok' | 'duplicate' | 'error' | 'skipped';

export interface ImportRow {
  line: number;
  sheet?: string;
  status: RowStatus;
  transaction?: Transaction;
  issues: ImportIssue[];
  raw?: string[];
}

export interface ImportStats {
  /** Data rows seen (excluding header/preamble). */
  totalRows: number;
  imported: number;
  duplicates: number;
  skipped: number;
  errors: number;
  warnings: number;
  byType: Partial<Record<TransactionType, number>>;
  firstDate?: ISODate;
  lastDate?: ISODate;
  currencies: CurrencyCode[];
  newInstruments: number;
  matchedInstruments: number;
}

export interface DetectionInfo {
  fileKind: FileKind;
  encoding?: string;
  delimiter?: string;
  presetId: string;
  presetLabel: string;
  presetConfidence: Confidence;
  /** 0..1 score of the header-signature match. */
  score: number;
  sheet?: string;
  numberFormat?: NumberFormat;
  dateFormat?: DateFormat;
}

export interface ImportResult {
  detection: DetectionInfo;
  /** Transactions ready to insert (status ok; duplicates and errors excluded). */
  transactions: Transaction[];
  /** Suggested NEW instruments referenced by the transactions (existing ones are reused). */
  instruments: Instrument[];
  rows: ImportRow[];
  warnings: ImportIssue[];
  errors: ImportIssue[];
  stats: ImportStats;
  /** When no preset matched and the auto-mapping was insufficient, the UI must ask for a mapping. */
  needsMapping?: boolean;
  /** Headers + suggestion so the UI can show the mapping editor. */
  mappingSuggestion?: MappingSuggestion;
}

// ---------------------------------------------------------------------------
// Column mapping (generic importer)
// ---------------------------------------------------------------------------

/** Logical fields the generic importer understands. */
export type MappingField =
  | 'date'
  | 'type'
  | 'symbol'
  | 'isin'
  | 'name'
  | 'quantity'
  | 'price'
  | 'amount'
  | 'netAmount'
  | 'fees'
  | 'taxes'
  | 'currency'
  | 'exchange'
  | 'account'
  | 'note'
  | 'ratio'
  | 'assetClass'
  | 'instrumentId'
  | 'toCurrency'
  | 'toAmount'
  | 'fxRateToBase';

export const MULTI_COLUMN_FIELDS: readonly MappingField[] = ['fees', 'taxes'];

/**
 * User-editable mapping from logical fields to column indexes (0-based, within the header row).
 * `fees` and `taxes` accept several columns which are summed (e.g. Comisión + IVA, Corretagem + Emolumentos).
 */
export interface ColumnMapping {
  /** 0-based index of the header row inside the table. Defaults to auto-detection. */
  headerRow?: number;
  columns: Partial<Record<MappingField, number | number[]>>;
  /** Used when there is no `type` column or the value is empty. */
  defaultType?: TransactionType;
  defaultCurrency?: CurrencyCode;
  /** Market for tickers without exchange info (e.g. XBOG for a Colombian statement). */
  defaultExchange?: ExchangeCode;
  /** Extra / overriding values for the type column, e.g. `{ 'C': 'BUY', 'V': 'SELL' }`. */
  typeValues?: Record<string, TransactionType>;
  dateFormat?: DateFormat;
  numberFormat?: NumberFormat;
}

export interface FieldSuggestion {
  field: MappingField;
  column: number;
  header: string;
  /** 0..1 */
  score: number;
}

export interface MappingSuggestion {
  headerRow: number;
  headers: string[];
  mapping: ColumnMapping;
  fields: FieldSuggestion[];
  /** Columns not used by the suggestion. */
  unmapped: { column: number; header: string }[];
  /** Required fields missing to import (date + type/quantity/amount + instrument for trades). */
  missing: MappingField[];
  /** First data rows for preview. */
  sample: string[][];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ImportOptions {
  portfolioId: string;
  /** Account label stamped on every transaction (e.g. 'Interactive Brokers', 'XP', 'Trii'). */
  account?: string;
  /** Force a preset id (skips detection). */
  presetId?: string;
  /** Force the generic importer with this mapping. */
  mapping?: ColumnMapping;
  /** XLSX sheet to read (name or 0-based index). Defaults to the best-matching sheet. */
  sheet?: string | number;
  existingTransactions?: Transaction[];
  existingInstruments?: Instrument[];
  /** Force encoding for byte input ('utf-8', 'windows-1252', 'utf-16le'). Auto-detected by default. */
  encoding?: string;
  dateFormat?: DateFormat;
  numberFormat?: NumberFormat;
  /** Language for issue messages. Default 'es'. */
  locale?: Locale;
  /** Fallback currency when a row has none (generic importer). */
  defaultCurrency?: CurrencyCode;
  /** Default US exchange when a US ticker has no exchange info and is not in the built-in list. Default 'XNAS'. */
  defaultUsExchange?: ExchangeCode;
  /** Build transaction ids. Default: `imp-${importHash}`. */
  idFactory?: (importHash: string, index: number) => string;
}

export interface PresetInfo {
  id: string;
  label: string;
  broker: string;
  /** Country of the broker / exchange (BR, CO, US, NL, GB, ...) or 'INTL'. */
  country: string;
  fileKinds: FileKind[];
  confidence: Confidence;
  /** Short Spanish description of what is imported. */
  description: string;
  /** Short Spanish instructions on how to export the file from the broker. */
  exportHelp: string;
}
