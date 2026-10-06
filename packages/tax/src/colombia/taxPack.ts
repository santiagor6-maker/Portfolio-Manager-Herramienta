import { toCsv, type CsvOptions } from '../common/csv';
import type { TaxDocument } from '../common/document';
import { toXlsx, type XlsxSheet } from '../common/xlsx';
import type { ParamMeta, TaxInput } from '../common/types';
import { colombiaAccountantCsv } from './csv';
import { buildColombiaTaxReport, type ColombiaReportOptions, type ColombiaTaxReport } from './report';

/**
 * A line of the Formulario 210 (renta personas naturales residentes). The casilla number changes
 * with each year's prescribed form, so lines carry the concept (section + name) and an optional
 * casilla to be filled from `casillas` once verified for the year.
 */
export interface Formulario210Line {
  seccion: 'Patrimonio' | 'Rentas de capital' | 'Rentas no laborales' | 'Dividendos y participaciones' | 'Ganancias ocasionales' | 'Liquidación privada';
  concepto: string;
  valorCop: number;
  casilla?: number;
  nota?: string;
}

export const FORMULARIO_210_META: ParamMeta = {
  status: 'needs-verification',
  source: 'Formulario 210 (estructura Res. DIAN 000044 de 2024, usada en AG 2024 y AG 2025)',
  checkedOn: '2026-10-06',
  note:
    'Casillas 29-31 (patrimonio), 112-115 (ganancias ocasionales), 127-128 (impuesto y descuento GO) y 132 (retenciones) ' +
    'verificadas en guías de terceros; las demás se dejan vacías hasta confirmarlas con el formulario prescrito del año.',
};

/** Known casilla numbers per form year (AG). Concepts not listed stay without number. */
export const FORMULARIO_210_CASILLAS: Record<number, Record<string, number>> = {
  2024: {
    'Total patrimonio bruto': 29,
    'Ingresos por ganancias ocasionales': 112,
    'Costos por ganancias ocasionales': 113,
    'Ganancias ocasionales no gravadas y exentas': 114,
    'Ganancias ocasionales gravables': 115,
    'Impuesto de ganancias ocasionales': 127,
    'Retenciones del año gravable': 132,
  },
  2025: {
    'Total patrimonio bruto': 29,
    'Ingresos por ganancias ocasionales': 112,
    'Costos por ganancias ocasionales': 113,
    'Ganancias ocasionales no gravadas y exentas': 114,
    'Ganancias ocasionales gravables': 115,
    'Impuesto de ganancias ocasionales': 127,
    'Retenciones del año gravable': 132,
  },
};

