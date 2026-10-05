/**
 * @pm/importers — turn broker files (CSV / XLSX) into Portafolio Pro transactions.
 * Browser-safe: no Node APIs; accepts ArrayBuffer / Uint8Array / Blob / string.
 */
export * from './types';
export { importFile, importText, inspectFile, finalizeRows } from './pipeline';
export type { FileInspection, TableInspection } from './pipeline';
export { suggestMapping, suggestMappingFromHeaders, findHeaderRow, FIELD_SYNONYMS } from './mapping';
export { listPresets, getPreset, PRESETS } from './presets/registry';
export type { PresetDefinition } from './presets/common';
export { ParseContext } from './presets/common';
export { CANONICAL_COLUMNS, exportTransactionsCsv, canonicalTemplateCsv } from './presets/canonical';
export type { CanonicalColumn, CsvExportOptions } from './presets/canonical';
export {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  createBackup,
  serializeBackup,
  parseBackup,
  validateBackup,
} from './backup';
export type { PortfolioBackup, BackupProblem, BackupValidation } from './backup';
export { parseNumber, detectNumberFormat } from './numbers';
export { parseDate, detectDateFormat } from './dates';
export { decodeBytes, decodeWindows1252, encodeWindows1252 } from './decode';
export { readTables, parseCsvText, sniffDelimiter } from './read';
export { classifyType } from './txtypes';
export { InstrumentResolver, guessAssetClass } from './instruments';
export { normalizeExchange, yahooSymbol, EXCHANGES } from './markets';
export { formatMessage, translateIssue, ISSUE_MESSAGES } from './i18n';
export { hashString } from './util';
