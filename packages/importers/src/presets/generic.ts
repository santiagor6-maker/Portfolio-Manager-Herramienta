/**
 * Generic importer driven by a user-editable column mapping (auto-suggested from es/pt/en headers).
 * Also the engine behind the canonical template and the Colombian statement preset.
 */
import type { AssetClass, TransactionType } from '@pm/core';
import { findHeaderRow } from '../mapping';
import { classifyType } from '../txtypes';
import type { ColumnMapping, DraftTransaction, InstrumentHint, MappingField, NumberFormat, ParsedRow, RawTable } from '../types';
import { cellToString, isBlankRow, isCurrencyCode, normalizeText } from '../util';
import { type ParseContext, type PresetDefinition, TOTAL_ROW_RE, cell, columnValues, str, sum } from './common';

const ASSET_CLASS_WORDS: [RegExp, AssetClass][] = [
  [/\b(etf|fondo bursatil|fundo de indice)\b/, 'etf'],
  [/\b(fii|reit|fondo inmobiliario|fundo imobiliario)\b/, 'reit'],
  [/\b(fondo|fundo|fund|fic|mutual)\b/, 'fund'],
  [/\b(bono|bond|renta fija|cdt|cdb|tesouro|lci|lca|debenture|tes|fixed income)\b/, 'fixed_income'],
  [/\b(cripto|crypto)\b/, 'crypto'],
  [/\b(accion|acciones|acao|acoes|stock|stocks|equity|share|shares)\b/, 'equity'],
  [/\b(efectivo|cash|caixa)\b/, 'cash'],
];

const VALID_TYPES: TransactionType[] = [
  'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'SPLIT', 'STOCK_DIVIDEND',
  'TRANSFER_IN', 'TRANSFER_OUT', 'FX_CONVERSION', 'RETURN_OF_CAPITAL',
];

export function assetClassFromText(s: string): AssetClass | undefined {
  const n = normalizeText(s);
  if (!n) return undefined;
  const direct = n.replace(/ /g, '_');
  if (['equity', 'etf', 'fund', 'reit', 'bond', 'fixed_income', 'cash', 'crypto', 'commodity', 'other'].includes(direct)) {
    return direct as AssetClass;
  }
  for (const [re, ac] of ASSET_CLASS_WORDS) if (re.test(n)) return ac;
  return undefined;
}

