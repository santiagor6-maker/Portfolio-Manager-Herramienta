/**
 * Column-mapping suggestions from header names in Spanish, Portuguese and English.
 * Exported for the UI mapping editor (`suggestMapping`) and used by the generic importer.
 */
import type { Cell, ColumnMapping, FieldSuggestion, MappingField, MappingSuggestion, RawTable } from './types';
import { MULTI_COLUMN_FIELDS } from './types';
import { cellToString, normalizeText } from './util';

/** Normalized synonyms per field (see `normalizeText`). Earlier entries are not more important; exact > partial. */
export const FIELD_SYNONYMS: Record<MappingField, string[]> = {
  date: [
    'fecha', 'fecha operacion', 'fecha de operacion', 'fecha transaccion', 'fecha de transaccion', 'fecha negociacion',
    'fecha de negociacion', 'fecha movimiento', 'fecha de cumplimiento', 'data', 'data do negocio', 'data da operacao',
    'data pregao', 'data do pregao', 'data de negociacao', 'date', 'trade date', 'transaction date', 'tradedate', 'dia',
    'time', 'fecha y hora', 'date time', 'datetime',
  ],
  type: [
    'tipo', 'tipo de operacion', 'operacion', 'tipo operacion', 'movimiento', 'tipo de movimiento', 'concepto',
    'transaccion', 'tipo de transaccion', 'tipo de movimentacao', 'operacao', 'tipo de operacao', 'movimentacao',
    'c v', 'compra venta', 'compra venda', 'type', 'action', 'transaction type', 'side', 'buy sell', 'natureza',
    'naturaleza', 'clase de operacion', 'transaction', 'activity', 'descripcion operacion',
  ],
  symbol: [
    'ticker', 'simbolo', 'symbol', 'nemotecnico', 'nemo', 'especie', 'activo', 'ativo', 'codigo', 'codigo de negociacao',
    'codigo do ativo', 'codigo de negociacion', 'instrumento', 'instrument', 'titulo', 'accion', 'papel', 'stock',
    'security', 'emisora', 'ticker symbol', 'cod', 'codigo ativo',
  ],
  isin: ['isin', 'codigo isin', 'isin code'],
  name: [
    'nombre', 'descripcion', 'description', 'name', 'nome', 'produto', 'product', 'producto', 'empresa',
    'security name', 'razon social', 'emisor', 'especificacao do titulo', 'nombre del activo', 'security description',
  ],
  quantity: [
    'cantidad', 'quantidade', 'qty', 'quantity', 'shares', 'acciones', 'titulos', 'unidades', 'units', 'no of shares',
    'nominal', 'cantidad de titulos', 'numero de acciones', 'qtd', 'qtde', 'cant', 'cantidad acciones', 'num acciones',
  ],
  price: [
    'precio', 'preco', 'price', 'precio unitario', 'preco unitario', 'valor unitario', 'unit price', 'precio por accion',
    't price', 'trade price', 'cotizacion', 'cotacao', 'price share', 'precio de compra', 'precio ejecucion',
    'preco ajuste', 'preco medio', 'precio promedio', 'pu', 'tradeprice',
  ],
  amount: [
    'valor', 'monto', 'importe', 'total', 'amount', 'valor bruto', 'valor total', 'valor da operacao', 'valor operacion',
    'monto bruto', 'gross amount', 'proceeds', 'valor de la operacion', 'valor transaccion', 'valor operacao',
    'importe bruto', 'valor operacao ajuste', 'monto operacion', 'valor de compra',
  ],
  netAmount: [
    'valor neto', 'neto', 'monto neto', 'net amount', 'valor liquido', 'net cash', 'total neto', 'importe neto',
    'liquido', 'netcash', 'valor a pagar', 'total a pagar',
  ],
  fees: [
    'comision', 'comisiones', 'comissao', 'corretagem', 'taxa', 'taxas', 'tarifa', 'fee', 'fees', 'commission', 'comm',
    'fees comm', 'iva', 'iva comision', 'emolumentos', 'taxa de liquidacao', 'costos', 'custos', 'gastos', 'comm fee',
    'transaction fees', 'ibcommission', 'costes de transaccion', 'comision bolsa', 'derechos de bolsa', 'otros costos',
  ],
  taxes: [
    'impuesto', 'impuestos', 'retencion', 'retencion en la fuente', 'gmf', '4x1000', 'imposto', 'irrf', 'iof', 'tax',
    'taxes', 'withholding', 'withholding tax', 'impuesto retenido', 'rete fuente', 'retefuente',
  ],
  currency: ['moneda', 'divisa', 'moeda', 'currency', 'ccy', 'currencyprimary', 'moneda de la operacion'],
  exchange: ['bolsa', 'exchange', 'venue', 'listing exchange', 'bolsa de referencia', 'listingexchange', 'mercado bolsa'],
  account: ['cuenta', 'conta', 'account', 'broker', 'corredor', 'comisionista', 'instituicao', 'institucion', 'corretora'],
  note: ['nota', 'observacion', 'observaciones', 'notes', 'note', 'comentario', 'comentarios', 'memo', 'detalle'],
  ratio: ['ratio', 'proporcion', 'factor', 'proporcao', 'split ratio'],
  assetClass: ['tipo de activo', 'clase de activo', 'asset class', 'categoria', 'tipo de ativo', 'asset type', 'assetclass'],
  instrumentId: ['instrument id', 'instrument_id', 'id activo', 'instrumentid'],
  toCurrency: ['to currency', 'moneda destino', 'moeda destino'],
  toAmount: ['to amount', 'monto destino', 'valor destino'],
  fxRateToBase: ['fx rate to base', 'tipo de cambio', 'tasa de cambio', 'taxa de cambio', 'exchange rate', 'trm', 'fx rate', 'fxratetobase'],
};

