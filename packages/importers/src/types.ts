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

export type FileKind = 'csv' | 'xlsx' | 'html' | 'json' | 'xls' | 'pdf' | 'unknown';

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
  /** Extra fields merged into a newly created instrument (e.g. CDT `accrual`, `pricing`). */
  extra?: Partial<Instrument>;
  /** Exact instrument to create (PDF certificates): bypasses market inference. */
  create?: Instrument;
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
  /** Excluded from cross-source duplicate checks (e.g. synthetic rows). */
  noDuplicateCheck?: boolean;
}

export interface ParsedRow {
  line: number;
  sheet?: string;
  raw?: string[];
  draft?: DraftTransaction;
  issues: ImportIssue[];
  /** Row intentionally ignored (totals, headers, unsupported but harmless movements). */
  skipped?: boolean;
  /** Additional transactions produced by the same source row (e.g. an FX trade's commission in another currency). */
  extra?: DraftTransaction[];
  /** Waits for a row-scoped confirmation (see ConfirmationRequest.scope = 'rows'). */
  pending?: boolean;
}

/**
 * - ok: will be imported.
 * - duplicate: same importHash as an existing transaction (already imported).
 * - possible_duplicate: looks like an existing/in-file transaction from another source; excluded until the
 *   user accepts it (`acceptDuplicates`).
 * - pending: blocked until the user confirms the file's date/number format (`needsConfirmation`).
 */
export type RowStatus = 'ok' | 'duplicate' | 'possible_duplicate' | 'pending' | 'error' | 'skipped';

export interface ImportRow {
  line: number;
  sheet?: string;
  status: RowStatus;
  transaction?: Transaction;
  /** Additional transactions produced by this row (same status). */
  extraTransactions?: Transaction[];
  issues: ImportIssue[];
  raw?: string[];
  /** For possible duplicates: what it collides with. */
  duplicateOf?: { transactionId?: string; source?: string; date: ISODate; line?: number; inFile: boolean };
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
  possibleDuplicates: number;
  /** Rows waiting for a format confirmation. */
  pending: number;
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
  /**
   * The file's date order or decimal separator could not be determined. Nothing is imported
   * (`transactions` is empty, rows are `pending`) until the UI re-runs with `options.dateFormat` /
   * `options.numberFormat` set to the user's choice (or `allowAmbiguous: true`).
   */
  needsConfirmation?: ConfirmationRequest[];
  /** The PDF is password protected: ask the user and retry with `pdfPassword`. */
  needsPassword?: 'required' | 'incorrect';
  /** Shortcut: candidates when the date order needs confirmation (suggested first). */
  dateFormatCandidates?: DateFormat[];
  /** Shortcut: candidates when the decimal separator needs confirmation (suggested first). */
  numberFormatCandidates?: NumberFormat[];
  /** Positions / cash reported by the broker (IBKR Open Positions & Cash Report, B3 Posição) vs. computed. */
  reconciliation?: Reconciliation;
  /** Corporate events that need the user's input (incorporação, cisão...). */
  corporateActions?: CorporateActionSuggestion[];
  /**
   * Securities the importer could not identify with certainty (SINACOR specifications, EUR tickers listed
   * on several venues). The UI asks the user, stores the answers and passes them back as `securityMap`.
   */
  unknownSecurities?: UnknownSecurity[];
  /** Suggested updates to existing instruments (e.g. a guessed US exchange now known). */
  instrumentUpdates?: { id: string; changes: Partial<Instrument>; reason: string }[];
}

export interface UnknownSecurity {
  /** Text to map (e.g. "MINERVA ON NM", or "SAN" for a ticker without venue). Use it as key in `securityMap`. */
  key: string;
  lines: number[];
  /** Candidate answers (tickers or MICs), best first, possibly empty. */
  suggestions: string[];
}

