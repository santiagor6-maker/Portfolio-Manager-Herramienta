/**
 * Portafolio Pro canonical CSV: the template users can fill by hand and the format we export to.
 * Round-trip safe: export → import yields the same transactions (ids/hashes aside).
 */
import type { Instrument, Transaction } from '@pm/core';
import type { ColumnMapping, MappingField } from '../types';
import { formatPlainNumber } from '../util';
import { locateHeader, type PresetDefinition } from './common';
import { parseWithMapping } from './generic';

export interface CanonicalColumn {
  column: string;
  field: MappingField;
  required: boolean;
  /** Spanish documentation for the template help screen / README. */
  description: string;
}

export const CANONICAL_COLUMNS: CanonicalColumn[] = [
  { column: 'date', field: 'date', required: true, description: 'Fecha de la operación, AAAA-MM-DD (también se acepta DD/MM/AAAA).' },
  { column: 'type', field: 'type', required: true, description: 'BUY, SELL, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, FEE, TAX, SPLIT, STOCK_DIVIDEND, TRANSFER_IN, TRANSFER_OUT, FX_CONVERSION, RETURN_OF_CAPITAL (o compra/venta/dividendo...).' },
  { column: 'instrument_id', field: 'instrumentId', required: false, description: 'Id interno del activo: BOLSA:SÍMBOLO, p. ej. BVMF:PETR4, XBOG:ECOPETROL, XNAS:AAPL. Si se omite se deduce de symbol/exchange.' },
  { column: 'symbol', field: 'symbol', required: false, description: 'Ticker (PETR4, ECOPETROL, AAPL). Obligatorio para compras/ventas si no hay instrument_id ni isin.' },
  { column: 'exchange', field: 'exchange', required: false, description: 'Bolsa (código MIC): XBOG, BVMF, XNYS, XNAS, ARCX, XMAD, XETR... También B3, BVC, NYSE, NASDAQ.' },
  { column: 'name', field: 'name', required: false, description: 'Nombre del activo (opcional).' },
  { column: 'isin', field: 'isin', required: false, description: 'Código ISIN (opcional, mejora la identificación).' },
  { column: 'asset_class', field: 'assetClass', required: false, description: 'equity, etf, fund, reit, bond, fixed_income, cash, crypto, commodity, other.' },
  { column: 'quantity', field: 'quantity', required: false, description: 'Número de títulos (positivo). Compras, ventas, transferencias, dividendos en acciones.' },
  { column: 'price', field: 'price', required: false, description: 'Precio por título en la moneda de la fila.' },
  { column: 'currency', field: 'currency', required: true, description: 'Moneda ISO 4217 de precio/monto/comisiones: COP, BRL, USD, EUR...' },
  { column: 'amount', field: 'amount', required: false, description: 'Monto bruto positivo. Compras/ventas: cantidad × precio. Dividendos: bruto antes de retención. Depósitos/retiros/comisiones: el monto.' },
  { column: 'fees', field: 'fees', required: false, description: 'Comisiones y gastos (positivo), en la moneda de la fila.' },
  { column: 'taxes', field: 'taxes', required: false, description: 'Impuestos retenidos o pagados (positivo): retención en la fuente, GMF, IOF, IRRF...' },
  { column: 'ratio', field: 'ratio', required: false, description: 'SPLIT / STOCK_DIVIDEND: acciones nuevas por cada acción anterior (2 = 2×1, 0,1 = 1×10 inverso).' },
  { column: 'to_currency', field: 'toCurrency', required: false, description: 'FX_CONVERSION: moneda recibida.' },
  { column: 'to_amount', field: 'toAmount', required: false, description: 'FX_CONVERSION: monto recibido.' },
  { column: 'fx_rate_to_base', field: 'fxRateToBase', required: false, description: 'Tasa de cambio real usada (unidades de moneda base por 1 unidad de la moneda de la fila), p. ej. la TRM.' },
  { column: 'account', field: 'account', required: false, description: 'Cuenta o corredor (Trii, XP, Interactive Brokers...).' },
  { column: 'note', field: 'note', required: false, description: 'Nota libre.' },
];

const HEADER_GROUPS = CANONICAL_COLUMNS.map((c) => [c.column, c.column.replace(/_/g, ' ')]);

export const canonicalPreset: PresetDefinition = {
  id: 'portafolio-pro',
  label: 'Plantilla Portafolio Pro (CSV)',
  broker: 'Portafolio Pro',
  country: 'INTL',
  fileKinds: ['csv', 'xlsx'],
  confidence: 'high',
  description: 'Nuestra plantilla CSV: una fila por movimiento con columnas documentadas. Ida y vuelta sin pérdidas.',
  exportHelp: 'Descarga la plantilla desde Importar → Plantilla, llénala en Excel/Sheets y súbela (CSV UTF-8 o XLSX).',
  detect(table) {
    const h = locateHeader(table, HEADER_GROUPS, 0.5, 5);
    if (!h) return 0;
    const must = h.header.has('date') && h.header.has('type') && h.header.has('currency');
    return must ? Math.min(1, 0.6 + h.coverage * 0.4) : 0;
  },
  parse(table, ctx) {
    const h = locateHeader(table, HEADER_GROUPS, 0.3, 5);
    if (!h) return [];
    const mapping: ColumnMapping = { headerRow: h.index, columns: {} };
    for (const col of CANONICAL_COLUMNS) {
      const idx = h.header.find(col.column);
      if (idx !== undefined) mapping.columns[col.field] = idx;
    }
    ctx.initDates(
      table.rows.slice(h.index + 1).map((r) => r[mapping.columns.date as number] ?? null),
      'YMD',
    );
    mapping.dateFormat = ctx.dateFormat;
    return parseWithMapping(table, ctx, mapping);
  },
};

