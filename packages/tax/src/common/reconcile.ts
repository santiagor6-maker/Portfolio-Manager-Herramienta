import { parseCsv } from './xlsx';

export type ReconStatus = 'ok' | 'diferente' | 'falta_no_portfolio' | 'falta_no_documento';

/** One reconciliation line: our computed figure vs. the official document. */
export interface ReconLine {
  area: string;
  key: string;
  label: string;
  ours?: number;
  theirs?: number;
  diff?: number;
  status: ReconStatus;
  note?: string;
}

export interface ReconValue {
  label: string;
  value: number;
}

/** Diff two keyed value maps with an absolute/relative tolerance. */
export function reconcileMaps(
  area: string,
  ours: Map<string, ReconValue>,
  theirs: Map<string, ReconValue>,
  tolerance = { abs: 1, rel: 0.005 },
): ReconLine[] {
  const out: ReconLine[] = [];
  for (const key of new Set([...ours.keys(), ...theirs.keys()])) {
    const o = ours.get(key);
    const t = theirs.get(key);
    const label = o?.label ?? t?.label ?? key;
    if (o && !t) {
      if (Math.abs(o.value) > tolerance.abs) out.push({ area, key, label, ours: o.value, status: 'falta_no_documento' });
      continue;
    }
    if (!o && t) {
      if (Math.abs(t.value) > tolerance.abs) out.push({ area, key, label, theirs: t.value, status: 'falta_no_portfolio' });
      continue;
    }
    const diff = o!.value - t!.value;
    const ok = Math.abs(diff) <= Math.max(tolerance.abs, Math.abs(t!.value) * tolerance.rel);
    out.push({ area, key, label, ours: o!.value, theirs: t!.value, diff, status: ok ? 'ok' : 'diferente' });
  }
  return out.sort((a, b) => a.area.localeCompare(b.area) || a.key.localeCompare(b.key));
}

export function addTo(map: Map<string, ReconValue>, key: string, label: string, value: number): void {
  const cur = map.get(key);
  map.set(key, { label: cur?.label ?? label, value: (cur?.value ?? 0) + value });
}

/**
 * Generic CSV for official documents typed or exported by the user/importer, with a header row
 * using any of: tipo/concepto, ticker/emisor, cnpj/nit, valor, irrf/retencion, quantidade/cantidad, codigo, periodo.
 */
export interface OfficialDocRow {
  tipo: string;
  ticker?: string;
  id?: string;
  nome?: string;
  valor: number;
  imposto?: number;
  quantidade?: number;
  codigo?: string;
  periodo?: string;
}

export function parseOfficialDocCsv(text: string, delimiter = ';', decimal: '.' | ',' = ','): OfficialDocRow[] {
  const rows = parseCsv(text, delimiter, decimal);
  const header = (rows[0] ?? []).map((h) => String(h ?? '').trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const c = {
    tipo: col('tipo', 'concepto', 'type'),
    ticker: col('ticker', 'emisor', 'ativo', 'activo', 'symbol'),
    id: col('cnpj', 'nit', 'cnpj_empresa', 'id'),
    nome: col('nome', 'nombre', 'empresa', 'name'),
    valor: col('valor', 'value', 'monto', 'bruto'),
    imposto: col('irrf', 'retencion', 'retención', 'imposto', 'tax'),
    quantidade: col('quantidade', 'cantidad', 'quantity'),
    codigo: col('codigo', 'código', 'code'),
    periodo: col('periodo', 'período', 'mes', 'month'),
  };
  const num = (v: unknown) => (typeof v === 'number' ? v : v === undefined || v === '' ? undefined : Number(String(v).replace(/\./g, '').replace(',', '.')));
  const str = (i: number, r: unknown[]) => (i >= 0 && r[i] !== undefined && r[i] !== '' ? String(r[i]) : undefined);
  return rows
    .slice(1)
    .filter((r) => r.some((x) => x !== '' && x !== undefined))
    .map((r) => ({
      tipo: str(c.tipo, r) ?? '',
      ticker: str(c.ticker, r),
      id: str(c.id, r),
      nome: str(c.nome, r),
      valor: num(c.valor >= 0 ? r[c.valor] : undefined) ?? 0,
      imposto: num(c.imposto >= 0 ? r[c.imposto] : undefined),
      quantidade: num(c.quantidade >= 0 ? r[c.quantidade] : undefined),
      codigo: str(c.codigo, r),
      periodo: str(c.periodo, r),
    }));
}
