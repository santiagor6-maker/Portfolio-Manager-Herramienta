/**
 * "Extracto colombiano": generic preset for Colombian brokerage statements exported to Excel/CSV
 * (Davivienda Corredores, Acciones & Valores, Credicorp Capital, Casa de Bolsa, Trii, tyba...).
 * Colombian brokers do not publish a stable CSV layout (most statements are PDFs), so this preset is
 * the generic mapper with Colombian defaults: Spanish headers (Fecha, Operación/Concepto, Especie/
 * Nemotécnico, Cantidad/Títulos, Precio, Valor bruto/neto, Comisión, IVA, Retención, GMF), BVC as the
 * default market, COP as default currency, DD/MM/AAAA dates and `1.234,56` numbers unless detected otherwise.
 */
import { findHeaderRow, suggestMappingFromHeaders } from '../mapping';
import type { RawTable } from '../types';
import { cellToString, normalizeText } from '../util';
import { type PresetDefinition } from './common';
import { parseWithMapping } from './generic';

function headerInfo(table: RawTable): { index: number; norm: string[]; raw: string[] } {
  const index = findHeaderRow(table);
  const raw = (table.rows[index] ?? []).map((c) => cellToString(c));
  return { index, raw, norm: raw.map((h) => normalizeText(h)) };
}

const has = (norm: string[], re: RegExp) => norm.some((h) => re.test(h));

export const extractoColombianoPreset: PresetDefinition = {
  id: 'extracto-co',
  label: 'Extracto colombiano (genérico: Davivienda Corredores, Acciones & Valores, Trii, tyba...)',
  broker: 'Comisionistas de bolsa de Colombia',
  country: 'CO',
  fileKinds: ['csv', 'xlsx', 'html'],
  confidence: 'low',
  description: 'Extractos en Excel/CSV con encabezados en español (Especie/Nemotécnico, Cantidad, Precio, Comisión, IVA, Retención, GMF). Mercado BVC y pesos colombianos por defecto.',
  exportHelp: 'Descarga el extracto/movimientos de tu comisionista en Excel (si solo hay PDF, copia la tabla a Excel) y súbelo; revisa el mapeo de columnas sugerido.',
  detect(table) {
    const { norm } = headerInfo(table);
    const ticker = has(norm, /^(especie|nemotecnico|nemo|titulo|emisor)\b/);
    const date = has(norm, /^fecha/);
    const qty = has(norm, /^(cantidad|titulos|nominal|acciones|unidades)/);
    const costs = has(norm, /^(comision|iva|retencion|gmf|4x1000|valor neto|valor bruto)/);
    if (ticker && date && (qty || costs)) return 0.75;
    if (date && qty && costs) return 0.6;
    return 0;
  },
  parse(table, ctx) {
    const { index, raw } = headerInfo(table);
    const s = suggestMappingFromHeaders(raw);
    const mapping = { ...s.mapping, headerRow: index, defaultExchange: 'XBOG', defaultCurrency: ctx.options.defaultCurrency ?? 'COP' };
    if (ctx.options.mapping) Object.assign(mapping, ctx.options.mapping);
    return parseWithMapping(table, ctx, mapping, { numberHint: 'comma' });
  },
};
