/**
 * Generic importer driven by a user-editable column mapping (auto-suggested from es/pt/en headers).
 * Also the engine behind the canonical template, the Colombian statement preset, broker profiles
 * and PDF tables.
 */
import type { AssetClass, TransactionType } from '@pm/core';
import { findHeaderRow } from '../mapping';
import { exchangeCurrency } from '../markets';
import { isAmbiguousNumber, parseNumber, parseRatio } from '../numbers';
import { classifyTypeDetailed } from '../txtypes';
import type { ColumnMapping, DraftTransaction, InstrumentHint, MappingField, NumberFormat, ParsedRow, RawTable } from '../types';
import { cellToString, isBlankRow, isCurrencyCode, normalizeText } from '../util';
import { type ParseContext, type PresetDefinition, TOTAL_ROW_RE, cell, str, sum } from './common';

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
  /** Account label when the file has none (broker profiles). */
  account?: string;
  /** Formats known for this source: skip detection. */
  fixedDateFormat?: boolean;
  fixedNumberFormat?: boolean;
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
    fxRateToBase: one('fxRateToBase'), settleDate: one('settleDate'),
  };
  const first = headerRow + 1;
  if (mapping.dateFormat) ctx.dateFormat = mapping.dateFormat;
  else ctx.detectDates([c.date], first, 'DMY', { headerRow, settleCol: c.settleDate, fixed: gopts.fixedDateFormat });
  if (mapping.numberFormat) ctx.numberFormat = mapping.numberFormat;
  else {
    ctx.detectNumbers(
      [c.quantity, c.price, c.amount, c.netAmount, c.toAmount, c.fxRateToBase, ...c.fees, ...c.taxes],
      first,
      gopts.numberHint ?? 'dot',
      { headerRow, triple: { q: c.quantity, p: c.price, a: c.amount ?? c.netAmount }, fixed: gopts.fixedNumberFormat, symbolCol: c.symbol, dateCol: c.date },
    );
  }
  const cashSymbols = new Set((gopts.cashSymbols ?? []).map((s) => s.toUpperCase()));
  // Mixed-currency files (I3): the file-wide decimal separator was inferred, but a value like "1.725"
  // in a row whose currency differs from the dominant one can be a decimal (USD 1.725) or thousands.
  const fileFormat = ctx.numberFormat;
  const formatForced = !!(ctx.options.numberFormat || mapping.numberFormat);
  const ccyCount = new Map<string, number>();
  if (c.currency !== undefined) {
    for (let r = first; r < table.rows.length; r++) {
      const v = str(table.rows[r]!, c.currency).toUpperCase();
      if (isCurrencyCode(v)) ccyCount.set(v, (ccyCount.get(v) ?? 0) + 1);
    }
  }
  const dominant = [...ccyCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? mapping.defaultCurrency;
  const rowAmbiguous: { line: number; value: string }[] = [];

  // Sign convention of standalone FEE/TAX rows: "cash-flow" files show costs as negatives, so a
  // positive cost there is a refund. Decided per file by majority.
  let costNeg = 0;
  let costPos = 0;
  if (c.type !== undefined) {
    for (let r = first; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const cls = classifyTypeDetailed(str(raw, c.type), mapping.typeValues);
      if ((cls.type === 'FEE' || cls.type === 'TAX') && !cls.refund) {
        const dummy = { line: 0, issues: [] };
        const v = ctx.num(cell(raw, c.amount), dummy, 'amount') ?? ctx.num(cell(raw, c.netAmount), dummy, 'amount');
        if (v !== undefined) v < 0 ? costNeg++ : costPos++;
      }
    }
  }
  const cashFlowCosts = costNeg > costPos;

  // Does the file carry signs at all? Neutral words ("Traslado", "Liquidación", "Transferência") take
  // their direction from the sign; in a file without any negative value that direction is an assumption.
  const signCols = [c.quantity, c.amount, c.netAmount].filter((i): i is number => i !== undefined);
  let fileHasSigns = false;
  for (let r = first; r < table.rows.length && !fileHasSigns; r++) {
    const raw = table.rows[r]!;
    fileHasSigns = signCols.some((i) => {
      const v = cell(raw, i);
      if (typeof v === 'number') return v < 0;
      const t = cellToString(v).trim();
      return /^\(.*\d.*\)$|^[-−–]\s*[^\s]*\d|\d\s*-$|\d\s*(?:DR|D)$/i.test(t);
    });
  }

  const headerNorm = new Set((table.rows[headerRow] ?? []).map((x) => normalizeText(cellToString(x))).filter((x) => x !== ''));
  const out: ParsedRow[] = [];
  for (let r = first; r < table.rows.length; r++) {
    const raw = table.rows[r]!;
    if (isBlankRow(raw)) continue;
    const row = ctx.newRow(r, raw);
    out.push(row);
    // Header repeated on every page (PDF statements, concatenated exports).
    const filled = raw.map((x) => normalizeText(cellToString(x))).filter((x) => x !== '');
    if (filled.length >= 2 && filled.filter((x) => headerNorm.has(x)).length >= Math.ceil(filled.length * 0.6)) {
      row.skipped = true;
      continue;
    }
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

    // Per-row decimal separator (answer, reference price, or ask).
    ctx.numberFormat = ctx.options.rowNumberFormats?.[row.line] ?? fileFormat;
    const rowCcy = str(raw, c.currency).toUpperCase();
    if (!formatForced && !ctx.options.rowNumberFormats?.[row.line] && dominant && isCurrencyCode(rowCcy) && rowCcy !== dominant) {
      const amb = [c.quantity, c.price, c.amount, c.netAmount].map((i) => cell(raw, i)).find((v) => isAmbiguousNumber(v));
      if (amb !== undefined) {
        const ref = ctx.options.referencePrice && date ? ctx.options.referencePrice({ symbol: str(raw, c.symbol), currency: rowCcy }, date) : undefined;
        const pc = cell(raw, c.price);
        if (ref && isAmbiguousNumber(pc)) {
          const near = (f: 'dot' | 'comma') => {
            const v = parseNumber(pc, f);
            return v !== undefined && Math.abs(v - ref) <= 0.5 * ref;
          };
          if (near('dot') !== near('comma')) ctx.numberFormat = near('dot') ? 'dot' : 'comma';
        }
        if (!ref || ctx.numberFormat === fileFormat) {
          if (!ref) {
            row.pending = true;
            rowAmbiguous.push({ line: row.line, value: cellToString(amb) });
            row.issues.push(ctx.issue('ROW_NUMBER_AMBIGUOUS', 'warning', { value: cellToString(amb), currency: rowCcy }, row.line));
          }
        }
      }
    }

    const typeText = str(raw, c.type);
    const cls = typeText ? classifyTypeDetailed(typeText, mapping.typeValues) : { refund: false };
    let type: TransactionType | undefined = cls.type;
    const quantity = ctx.num(cell(raw, c.quantity), row, 'quantity');
    const price = ctx.num(cell(raw, c.price), row, 'price');
    const amount = ctx.num(cell(raw, c.amount), row, 'amount');
    const net = ctx.num(cell(raw, c.netAmount), row, 'netAmount');
    const fees = sum(...c.fees.map((i) => ctx.num(cell(raw, i), row, 'fees')).map((n) => (n === undefined ? n : Math.abs(n))));
    const taxes = sum(...c.taxes.map((i) => ctx.num(cell(raw, i), row, 'taxes')).map((n) => (n === undefined ? n : Math.abs(n))));
    const ratioCell = cell(raw, c.ratio);
    const ratio = parseRatio(ratioCell, ctx.numberFormat);
    if (ratio !== undefined && Number.isNaN(ratio)) {
      row.issues.push(ctx.issue('INVALID_NUMBER', 'error', { field: 'ratio', value: cellToString(ratioCell) }, row.line, 'ratio'));
    }
    const toAmount = ctx.num(cell(raw, c.toAmount), row, 'toAmount');
    const fxRate = ctx.num(cell(raw, c.fxRateToBase), row, 'fxRateToBase');

    let symbol = str(raw, c.symbol);
    if (cashSymbols.has(symbol.toUpperCase())) symbol = '';
    const isin = str(raw, c.isin).toUpperCase();
    const name = str(raw, c.name);
    const instrumentId = str(raw, c.instrumentId);
    const hasIdent = !!(symbol || isin || instrumentId);
    const signed = amount ?? net;

    // Direction from signs for neutral words ("Traslado", "Liquidación", "Ajuste") or missing type.
    if (!type && (cls.signBased || !typeText)) {
      const kind = cls.signBased;
      if (kind === 'fraction') type = quantity ? 'SELL' : 'RETURN_OF_CAPITAL';
      else if (!typeText && mapping.defaultType) type = mapping.defaultType;
      else if (quantity !== undefined && quantity !== 0 && hasIdent) {
        if (kind === 'transfer' && (signed === undefined || signed === 0)) type = quantity > 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT';
        else type = quantity > 0 ? 'BUY' : 'SELL';
      } else if (signed !== undefined && signed !== 0) type = signed > 0 ? 'DEPOSIT' : 'WITHDRAWAL';
      else row.issues.push(ctx.issue('MISSING_FIELD', 'error', { field: 'type' }, row.line, 'type'));
      if (type && kind && kind !== 'fraction' && !fileHasSigns) {
        row.issues.push(ctx.issue('DIRECTION_ASSUMED', 'warning', { value: typeText, type }, row.line, 'type'));
      }
    } else if (cls.type === 'SELL' && cls.signBased === undefined && /fracao|fraccion|cash in lieu|leilao/.test(normalizeText(typeText)) && !quantity) {
      type = 'RETURN_OF_CAPITAL';
    }
    if (typeText && !type && !row.issues.some((i) => i.code === 'MISSING_FIELD')) {
      row.issues.push(ctx.issue('UNKNOWN_TYPE', 'error', { value: typeText }, row.line, 'type'));
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
    if (hasIdent || (name && !CASH_TYPES.has(type))) {
      const hint: InstrumentHint = {};
      if (instrumentId) hint.id = instrumentId;
      if (symbol) hint.symbol = symbol;
      if (isin) hint.isin = isin;
      if (name) hint.name = name;
      // A default market (e.g. BVC for Colombian statements) only applies to rows in its currency.
      const defEx = mapping.defaultExchange && (!currency || exchangeCurrency(mapping.defaultExchange) === currency) ? mapping.defaultExchange : undefined;
      const ex = str(raw, c.exchange) || defEx;
      if (ex) hint.exchange = ex;
      if (currency) hint.currency = currency;
      const ac = assetClassFromText(str(raw, c.assetClass));
      if (ac) hint.assetClass = ac;
      draft.instrument = hint;
    }
    if (quantity !== undefined) {
      draft.quantity = Math.abs(quantity);
      const contradicts = (type === 'BUY' || type === 'TRANSFER_IN') ? quantity < 0 : (type === 'SELL' || type === 'TRANSFER_OUT') ? false : false;
      if (contradicts && !cls.signBased) row.issues.push(ctx.issue('QUANTITY_SIGN_CONTRADICTS', 'warning', { type }, row.line, 'quantity'));
    }
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
    // Signs: reversals and refunds are kept as negative amounts (TAX/FEE refund, dividend reversal).
    if (gross !== undefined) {
      if (type === 'FEE' || type === 'TAX') {
        const sv = signed ?? gross;
        let refund = cls.refund;
        if (!refund && signed !== undefined) refund = cashFlowCosts ? sv > 0 : sv < 0;
        if (refund) {
          gross = -Math.abs(gross);
          row.issues.push(ctx.issue('REFUND', 'info', undefined, row.line));
        }
      } else if (type === 'DIVIDEND' || type === 'INTEREST') {
        if ((signed !== undefined && signed < 0) || cls.refund) {
          gross = -Math.abs(gross);
          row.issues.push(ctx.issue('DIVIDEND_REVERSAL_ROW', 'warning', undefined, row.line));
        }
      }
      draft.amount = gross;
    }
    if (ratio !== undefined && ratio !== 0 && !Number.isNaN(ratio)) draft.ratio = Math.abs(ratio);
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
    const account = str(raw, c.account) || gopts.account;
    if (account) draft.account = account;
    row.draft = draft;
  }
  ctx.numberFormat = fileFormat;
  if (rowAmbiguous.length) {
    ctx.confirmations.push({
      kind: 'numberFormat',
      scope: 'rows',
      candidates: ['dot', 'comma'],
      suggested: 'dot',
      reason: `Filas en una moneda distinta de ${dominant}: confirma si el punto es decimal.`,
      samples: rowAmbiguous.slice(0, 5).map((x) => ({ line: x.line, value: x.value, readings: { dot: String(parseNumber(x.value, 'dot')), comma: String(parseNumber(x.value, 'comma')) } })),
      affectedLines: rowAmbiguous.map((x) => x.line),
    });
  }
  return out;
}

export const genericPreset: PresetDefinition = {
  id: 'generic',
  label: 'Genérico (mapeo de columnas)',
  broker: 'Cualquiera',
  country: 'INTL',
  fileKinds: ['csv', 'xlsx', 'html', 'pdf'],
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