export interface ConfirmationRequest {
  kind: 'dateFormat' | 'numberFormat';
  /** Candidates, the suggested one first. */
  candidates: (DateFormat | NumberFormat)[];
  suggested: DateFormat | NumberFormat;
  /** Why it is suggested (hints used) — Spanish text for the UI. */
  reason: string;
  /** A few affected cells with each reading, for the dialog. */
  samples: { line: number; value: string; readings: Record<string, string> }[];
  /** Lines of rows whose values change with the choice. */
  affectedLines: number[];
  /**
   * 'file' (default): one answer for the whole file (`dateFormat` / `numberFormat`), every row waits.
   * 'rows': only `affectedLines` wait; answer per line with `rowNumberFormats`.
   */
  scope?: 'file' | 'rows';
}

export interface ReportedPosition {
  instrumentId?: string;
  symbol: string;
  quantity: number;
  currency?: CurrencyCode;
  costBasis?: number;
  marketValue?: number;
  price?: number;
}

export interface PositionDifference {
  instrumentId: string;
  symbol: string;
  reported: number;
  computed: number;
  difference: number;
}

export interface Reconciliation {
  asOf?: ISODate;
  source: string;
  positions: ReportedPosition[];
  cash: { currency: CurrencyCode; amount: number }[];
  /** Computed (existing + imported) vs. reported; only rows that differ. */
  positionDifferences: PositionDifference[];
  cashDifferences: { currency: CurrencyCode; reported: number; computed: number; difference: number }[];
}

export interface CorporateActionSuggestion {
  line: number;
  date: ISODate;
  kind: 'merger' | 'spinoff' | 'conversion' | 'symbol_change' | 'other';
  description: string;
  legs: { symbol?: string; name?: string; quantity?: number; direction: 'in' | 'out' }[];
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
  | 'fxRateToBase'
  | 'settleDate';

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
  /**
   * Accept the suggested reading when dates/numbers are ambiguous instead of blocking with
   * `needsConfirmation` (rows still carry warnings). Default false.
   */
  allowAmbiguous?: boolean;
  /**
   * Possible duplicates are excluded by default. 'in-file' accepts repeated rows within the file,
   * 'all' accepts every possible duplicate, or pass the line numbers the user accepted.
   */
  acceptDuplicates?: 'none' | 'in-file' | 'all' | number[];
  /** Instrument catalog (e.g. `CATALOG.instruments` from @pm/market-data) for ISIN/symbol → exchange. */
  catalog?: Instrument[];
  /** User answers: ticker or spec → instrument id or MIC (e.g. `{ 'PETROBRAS PN N2': 'BVMF:PETR4', SAN: 'XMAD' }`). */
  securityMap?: Record<string, string>;
  /** Optional price-plausibility hook: reference price for a symbol at a date (used to disambiguate numbers). */
  referencePrice?: (hint: InstrumentHint, date: ISODate) => number | undefined;
  /** Nota de corretagem spreadsheet: how to read fee columns. Default 'auto'. */
  notaFeesMode?: 'auto' | 'per-row' | 'per-note';
  /** B3 Movimentação: settlements of trades already imported from Negociação/notas. Default 'auto' (skip matched). */
  b3SettlementMode?: 'auto' | 'include' | 'skip';
  /** Position statements (IBKR Open Positions, B3 Posição): reconcile only (default) or import as opening TRANSFER_IN. */
  positionsMode?: 'reconcile' | 'opening';
  /** Date for opening positions / reconciliation when the file has none. */
  asOfDate?: ISODate;
  /** Broker profile (defaults for generic files): see `listBrokerProfiles()`. */
  brokerProfile?: string;
  /** pdf.js module to use (defaults to a dynamic import of `pdfjs-dist/legacy/build/pdf.mjs`). */
  pdfjs?: unknown;
  /**
   * Password for protected PDFs (XP, Clear and Rico protect notas with the first digits of the CPF).
   * When missing/wrong the result has `needsPassword` and the UI asks the user.
   */
  pdfPassword?: string;
  /**
   * Per-line answers for rows whose numbers are ambiguous only for that row (e.g. a USD row in a COP
   * statement with ';' delimiter): `{ 12: 'dot' }`.
   */
  rowNumberFormats?: Record<number, NumberFormat>;
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