export function formulario210Lines(r: ColombiaTaxReport, casillas: Record<string, number> = {}): Formulario210Line[] {
  const t = r.ingresos.totals;
  const v = r.ventas.totals;
  const ex = v.noGravadaArt361;
  const known = { ...(FORMULARIO_210_CASILLAS[r.year] ?? {}), ...casillas };
  const lines: Formulario210Line[] = [
    { seccion: 'Patrimonio', concepto: 'Total patrimonio bruto', valorCop: r.patrimonio.patrimonioBrutoCop, nota: 'Solo este portafolio' },
    {
      seccion: 'Rentas de capital',
      concepto: 'Ingresos brutos por rentas de capital (intereses y diferencia en cambio)',
      valorCop: t.nationalInterestCop + t.foreignInterestCop + r.diferenciaEnCambio.realizedGainCop,
    },
    { seccion: 'Rentas de capital', concepto: 'Ingresos no constitutivos de renta (componente inflacionario)', valorCop: t.componenteInflacionarioCop },
    {
      seccion: 'Rentas no laborales',
      concepto: 'Ingresos brutos por enajenación de acciones (< 2 años)',
      valorCop: v.rentaOrdinaria.ingresosCop + ex.rentaNoLaboral.ingresosCop,
      nota: 'Incluye las ventas del Art. 36-1 (cuadra con la exógena del comisionista)',
    },
    {
      seccion: 'Rentas no laborales',
      concepto: 'Ingresos no constitutivos de renta (Art. 36-1 ET)',
      valorCop: ex.rentaNoLaboral.incrngoCop,
    },
    {
      seccion: 'Rentas no laborales',
      concepto: 'Costos de las acciones enajenadas (sin pérdidas, Art. 153 ET)',
      valorCop: v.rentaOrdinaria.costosCop + ex.rentaNoLaboral.costosCop,
    },
    {
      seccion: 'Dividendos y participaciones',
      concepto: 'Dividendos y participaciones 2017 y siguientes, 1a subcédula (no gravados)',
      valorCop: t.nationalDividendsCop - t.nationalDividendsGravadosCop,
    },
    {
      seccion: 'Dividendos y participaciones',
      concepto: 'Dividendos y participaciones 2017 y siguientes, 2a subcédula (gravados, Art. 49 par. 2)',
      valorCop: t.nationalDividendsGravadosCop,
    },
    { seccion: 'Dividendos y participaciones', concepto: 'Dividendos del exterior', valorCop: t.foreignDividendsCop },
    {
      seccion: 'Ganancias ocasionales',
      concepto: 'Ingresos por ganancias ocasionales',
      valorCop: v.gananciaOcasional.ingresosCop + ex.gananciaOcasional.ingresosCop,
    },
    {
      seccion: 'Ganancias ocasionales',
      concepto: 'Costos por ganancias ocasionales',
      valorCop: v.gananciaOcasional.costosCop + ex.gananciaOcasional.costosCop,
    },
    {
      seccion: 'Ganancias ocasionales',
      concepto: 'Ganancias ocasionales no gravadas y exentas',
      valorCop: ex.gananciaOcasional.noGravadaCop,
      nota: 'Ventas del Art. 36-1 con tenencia >= 2 años',
    },
    { seccion: 'Ganancias ocasionales', concepto: 'Ganancias ocasionales gravables', valorCop: v.gananciaOcasional.gananciaGravableCop },
    { seccion: 'Liquidación privada', concepto: 'Impuesto de ganancias ocasionales', valorCop: v.gananciaOcasional.impuestoEstimadoCop },
    { seccion: 'Liquidación privada', concepto: 'Descuento por impuestos pagados en el exterior (Art. 254)', valorCop: r.impuestoEstimado?.descuentoArt254Cop ?? t.foreignDividendCreditCapCop ?? 0 },
    { seccion: 'Liquidación privada', concepto: 'Descuento por dividendos (Art. 254-1)', valorCop: r.impuestoEstimado?.descuentoArt2541Cop ?? t.descuentoArt2541Cop },
    { seccion: 'Liquidación privada', concepto: 'Retenciones del año gravable', valorCop: t.nationalDividendWithholdingCop + t.interestWithholdingCop },
  ];
  return lines.map((l) => ({ ...l, casilla: known[l.concepto] }));
}

export interface ColombiaTaxPack {
  /** Workbook with one sheet per table (Formulario 210, 160, patrimonio, ventas, ingresos...). */
  xlsx: Uint8Array;
  /** Presentation model for PDF/print rendering by the app. */
  document: TaxDocument;
  report: ColombiaTaxReport;
  formulario210: Formulario210Line[];
  formulario210Meta: ParamMeta;
  formulario160: ColombiaTaxReport['formulario160'];
  files: Record<string, string>;
}

