import type { CsvCell } from './csv';
import type { LocalizedText } from './types';

/**
 * Presentation-neutral document model for tax packs: the web app renders it to PDF/print (or HTML);
 * the package stays free of PDF dependencies.
 */
export interface TaxDocumentTable {
  columns: string[];
  rows: CsvCell[][];
  /** Index of numeric columns, for right alignment / number formatting. */
  numeric?: number[];
}

export interface TaxDocumentSection {
  heading: string;
  paragraphs?: string[];
  table?: TaxDocumentTable;
  /** Highlighted key figures (label → value). */
  figures?: { label: string; value: number | string; currency?: string }[];
}

export interface TaxDocument {
  title: string;
  subtitle?: string;
  country: 'CO' | 'BR';
  year: number;
  locale: 'es-CO' | 'pt-BR';
  disclaimer: LocalizedText;
  sections: TaxDocumentSection[];
}
