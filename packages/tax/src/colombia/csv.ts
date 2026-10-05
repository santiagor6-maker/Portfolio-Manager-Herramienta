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
  push('INGRESOS', 'Retención esperada dividendos nacionales', '', '', 'COP', '', '', t.nationalDividendExpectedWithholdingCop, 'Art. 242 ET; DUR 1.2.4.7.1', 'Comparar con el certificado');
  push('INGRESOS', 'Descuento dividendos nacionales (19%)', '', '', 'COP', '', '', t.descuentoArt2541Cop, 'Art. 254-1 ET', 'Sobre el exceso de 1.090 UVT');
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
      `Costo fiscal COP: ${s.costCop.toFixed(0)}; utilidad COP: ${s.gainCop.toFixed(0)}` +
        (s.nonDeductibleLossCop > 0 ? `; pérdida no deducible (Art. 153 ET): ${s.nonDeductibleLossCop.toFixed(0)}` : '') +
        (s.realizationDate !== s.sellDate ? `; realizada ${s.realizationDate}` : ''),
    );
  }
  const v = report.ventas.totals;
  push('VENTAS', 'Ingresos no constitutivos (Art. 36-1) - utilidad', '', '', 'COP', '', '', v.noGravadaArt361.utilidadCop, 'Art. 36-1 ET', '');
  push('GANANCIA_OCASIONAL', 'Ingresos por ganancias ocasionales', '', '', 'COP', '', '', v.gananciaOcasional.ingresosCop, 'Art. 300 ET', '');
  push('GANANCIA_OCASIONAL', 'Costos de ganancias ocasionales', '', '', 'COP', '', '', v.gananciaOcasional.costosCop, 'Art. 300 ET', '');
  push('GANANCIA_OCASIONAL', 'Pérdida no deducible (Art. 153 ET)', '', '', 'COP', '', '', v.gananciaOcasional.perdidaNoDeducibleCop, 'Art. 153 ET', 'No se resta de otras ganancias');
  push('GANANCIA_OCASIONAL', 'Ganancia ocasional gravable', '', '', 'COP', '', '', v.gananciaOcasional.gananciaGravableCop, 'Art. 314 ET', '');
  push('GANANCIA_OCASIONAL', `Impuesto estimado (${(v.gananciaOcasional.rate * 100).toFixed(1)}%)`, '', '', 'COP', '', '', v.gananciaOcasional.impuestoEstimadoCop, 'Art. 314 ET', '');
  push('RENTA_ORDINARIA', 'Ingresos venta acciones < 2 años', '', '', 'COP', '', '', v.rentaOrdinaria.ingresosCop, 'Cédula general', '');
  push('RENTA_ORDINARIA', 'Costos venta acciones < 2 años', '', '', 'COP', '', '', v.rentaOrdinaria.costosCop, 'Cédula general', 'Costos deducibles (sin pérdidas, Art. 153 ET)');
  push('RENTA_ORDINARIA', 'Pérdida no deducible (Art. 153 ET)', '', '', 'COP', '', '', v.rentaOrdinaria.perdidaNoDeducibleCop, 'Art. 153 ET', '');
  if (v.pendienteCosto.count > 0) {
    push('VENTAS', 'Ventas sin costo registrado (pendientes)', '', '', 'COP', '', '', v.pendienteCosto.ingresosCop, '', 'Registrar la compra o el traslado con su costo');
  }

  // FX
  for (const r of report.diferenciaEnCambio.rows) {
    push('DIFERENCIA_EN_CAMBIO', r.reason, `${r.units} ${r.currency}`, r.date, r.currency, r.units, r.trm, r.gainCop, 'Arts. 269 y 288 ET', `Costo COP ${r.costCop.toFixed(0)} / valor COP ${r.valueCop.toFixed(0)}`);
  }
  push('DIFERENCIA_EN_CAMBIO', 'Ingreso por diferencia en cambio realizada', '', '', 'COP', '', '', report.diferenciaEnCambio.realizedGainCop, 'Art. 288 ET', '');
  push('DIFERENCIA_EN_CAMBIO', 'Pérdida por diferencia en cambio realizada', '', '', 'COP', '', '', report.diferenciaEnCambio.realizedLossCop, 'Art. 288 ET', '');

  const ie = report.impuestoEstimado;
  if (ie) {
    push('IMPUESTO_ESTIMADO', 'Renta cédula general del portafolio', '', '', 'COP', '', '', ie.portfolioCedulaGeneralCop, 'Arts. 330-336 ET', '');
    push('IMPUESTO_ESTIMADO', 'Impuesto incremental (tabla Art. 241)', '', '', 'COP', '', '', ie.impuestoCedulaGeneralIncrementalCop, 'Art. 241 ET', `Tarifa marginal ${(ie.marginalRate * 100).toFixed(0)}%`);
    push('IMPUESTO_ESTIMADO', 'Descuento Art. 254-1', '', '', 'COP', '', '', ie.descuentoArt2541Cop, 'Art. 254-1 ET', '');
    push('IMPUESTO_ESTIMADO', 'Descuento impuestos exterior', '', '', 'COP', '', '', ie.descuentoArt254Cop, 'Art. 254 ET', '');
    push('IMPUESTO_ESTIMADO', 'Impuesto ganancia ocasional', '', '', 'COP', '', '', ie.impuestoGananciaOcasionalCop, 'Art. 314 ET', '');
    push('IMPUESTO_ESTIMADO', 'Retenciones (anticipos)', '', '', 'COP', '', '', ie.retencionesCop, '', '');
    push('IMPUESTO_ESTIMADO', 'Saldo estimado a pagar (portafolio)', '', '', 'COP', '', '', ie.saldoEstimadoCop, '', ie.note);
  }
  for (const l of report.formulario160.lines) {
    push('FORMULARIO_160', l.level === 'pais' ? 'Activos por jurisdicción' : 'Activo discriminado', l.description, '', 'COP', '', '', l.valueCop, 'Art. 607 ET', l.country);
  }
  const o = report.obligacionDeclarar;
  push('OBLIGACION', 'Consignaciones/depósitos del año', o.byConsignaciones ? 'SUPERA 1.400 UVT' : '', '', 'COP', '', '', o.consignacionesCop, 'Art. 594-3 ET', '');
  push('GMF', 'GMF 4x1000 estimado sobre retiros (informativo)', '', '', 'COP', '', '', report.gmf.estimatedGmfCop, 'Arts. 871-881 ET', report.gmf.note);

  for (const a of report.assumptions) push('SUPUESTO', a, '', '', '', '', '', '', '', '');
  for (const i of report.issues) push('ALERTA', i.code, i.message, '', '', '', '', '', '', i.level);

  return toCsv(rows, opts);
}
