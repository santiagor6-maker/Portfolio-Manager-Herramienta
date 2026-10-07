import { addTo, reconcileMaps, type OfficialDocRow, type ReconLine, type ReconValue } from '../common/reconcile';
import type { TaxIssue } from '../common/types';
import type { ColombiaTaxReport } from './report';

/**
 * Información exógena reported by third parties to the DIAN (comisionistas, bancos, emisores),
 * visible to the taxpayer on the DIAN portal ("Consulta información exógena").
 */
export interface CoExogenaItem {
  nitInformante: string;
  nombreInformante: string;
  concepto: 'dividendos' | 'intereses' | 'retencion' | 'enajenacion' | 'saldo_inversiones';
  valor: number;
  retencion?: number;
  /** Ticker or issuer when the item is per security. */
  detalle?: string;
}

/** Certificates: dividend/withholding certificates from issuers and Deceval holdings at Dec 31. */
export interface CoCertificado {
  tipo: 'dividendos' | 'retencion' | 'deceval';
  emisor: string;
  valor: number;
  retencion?: number;
  cantidad?: number;
}

export interface CoReconciliation {
  lines: ReconLine[];
  summary: { ok: number; diferente: number; faltaNoPortfolio: number; faltaNoDocumento: number };
  issues: TaxIssue[];
}

/** Maps DIAN exógena concept descriptions (or our short codes) to reconciliation concepts. */
export function exogenaConcept(tipo: string): CoExogenaItem['concepto'] | undefined {
  const t = tipo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/dividend|participacion/.test(t)) return 'dividendos';
  if (/retenc/.test(t)) return 'retencion';
  if (/interes|rendimiento/.test(t)) return 'intereses';
  if (/enajenac|venta de acciones|venta_de_acciones/.test(t)) return 'enajenacion';
  if (/saldo.*invers|inversion|portafolio|acciones|titulos/.test(t)) return 'saldo_inversiones';
  return undefined;
}

export function exogenaFromRows(rows: OfficialDocRow[]): CoExogenaItem[] {
  return rows
    .map((r) => ({ ...r, concepto: exogenaConcept(r.tipo) }))
    .filter((r): r is typeof r & { concepto: CoExogenaItem['concepto'] } => r.concepto !== undefined)
    .map((r) => ({
      nitInformante: r.id ?? '',
      nombreInformante: r.nome ?? '',
      concepto: r.concepto,
      valor: r.valor,
      retencion: r.imposto,
      detalle: r.ticker,
    }));
}

/**
 * Reconciles the Colombian report with the DIAN exógena and certificates: national dividends and
 * withholding, interest, gross proceeds of share sales (the comisionista reports gross sales, which
 * is why Art. 36-1 sales must be declared as income + INCRNGO), and Deceval holdings at Dec 31.
 */
export function reconcileColombia(report: ColombiaTaxReport, docs: { exogena?: CoExogenaItem[]; certificados?: CoCertificado[] }): CoReconciliation {
  const lines: ReconLine[] = [];
  const ex = docs.exogena ?? [];
  const certs = docs.certificados ?? [];
  const t = report.ingresos.totals;
  const sumEx = (c: CoExogenaItem['concepto']) => ex.filter((x) => x.concepto === c).reduce((a, x) => a + x.valor, 0);
  const has = (c: CoExogenaItem['concepto']) => ex.some((x) => x.concepto === c);

  const ours = new Map<string, ReconValue>();
  const theirs = new Map<string, ReconValue>();
  if (has('dividendos')) {
    addTo(ours, 'dividendos', 'Dividendos nacionales', t.nationalDividendsCop);
    addTo(theirs, 'dividendos', 'Dividendos nacionales', sumEx('dividendos'));
  }
  if (has('intereses')) {
    addTo(ours, 'intereses', 'Intereses', t.nationalInterestCop);
    addTo(theirs, 'intereses', 'Intereses', sumEx('intereses'));
  }
  if (has('retencion') || ex.some((x) => x.retencion !== undefined)) {
    addTo(ours, 'retencion', 'Retenciones en la fuente', t.nationalDividendWithholdingCop + t.interestWithholdingCop);
    addTo(theirs, 'retencion', 'Retenciones en la fuente', sumEx('retencion') + ex.reduce((a, x) => a + (x.retencion ?? 0), 0));
  }
  if (has('enajenacion')) {
    const national = report.ventas.rows.filter((r) => r.currency === 'COP' && r.classification !== 'pendiente_costo');
    addTo(ours, 'enajenacion', 'Ventas brutas de acciones (comisionistas)', national.reduce((a, r) => a + r.proceedsCop, 0));
    addTo(theirs, 'enajenacion', 'Ventas brutas de acciones (comisionistas)', sumEx('enajenacion'));
  }
  lines.push(...reconcileMaps('exogena', ours, theirs, { abs: 1000, rel: 0.005 }));

  // Dividends per issuer (certificates)
  const dO = new Map<string, ReconValue>();
  const dT = new Map<string, ReconValue>();
  for (const c of certs.filter((x) => x.tipo === 'dividendos')) {
    addTo(dT, c.emisor.toUpperCase(), `Dividendos ${c.emisor}`, c.valor);
    if (c.retencion !== undefined) addTo(dT, `RET|${c.emisor.toUpperCase()}`, `Retención ${c.emisor}`, c.retencion);
  }
  if (dT.size) {
    for (const d of report.ingresos.dividends.filter((x) => x.source === 'nacional')) {
      addTo(dO, (d.symbol ?? '').toUpperCase(), `Dividendos ${d.symbol}`, d.grossCop);
      if ([...dT.keys()].some((k) => k === `RET|${(d.symbol ?? '').toUpperCase()}`)) addTo(dO, `RET|${(d.symbol ?? '').toUpperCase()}`, `Retención ${d.symbol}`, d.withheldCop);
    }
    lines.push(...reconcileMaps('certificados_dividendos', dO, dT, { abs: 1000, rel: 0.005 }));
  }

  // Deceval holdings at Dec 31
  const hT = new Map<string, ReconValue>();
  for (const c of certs.filter((x) => x.tipo === 'deceval')) addTo(hT, c.emisor.toUpperCase(), `Acciones ${c.emisor} (Deceval)`, c.cantidad ?? 0);
  if (hT.size) {
    const hO = new Map<string, ReconValue>();
    for (const r of report.patrimonio.rows) if (r.kind === 'inversion' && !r.abroad) addTo(hO, (r.symbol ?? '').toUpperCase(), `Acciones ${r.symbol}`, r.quantity);
    lines.push(...reconcileMaps('deceval_31_dic', hO, hT, { abs: 1e-6, rel: 0 }));
  }

  const count = (s: ReconLine['status']) => lines.filter((l) => l.status === s).length;
  const summary = { ok: count('ok'), diferente: count('diferente'), faltaNoPortfolio: count('falta_no_portfolio'), faltaNoDocumento: count('falta_no_documento') };
  const issues: TaxIssue[] = [];
  if (summary.diferente + summary.faltaNoPortfolio + summary.faltaNoDocumento > 0) {
    issues.push({
      level: 'warning',
      code: 'RECONCILIATION_DIFFERENCES',
      message: `Conciliación: ${summary.diferente} diferencias, ${summary.faltaNoPortfolio} ítems faltantes en el portafolio y ${summary.faltaNoDocumento} sin soporte en los documentos.`,
    });
  }
  return { lines, summary, issues };
}
