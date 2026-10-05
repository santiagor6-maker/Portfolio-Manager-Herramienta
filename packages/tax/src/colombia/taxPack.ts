import { toCsv, type CsvOptions } from '../common/csv';
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
  source: 'Formulario 210 prescrito por la DIAN para cada año gravable',
  note: 'Los números de casilla cambian con cada versión del formulario: confirmarlos y pasarlos en `casillas`.',
};

export function formulario210Lines(r: ColombiaTaxReport, casillas: Record<string, number> = {}): Formulario210Line[] {
  const t = r.ingresos.totals;
  const v = r.ventas.totals;
  const lines: Formulario210Line[] = [
    { seccion: 'Patrimonio', concepto: 'Total patrimonio bruto', valorCop: r.patrimonio.patrimonioBrutoCop, nota: 'Solo este portafolio' },
    {
      seccion: 'Rentas de capital',
      concepto: 'Ingresos brutos por rentas de capital (intereses y diferencia en cambio)',
      valorCop: t.nationalInterestCop + t.foreignInterestCop + r.diferenciaEnCambio.realizedGainCop,
    },
    { seccion: 'Rentas de capital', concepto: 'Ingresos no constitutivos de renta (componente inflacionario)', valorCop: t.componenteInflacionarioCop },
    { seccion: 'Rentas no laborales', concepto: 'Ingresos brutos por enajenación de acciones (< 2 años)', valorCop: v.rentaOrdinaria.ingresosCop },
    { seccion: 'Rentas no laborales', concepto: 'Costos de las acciones enajenadas (sin pérdidas, Art. 153 ET)', valorCop: v.rentaOrdinaria.costosCop },
    {
      seccion: 'Rentas no laborales',
      concepto: 'Ingresos no constitutivos de renta (Art. 36-1 ET)',
      valorCop: v.noGravadaArt361.utilidadCop,
      nota: `Ingresos por venta ${Math.round(v.noGravadaArt361.ingresosCop)}; costo ${Math.round(v.noGravadaArt361.costosCop)}`,
    },
    { seccion: 'Dividendos y participaciones', concepto: 'Dividendos y participaciones nacionales (2017 y siguientes)', valorCop: t.nationalDividendsCop },
    { seccion: 'Dividendos y participaciones', concepto: 'Dividendos del exterior', valorCop: t.foreignDividendsCop },
    { seccion: 'Ganancias ocasionales', concepto: 'Ingresos por ganancias ocasionales', valorCop: v.gananciaOcasional.ingresosCop },
    { seccion: 'Ganancias ocasionales', concepto: 'Costos por ganancias ocasionales', valorCop: v.gananciaOcasional.costosCop },
    { seccion: 'Ganancias ocasionales', concepto: 'Ganancias ocasionales gravables', valorCop: v.gananciaOcasional.gananciaGravableCop },
    { seccion: 'Liquidación privada', concepto: 'Impuesto de ganancias ocasionales', valorCop: v.gananciaOcasional.impuestoEstimadoCop },
    { seccion: 'Liquidación privada', concepto: 'Descuento por impuestos pagados en el exterior (Art. 254)', valorCop: r.impuestoEstimado?.descuentoArt254Cop ?? t.foreignDividendCreditCapCop ?? 0 },
    { seccion: 'Liquidación privada', concepto: 'Descuento por dividendos (Art. 254-1)', valorCop: r.impuestoEstimado?.descuentoArt2541Cop ?? t.descuentoArt2541Cop },
    { seccion: 'Liquidación privada', concepto: 'Retenciones del año gravable', valorCop: t.nationalDividendWithholdingCop + t.interestWithholdingCop },
  ];
  return lines.map((l) => ({ ...l, casilla: casillas[l.concepto] }));
}

export interface ColombiaTaxPack {
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
  return {
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