const CASH_TYPES = new Set<TransactionType>(['DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'INTEREST', 'FX_CONVERSION']);

export interface GenericParseOptions {
  numberHint?: NumberFormat;
  /** Do not consider these values as instruments (e.g. cash pseudo-tickers). */
  cashSymbols?: string[];
}

export function parseWithMapping(table: RawTable, ctx: ParseContext, mapping: ColumnMapping, gopts: GenericParseOptions = {}): ParsedRow[] {
  const headerRow = mapping.headerRow ?? findHeaderRow(table);
  const one = (f: MappingField): number | undefined => {
    const v = mapping.columns[f];
    return Array.isArray(v) ? v[0] : v;
  };
  const many = (f: MappingField): number[] => {
    const v = mapping.columns[f];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  };
  const c = {
    date: one('date'), type: one('type'), symbol: one('symbol'), isin: one('isin'), name: one('name'),
    quantity: one('quantity'), price: one('price'), amount: one('amount'), netAmount: one('netAmount'),
    fees: many('fees'), taxes: many('taxes'), currency: one('currency'), exchange: one('exchange'),
    account: one('account'), note: one('note'), ratio: one('ratio'), assetClass: one('assetClass'),
    instrumentId: one('instrumentId'), toCurrency: one('toCurrency'), toAmount: one('toAmount'),
    fxRateToBase: one('fxRateToBase'),
  };
  const first = headerRow + 1;
  if (mapping.dateFormat) ctx.dateFormat = mapping.dateFormat;
  else ctx.initDates(columnValues(table, first, c.date), 'DMY');
  if (mapping.numberFormat) ctx.numberFormat = mapping.numberFormat;
  else {
    ctx.initNumbers(
      gopts.numberHint ?? 'dot',
      columnValues(table, first, c.quantity, c.price, c.amount, c.netAmount, c.toAmount, c.ratio, c.fxRateToBase, ...c.fees, ...c.taxes),
    );
  }
  const cashSymbols = new Set((gopts.cashSymbols ?? []).map((s) => s.toUpperCase()));
  const out: ParsedRow[] = [];
  for (let r = first; r < table.rows.length; r++) {
    const raw = table.rows[r]!;
    if (isBlankRow(raw)) continue;
    const row = ctx.newRow(r, raw);
    out.push(row);
    const firstText = raw.map((x) => cellToString(x)).find((s) => s !== '') ?? '';
    if (TOTAL_ROW_RE.test(firstText) && !/^\d/.test(cellToString(cell(raw, c.date)))) {
      ctx.skip(row, 'SKIPPED_TOTAL');
      continue;
    }
    const numericCols = [c.quantity, c.price, c.amount, c.netAmount, ...c.fees, ...c.taxes];
    const hasNumbers = numericCols.some((i) => i !== undefined && /\d/.test(str(raw, i)));
    const dateCell = cell(raw, c.date);
    if (cellToString(dateCell) === '' && !hasNumbers) {
      row.skipped = true; // section titles / spacer rows
      continue;
    }
    const date = ctx.date(dateCell, row);

    const typeText = str(raw, c.type);
    let type: TransactionType | undefined = typeText ? classifyType(typeText, mapping.typeValues) : undefined;
    if (typeText && !type) {
      row.issues.push(ctx.issue('UNKNOWN_TYPE', 'error', { value: typeText }, row.line, 'type'));
    }
    const quantity = ctx.num(cell(raw, c.quantity), row, 'quantity');
    const price = ctx.num(cell(raw, c.price), row, 'price');
    const amount = ctx.num(cell(raw, c.amount), row, 'amount');
    const net = ctx.num(cell(raw, c.netAmount), row, 'netAmount');
    const fees = sum(...c.fees.map((i) => ctx.num(cell(raw, i), row, 'fees')).map((n) => (n === undefined ? n : Math.abs(n))));
    const taxes = sum(...c.taxes.map((i) => ctx.num(cell(raw, i), row, 'taxes')).map((n) => (n === undefined ? n : Math.abs(n))));
    const ratio = ctx.num(cell(raw, c.ratio), row, 'ratio');
    const toAmount = ctx.num(cell(raw, c.toAmount), row, 'toAmount');
    const fxRate = ctx.num(cell(raw, c.fxRateToBase), row, 'fxRateToBase');

    let symbol = str(raw, c.symbol);
    if (cashSymbols.has(symbol.toUpperCase())) symbol = '';
    const isin = str(raw, c.isin).toUpperCase();
    const name = str(raw, c.name);
    const instrumentId = str(raw, c.instrumentId);

    if (!type && !typeText) {
      if (mapping.defaultType) type = mapping.defaultType;
      else if (quantity !== undefined && quantity !== 0 && (symbol || isin)) type = quantity > 0 ? 'BUY' : 'SELL';
      else if ((amount ?? net) !== undefined) type = (amount ?? net)! >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
      else row.issues.push(ctx.issue('MISSING_FIELD', 'error', { field: 'type' }, row.line, 'type'));
    }
    if (!date || !type || row.issues.some((i) => i.severity === 'error')) continue;
    if (!VALID_TYPES.includes(type)) continue;

    let currency = str(raw, c.currency).toUpperCase();
    if (currency && !isCurrencyCode(currency)) {
      row.issues.push(ctx.issue('INVALID_CURRENCY', 'error', { value: currency }, row.line, 'currency'));
      continue;
    }
    if (!currency) currency = mapping.defaultCurrency ?? '';

    const draft: DraftTransaction = { date, type, currency };
    const hasIdent = !!(symbol || isin || instrumentId);
    if (hasIdent || (name && !CASH_TYPES.has(type))) {
      const hint: InstrumentHint = {};
      if (instrumentId) hint.id = instrumentId;
      if (symbol) hint.symbol = symbol;
      if (isin) hint.isin = isin;
      if (name) hint.name = name;
      const ex = str(raw, c.exchange) || mapping.defaultExchange;
      if (ex) hint.exchange = ex;
      if (currency) hint.currency = currency;
      const ac = assetClassFromText(str(raw, c.assetClass));
      if (ac) hint.assetClass = ac;
      draft.instrument = hint;
    }
    if (quantity !== undefined) draft.quantity = Math.abs(quantity);
    if (price !== undefined) draft.price = Math.abs(price);
    let gross = amount !== undefined ? Math.abs(amount) : undefined;
    if (gross === undefined && net !== undefined) {
      const n = Math.abs(net);
      if (type === 'BUY') gross = n - (fees ?? 0) - (taxes ?? 0);
      else if (type === 'SELL') gross = n + (fees ?? 0) + (taxes ?? 0);
      else if (type === 'DIVIDEND' || type === 'INTEREST') gross = n + (taxes ?? 0);
      else gross = n;
    }
    // Standalone TAX / FEE rows: the value may sit in the tax/fee column instead of the amount column.
    if (type === 'TAX' && taxes) {
      if (gross === undefined || amount === undefined) gross = taxes;
    } else if (type === 'FEE' && fees) {
      if (gross === undefined || amount === undefined) gross = fees;
    } else {
      if (fees) draft.fees = fees;
      if (taxes) draft.taxes = taxes;
    }
    if (gross !== undefined) draft.amount = gross;
    if (ratio !== undefined && ratio !== 0) draft.ratio = Math.abs(ratio);
    if ((type === 'SPLIT' || type === 'STOCK_DIVIDEND') && draft.ratio === undefined && quantity !== undefined) {
      const reverse = /grupamento|agrupamiento|reverse|contrasplit|inplit|grupamiento/.test(normalizeText(typeText));
      draft.deltaShares = reverse ? -Math.abs(quantity) : quantity;
    }
    const toCurrency = str(raw, c.toCurrency).toUpperCase();
    if (toCurrency) draft.toCurrency = toCurrency;
    if (toAmount !== undefined) draft.toAmount = Math.abs(toAmount);
    if (fxRate !== undefined && fxRate > 0) draft.fxRateToBase = fxRate;
    const note = str(raw, c.note);
    if (note) draft.note = note;
    const account = str(raw, c.account);
    if (account) draft.account = account;
    row.draft = draft;
  }
  return out;
}

export const genericPreset: PresetDefinition = {
  id: 'generic',
  label: 'Genérico (mapeo de columnas)',
  broker: 'Cualquiera',
  country: 'INTL',
  fileKinds: ['csv', 'xlsx', 'html'],
  confidence: 'medium',
  description: 'Cualquier CSV/Excel con una fila por movimiento; las columnas se asignan automáticamente por nombre (es/pt/en) y se pueden corregir.',
  exportHelp: 'Exporta tus movimientos a Excel o CSV y revisa el mapeo sugerido de columnas.',
  detect: () => 0,
  parse(table, ctx) {
    const mapping = ctx.options.mapping;
    if (!mapping) return [];
    return parseWithMapping(table, ctx, mapping);
  },
};
