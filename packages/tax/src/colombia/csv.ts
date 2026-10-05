import { toCsv, type CsvCell, type CsvOptions } from '../common/csv';
import type { ColombiaTaxReport } from './report';

const HEADER = [
  'seccion',
  'concepto',
  'detalle',
  'fecha',
  'moneda_origen',
  'valor_origen',
  'trm',
  'valor_cop',
  'referencia_legal',
  'nota',
];

/**
 * "Para tu contador": one CSV with the lines an accountant needs to prepare the Formulario 210
 * (renta personas naturales) and evaluate the Formulario 160 (activos en el exterior).
 */
export function colombiaAccountantCsv(report: ColombiaTaxReport, opts?: CsvOptions): string {
  const rows: CsvCell[][] = [HEADER];
  const y = report.year;
  const push = (...r: CsvCell[]) => rows.push(r);

  push('INFO', `Año gravable ${y}`, 'Persona natural residente fiscal en Colombia', '', '', '', '', '', '', report.disclaimer.es);

  // Patrimonio
  for (const r of report.patrimonio.rows) {
    push(
      'PATRIMONIO',
      r.kind === 'inversion' ? 'Acciones y otras inversiones' : 'Efectivo / cuentas',
      r.kind === 'inversion' ? `${r.symbol ?? ''} ${r.name ?? ''} - ${r.quantity} unidades${r.abroad ? ' (exterior)' : ''}`.trim() : `Saldo ${r.currency}${r.abroad ? ' (exterior)' : ''}`,
      report.patrimonio.date,
      r.currency,
      r.costLocal,
      r.currency === 'COP' ? 1 : r.fiscalValueCop / (r.costLocal || 1),
      r.fiscalValueCop,
      r.legalBasis,
      r.marketValueCop !== undefined ? `Valor de mercado informativo a TRM 31-dic: ${r.marketValueCop.toFixed(0)} COP` : '',
    );
  }
  push('PATRIMONIO', 'Total patrimonio bruto (portafolio)', '', report.patrimonio.date, 'COP', '', '', report.patrimonio.patrimonioBrutoCop, 'Arts. 261-267 ET', '');
  push('PATRIMONIO', 'Total activos en el exterior', '', report.patrimonio.date, 'COP', '', '', report.patrimonio.foreignAssetsCop, 'Art. 607 ET', '');
  const f = report.formulario160;
  push(
    'FORMULARIO_160',
    `Obligado a declarar activos en el exterior en ${f.filingYear}`,
    f.required ? 'SI' : 'NO',
    '',
    'COP',
    '',
    '',
    f.thresholdCop,
    'Art. 607 ET',
    `Umbral 2.000 UVT x ${f.uvtUsed} (UVT ${f.uvtYear}${f.uvtIsEstimate ? ', estimada' : ''}). Discriminado: ${f.itemizedRequired ? 'SI' : 'NO'}`,
  );

  // Dividends and interest
  for (const d of [...report.ingresos.dividends, ...report.ingresos.interest]) {
    const concept =
      d.type === 'interes'
        ? `Intereses ${d.source === 'nacional' ? 'nacionales' : 'del exterior'}`
        : `Dividendos ${d.source === 'nacional' ? 'nacionales' : 'del exterior'}${d.type === 'dividendo_en_acciones' ? ' (en acciones)' : ''}`;
    push('INGRESOS', concept, d.symbol ?? '', d.date, d.currency, d.grossLocal, d.trm, d.grossCop, d.source === 'nacional' ? 'Arts. 48, 49 y 242 ET' : 'Arts. 24 y 254 ET', '');
    if (d.withheldCop > 0) {
      push(
        'INGRESOS',
        d.source === 'nacional' ? 'Retención en la fuente' : 'Impuesto pagado en el exterior',
        d.symbol ?? '',
        d.date,
        d.currency,
        d.withheldLocal,
        d.trm,
        d.withheldCop,
        d.source === 'nacional' ? 'Art. 242 ET' : 'Art. 254 ET',
        d.foreignTaxCreditCapCop !== undefined ? `Descuento máximo estimado: ${d.foreignTaxCreditCapCop.toFixed(0)} COP` : '',
      );
    }
  }
  const t = report.ingresos.totals;
  push('INGRESOS', 'Total dividendos nacionales', '', '', 'COP', '', '', t.nationalDividendsCop, 'Arts. 49, 242 y 254-1 ET', '');
  push('INGRESOS', 'Total dividendos del exterior', '', '', 'COP', '', '', t.foreignDividendsCop, 'Art. 254 ET', '');
  push('INGRESOS', 'Total impuestos pagados en el exterior (dividendos)', '', '', 'COP', '', '', t.foreignDividendTaxPaidCop, 'Art. 254 ET', '');
  push('INGRESOS', 'Total intereses', '', '', 'COP', '', '', t.nationalInterestCop + t.foreignInterestCop, 'Arts. 38-41 ET (componente inflacionario no calculado)', '');

  // Sales
  for (const s of report.ventas.rows) {
    push(
      'VENTAS',
      s.classification === 'no_gravada_art_36_1' ? 'Venta acciones - INCRNGO Art. 36-1' : s.classification === 'ganancia_ocasional' ? 'Venta acciones - Ganancia ocasional' : 'Venta acciones - Renta ordinaria',
      `${s.symbol} ${s.quantity} u. compradas ${s.openDate} (${s.holdingDays} días)`,
      s.sellDate,
      s.currency,
      s.proceedsLocal,
      s.trmSale,
      s.proceedsCop,
      s.legalBasis,
      `Costo fiscal COP: ${s.costCop.toFixed(0)}; utilidad COP: ${s.gainCop.toFixed(0)}`,
    );
  }
  const v = report.ventas.totals;
  push('VENTAS', 'Ingresos no constitutivos (Art. 36-1) - utilidad', '', '', 'COP', '', '', v.noGravadaArt361.utilidadCop, 'Art. 36-1 ET', '');
  push('GANANCIA_OCASIONAL', 'Ingresos por ganancias ocasionales', '', '', 'COP', '', '', v.gananciaOcasional.ingresosCop, 'Art. 300 ET', '');
  push('GANANCIA_OCASIONAL', 'Costos de ganancias ocasionales', '', '', 'COP', '', '', v.gananciaOcasional.costosCop, 'Art. 300 ET', '');
  push('GANANCIA_OCASIONAL', 'Ganancia ocasional gravable', '', '', 'COP', '', '', v.gananciaOcasional.gananciaGravableCop, 'Art. 314 ET', '');
  push('GANANCIA_OCASIONAL', `Impuesto estimado (${(v.gananciaOcasional.rate * 100).toFixed(1)}%)`, '', '', 'COP', '', '', v.gananciaOcasional.impuestoEstimadoCop, 'Art. 314 ET', '');
  push('RENTA_ORDINARIA', 'Ingresos venta acciones < 2 años', '', '', 'COP', '', '', v.rentaOrdinaria.ingresosCop, 'Cédula general', '');
  push('RENTA_ORDINARIA', 'Costos venta acciones < 2 años', '', '', 'COP', '', '', v.rentaOrdinaria.costosCop, 'Cédula general', '');

  // FX
  for (const r of report.diferenciaEnCambio.rows) {
    push('DIFERENCIA_EN_CAMBIO', r.reason, `${r.units} ${r.currency}`, r.date, r.currency, r.units, r.trm, r.gainCop, 'Arts. 269 y 288 ET', `Costo COP ${r.costCop.toFixed(0)} / valor COP ${r.valueCop.toFixed(0)}`);
  }
  push('DIFERENCIA_EN_CAMBIO', 'Ingreso por diferencia en cambio realizada', '', '', 'COP', '', '', report.diferenciaEnCambio.realizedGainCop, 'Art. 288 ET', '');
  push('DIFERENCIA_EN_CAMBIO', 'Pérdida por diferencia en cambio realizada', '', '', 'COP', '', '', report.diferenciaEnCambio.realizedLossCop, 'Art. 288 ET', '');

  push('GMF', 'GMF 4x1000 estimado sobre retiros (informativo)', '', '', 'COP', '', '', report.gmf.estimatedGmfCop, 'Arts. 871-881 ET', report.gmf.note);

  for (const a of report.assumptions) push('SUPUESTO', a, '', '', '', '', '', '', '', '');
  for (const i of report.issues) push('ALERTA', i.code, i.message, '', '', '', '', '', '', i.level);

  return toCsv(rows, opts);
}