/** Fields that must be present to import anything. */
export const REQUIRED_FIELDS: MappingField[] = ['date'];

function scoreHeader(h: string, syn: string): number {
  if (!h) return 0;
  if (h === syn) return 1;
  const hw = ` ${h} `;
  if (hw.includes(` ${syn} `)) return 0.55 + 0.35 * (syn.length / h.length);
  return 0;
}

export function scoreHeaderForField(header: string, field: MappingField): number {
  const h = normalizeText(header);
  let best = 0;
  for (const syn of FIELD_SYNONYMS[field]) best = Math.max(best, scoreHeader(h, syn));
  return best;
}

/** How many cells in a row look like known headers (used to find the header row below preambles). */
export function headerRowScore(row: Cell[]): number {
  let score = 0;
  const seen = new Set<MappingField>();
  for (const c of row) {
    const s = cellToString(c);
    if (!s || s.length > 60 || /^-?[\d.,]+$/.test(s)) continue;
    let bestField: MappingField | undefined;
    let best = 0;
    for (const f of Object.keys(FIELD_SYNONYMS) as MappingField[]) {
      const sc = scoreHeaderForField(s, f);
      if (sc > best) [best, bestField] = [sc, f];
    }
    if (bestField && best >= 0.55 && !seen.has(bestField)) {
      seen.add(bestField);
      score += best;
    }
  }
  return score;
}

/** Index of the most header-like row among the first 30 rows. */
export function findHeaderRow(table: RawTable, maxScan = 30): number {
  let best = 0;
  let bestScore = -1;
  const n = Math.min(table.rows.length, maxScan);
  for (let i = 0; i < n; i++) {
    const sc = headerRowScore(table.rows[i]!);
    if (sc > bestScore + 0.25) {
      bestScore = sc;
      best = i;
    }
  }
  return best;
}

export function suggestMappingFromHeaders(headers: string[]): Omit<MappingSuggestion, 'headerRow' | 'sample'> {
  const candidates: FieldSuggestion[] = [];
  headers.forEach((header, column) => {
    for (const field of Object.keys(FIELD_SYNONYMS) as MappingField[]) {
      const score = scoreHeaderForField(header, field);
      if (score >= 0.55) candidates.push({ field, column, header, score });
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.column - b.column);
  const usedCols = new Set<number>();
  const usedFields = new Set<MappingField>();
  const chosen: FieldSuggestion[] = [];
  for (const c of candidates) {
    if (usedCols.has(c.column)) continue;
    const multi = MULTI_COLUMN_FIELDS.includes(c.field);
    if (!multi && usedFields.has(c.field)) continue;
    usedCols.add(c.column);
    usedFields.add(c.field);
    chosen.push(c);
  }
  const columns: ColumnMapping['columns'] = {};
  for (const c of chosen.sort((a, b) => a.column - b.column)) {
    if (MULTI_COLUMN_FIELDS.includes(c.field)) {
      const prev = columns[c.field];
      columns[c.field] = [...(Array.isArray(prev) ? prev : prev !== undefined ? [prev] : []), c.column];
    } else columns[c.field] = c.column;
  }
  const missing: MappingField[] = [];
  if (columns.date === undefined) missing.push('date');
  if (columns.type === undefined && columns.quantity === undefined && columns.amount === undefined && columns.netAmount === undefined) {
    missing.push('type');
  }
  if (columns.quantity === undefined && columns.amount === undefined && columns.netAmount === undefined) missing.push('quantity');
  return {
    headers,
    mapping: { columns },
    fields: chosen,
    unmapped: headers.map((header, column) => ({ column, header })).filter((u) => !usedCols.has(u.column) && u.header !== ''),
    missing,
  };
}

/** Suggest a mapping for a table: finds the header row (skipping preambles) and maps columns by name. */
export function suggestMapping(table: RawTable): MappingSuggestion {
  const headerRow = findHeaderRow(table);
  const headers = (table.rows[headerRow] ?? []).map((c) => cellToString(c));
  const base = suggestMappingFromHeaders(headers);
  return {
    ...base,
    headerRow,
    mapping: { ...base.mapping, headerRow },
    sample: table.rows.slice(headerRow + 1, headerRow + 6).map((r) => r.map((c) => cellToString(c))),
  };
}