export interface CsvExportOptions {
  delimiter?: ',' | ';' | '\t';
  /** Decimal separator. Defaults to ',' when delimiter is ';' (Excel es/pt), else '.'. */
  decimal?: '.' | ',';
  /** Prepend a UTF-8 BOM so Excel opens accents correctly. Default false. */
  bom?: boolean;
  lineEnding?: '\n' | '\r\n';
}

function quote(v: string, delimiter: string): string {
  return v.includes(delimiter) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Export transactions to the canonical CSV (instrument data joined in for readability). */
export function exportTransactionsCsv(transactions: Transaction[], instruments: Instrument[] = [], opts: CsvExportOptions = {}): string {
  const delimiter = opts.delimiter ?? ',';
  const decimal = opts.decimal ?? (delimiter === ';' ? ',' : '.');
  const eol = opts.lineEnding ?? '\n';
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const num = (n: number | undefined): string => (n === undefined ? '' : formatPlainNumber(n, decimal));
  const lines = [CANONICAL_COLUMNS.map((c) => c.column).join(delimiter)];
  const sorted = transactions.map((t, i) => ({ t, i })).sort((a, b) => a.t.date.localeCompare(b.t.date) || a.i - b.i);
  for (const { t } of sorted) {
    const inst = t.instrumentId ? byId.get(t.instrumentId) : undefined;
    const sym = inst?.symbol ?? (t.instrumentId?.includes(':') ? t.instrumentId.split(':').slice(1).join(':') : t.instrumentId ?? '');
    const ex = inst?.exchange ?? (t.instrumentId?.includes(':') ? t.instrumentId.split(':')[0] : '');
    const values: Record<string, string> = {
      date: t.date,
      type: t.type,
      instrument_id: t.instrumentId ?? '',
      symbol: t.instrumentId ? sym : '',
      exchange: t.instrumentId ? ex ?? '' : '',
      name: inst?.name ?? '',
      isin: inst?.isin ?? '',
      asset_class: inst?.assetClass ?? '',
      quantity: num(t.quantity),
      price: num(t.price),
      currency: t.currency,
      amount: num(t.amount),
      fees: num(t.fees),
      taxes: num(t.taxes),
      ratio: num(t.ratio),
      to_currency: t.toCurrency ?? '',
      to_amount: num(t.toAmount),
      fx_rate_to_base: num(t.fxRateToBase),
      account: t.account ?? '',
      note: t.note ?? '',
    };
    lines.push(CANONICAL_COLUMNS.map((c) => quote(values[c.column] ?? '', delimiter)).join(delimiter));
  }
  return (opts.bom ? '﻿' : '') + lines.join(eol) + eol;
}

/** Downloadable template with a few documented example rows. */
export function canonicalTemplateCsv(opts: CsvExportOptions = {}): string {
  const examples: Transaction[] = [
    { id: 'e1', portfolioId: '', date: '2024-01-15', type: 'DEPOSIT', currency: 'COP', amount: 5000000, account: 'Trii', note: 'Aporte inicial' },
    { id: 'e2', portfolioId: '', date: '2024-01-16', type: 'BUY', instrumentId: 'XBOG:ECOPETROL', quantity: 1000, price: 2450, currency: 'COP', amount: 2450000, fees: 7350, account: 'Trii' },
    { id: 'e3', portfolioId: '', date: '2024-02-01', type: 'BUY', instrumentId: 'BVMF:PETR4', quantity: 100, price: 38.5, currency: 'BRL', amount: 3850, fees: 1.15, account: 'XP' },
    { id: 'e4', portfolioId: '', date: '2024-03-10', type: 'BUY', instrumentId: 'XNAS:AAPL', quantity: 5, price: 172.3, currency: 'USD', amount: 861.5, fees: 1, account: 'Interactive Brokers' },
    { id: 'e5', portfolioId: '', date: '2024-04-20', type: 'DIVIDEND', instrumentId: 'XBOG:ECOPETROL', currency: 'COP', amount: 312000, taxes: 31200, account: 'Trii' },
    { id: 'e6', portfolioId: '', date: '2024-05-02', type: 'FX_CONVERSION', currency: 'COP', amount: 4000000, toCurrency: 'USD', toAmount: 1000, fees: 12000, note: 'Monetización' },
  ];
  return exportTransactionsCsv(examples, [], opts);
}