/** Everything the accountant needs for one year: report, Formulario 210 lines, F160 lines and CSV files. */
export function colombiaTaxPack(
  input: TaxInput,
  opts: ColombiaReportOptions & { casillas210?: Record<string, number>; csv?: CsvOptions },
): ColombiaTaxPack {
  const report = buildColombiaTaxReport(input, opts);
  const f210 = formulario210Lines(report, opts.casillas210);
  const y = opts.year;
  const r = report;
  const sheets: XlsxSheet[] = [
    { name: 'Formulario 210', rows: [['Sección', 'Concepto', 'Casilla', 'Valor COP', 'Nota'], ...f210.map((l) => [l.seccion, l.concepto, l.casilla, l.valorCop, l.nota])] },
    {
      name: 'Formulario 160',
      rows: [
        ['Nivel', 'País', 'Descripción', 'Valor COP'],
        ...r.formulario160.lines.map((l) => [l.level, l.country, l.description, l.valueCop]),
        [],
        ['Obligado', r.formulario160.required, 'Umbral COP', r.formulario160.thresholdCop],
      ],
    },
    {
      name: 'Patrimonio',
      rows: [
        ['Tipo', 'Símbolo', 'Moneda', 'Cantidad', 'Costo moneda', 'Valor fiscal COP', 'Valor mercado COP', 'Exterior', 'País', 'Base legal'],
        ...r.patrimonio.rows.map((x) => [x.kind, x.symbol ?? '', x.currency, x.quantity, x.costLocal, x.fiscalValueCop, x.marketValueCop, x.abroad, x.country, x.legalBasis]),
      ],
    },
    {
      name: 'Ventas',
      rows: [
        ['Fecha', 'Realización', 'Símbolo', 'Compra', 'Días', 'Cantidad', 'Ingreso COP', 'Costo COP', 'Costo deducible COP', 'Pérdida no deducible COP', 'Clasificación', 'Base legal'],
        ...r.ventas.rows.map((x) => [x.sellDate, x.realizationDate, x.symbol, x.openDate, x.holdingDays, x.quantity, x.proceedsCop, x.costCop, x.deductibleCostCop, x.nonDeductibleLossCop, x.classification, x.legalBasis]),
      ],
    },
    {
      name: 'Ingresos',
      rows: [
        ['Fecha', 'Tipo', 'Fuente', 'Símbolo', 'Moneda', 'Bruto', 'TRM', 'Bruto COP', 'Retención COP', 'Retención esperada COP', 'Gravado COP', 'Descuento máx. COP'],
        ...[...r.ingresos.dividends, ...r.ingresos.interest].map((x) => [
          x.date, x.type, x.source, x.symbol ?? '', x.currency, x.grossLocal, x.trm, x.grossCop, x.withheldCop, x.expectedWithholdingCop, x.gravadoCop, x.foreignTaxCreditCapCop,
        ]),
      ],
    },
    {
      name: 'Diferencia en cambio',
      rows: [['Fecha', 'Moneda', 'Unidades', 'TRM', 'Costo COP', 'Valor COP', 'Resultado COP', 'Motivo'], ...r.diferenciaEnCambio.rows.map((x) => [x.date, x.currency, x.units, x.trm, x.costCop, x.valueCop, x.gainCop, x.reason])],
    },
    { name: 'Alertas y supuestos', rows: [['Tipo', 'Código', 'Mensaje'], ...r.issues.map((i) => [i.level, i.code, i.message]), ...r.assumptions.map((a) => ['supuesto', '', a]), ['aviso', '', r.disclaimer.es]] },
  ];
  const document: TaxDocument = {
    title: `Reporte tributario ${y} — Colombia`,
    subtitle: 'Persona natural residente fiscal · información para el contador',
    country: 'CO',
    year: y,
    locale: 'es-CO',
    disclaimer: r.disclaimer,
    sections: [
      {
        heading: 'Resumen',
        figures: [
          { label: 'Patrimonio bruto (portafolio)', value: r.patrimonio.patrimonioBrutoCop, currency: 'COP' },
          { label: 'Activos en el exterior', value: r.patrimonio.foreignAssetsCop, currency: 'COP' },
          { label: 'Formulario 160 obligatorio', value: r.formulario160.required ? 'Sí' : 'No' },
          { label: 'Ganancia ocasional gravable', value: r.ventas.totals.gananciaOcasional.gananciaGravableCop, currency: 'COP' },
          { label: 'Impuesto ganancia ocasional', value: r.ventas.totals.gananciaOcasional.impuestoEstimadoCop, currency: 'COP' },
          ...(r.impuestoEstimado ? [{ label: 'Saldo estimado (portafolio)', value: r.impuestoEstimado.saldoEstimadoCop, currency: 'COP' }] : []),
        ],
      },
      ...sheets.slice(0, 6).map((sh) => ({
        heading: sh.name,
        table: { columns: (sh.rows[0] ?? []).map(String), rows: sh.rows.slice(1) },
      })),
      { heading: 'Supuestos', paragraphs: r.assumptions },
      { heading: 'Alertas', paragraphs: r.issues.map((i) => `[${i.level}] ${i.message}`) },
    ],
  };
  return {
    xlsx: toXlsx(sheets),
    document,
    report,
    formulario210: f210,
    formulario210Meta: FORMULARIO_210_META,
    formulario160: report.formulario160,
    files: {
      [`colombia-${y}-para-contador.csv`]: colombiaAccountantCsv(report, opts.csv),
      [`colombia-${y}-formulario-210.csv`]: toCsv(
        [['seccion', 'concepto', 'casilla', 'valor_cop', 'nota'], ...f210.map((l) => [l.seccion, l.concepto, l.casilla, l.valorCop, l.nota])],
        opts.csv,
      ),
      [`colombia-${y}-formulario-160.csv`]: toCsv(
        [['nivel', 'pais', 'descripcion', 'valor_cop'], ...report.formulario160.lines.map((l) => [l.level, l.country, l.description, l.valueCop])],
        opts.csv,
      ),
    },
  };
}
