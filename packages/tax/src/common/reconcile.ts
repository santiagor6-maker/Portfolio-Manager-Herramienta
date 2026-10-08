import { parseLocaleNumber } from './basis';
import { parseCsv } from './xlsx';
import type { CsvCell } from './csv';

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
  return officialDocRowsFromTable(parseCsv(text, delimiter, decimal));
}

const H = (s: unknown) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/**
 * Header-mapped rows from any table (CSV or XLSX sheet). Accepts our own headers and the column
 * names used by B3 (Área do Investidor) and DIAN (exógena) exports. The header row may not be the first.
 */
export function officialDocRowsFromTable(rows: CsvCell[][]): OfficialDocRow[] {
  const syn = {
    tipo: ['tipo', 'concepto', 'type', 'movimentacao', 'tipo de evento', 'evento'],
    ticker: ['ticker', 'emisor', 'ativo', 'activo', 'symbol', 'codigo de negociacao', 'produto'],
    id: ['cnpj', 'nit', 'cnpj_empresa', 'id', 'cnpj da empresa', 'nit informante', 'nit del informante', 'numero de identificacion'],
    nome: ['nome', 'nombre', 'empresa', 'name', 'razon social', 'razao social', 'instituicao'],
    valor: ['valor', 'value', 'monto', 'bruto', 'valor da operacao', 'valor liquido', 'valor atualizado', 'valor reportado'],
    imposto: ['irrf', 'retencion', 'imposto', 'tax', 'ir', 'valor retenido'],
    quantidade: ['quantidade', 'cantidad', 'quantity'],
    codigo: ['codigo', 'code'],
    periodo: ['periodo', 'mes', 'month', 'data'],
  } as const;
  const headerIdx = rows.findIndex((r) => r.some((c) => (syn.valor as readonly string[]).includes(H(c)) || (syn.quantidade as readonly string[]).includes(H(c))));
  if (headerIdx < 0) return [];
  const header = rows[headerIdx]!.map(H);
  const col = (names: readonly string[]) => header.findIndex((h) => names.includes(h));
  const c = {
    tipo: col(syn.tipo),
    ticker: col(syn.ticker),
    id: col(syn.id),
    nome: col(syn.nome),
    valor: col(syn.valor),
    imposto: col(syn.imposto),
    quantidade: col(syn.quantidade),
    codigo: col(syn.codigo),
    periodo: col(syn.periodo),
  };
  // Locale-aware: '1,234.56' and '1.234,56' are both 1234.56 (T41).
  const num = (v: unknown) =>
    typeof v === 'number' ? v : v === undefined || v === '' || v === '-' ? undefined : parseLocaleNumber(String(v).replace(/^R\$|^\$|^COP|^USD/i, '').trim());
  const str = (i: number, r: CsvCell[]) => (i >= 0 && r[i] !== undefined && r[i] !== '' && r[i] !== null ? String(r[i]) : undefined);
  /** Dates: Excel serial numbers (base 1899-12-30) become ISO dates (T51). */
  const date = (i: number, r: CsvCell[]) => {
    const v = i >= 0 ? r[i] : undefined;
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{5}(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined;
    if (n !== undefined && n > 20000 && n < 80000) return excelSerialToIso(n);
    return str(i, r);
  };
  return rows
    .slice(headerIdx + 1)
    .filter((r) => r.some((x) => x !== '' && x !== undefined && x !== null))
    .map((r) => ({
      tipo: str(c.tipo, r) ?? '',
      ticker: str(c.ticker, r),
      id: str(c.id, r),
      nome: str(c.nome, r),
      valor: num(c.valor >= 0 ? r[c.valor] : undefined) ?? 0,
      imposto: num(c.imposto >= 0 ? r[c.imposto] : undefined),
      quantidade: num(c.quantidade >= 0 ? r[c.quantidade] : undefined),
      codigo: str(c.codigo, r),
      periodo: date(c.periodo, r),
    }));
}

/** Excel serial date (1900 date system, base 1899-12-30) → ISO date. */
export function excelSerialToIso(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}
