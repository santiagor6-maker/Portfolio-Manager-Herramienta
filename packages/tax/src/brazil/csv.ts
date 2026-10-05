import { toCsv, type CsvCell, type CsvOptions } from '../common/csv';
import type { BrApuracaoReport } from './apuracao';

/** Monthly apuração summary for the accountant ("para o contador"). */
export function brazilApuracaoCsv(report: BrApuracaoReport, opts?: CsvOptions): string {
  const rows: CsvCell[][] = [
    [
      'mes',
      'vendas_acoes_swing',
      'isento_20k',
      'ganho_isento',
      'resultado_acoes',
      'resultado_etf',
      'resultado_bdr',
      'resultado_day_trade',
      'resultado_fii',
      'prejuizo_comum_acumulado',
      'prejuizo_day_trade_acumulado',
      'prejuizo_fii_acumulado',
      'imposto_comum_15',
      'imposto_day_trade_20',
      'imposto_fii_20',
      'irrf_mes',
      'irrf_compensado',
      'imposto_a_pagar',
      'darf_valor',
      'darf_vencimento',
      'darf_codigo',
    ],
  ];
  for (const m of report.months) {
    rows.push([
      m.month,
      m.salesAcoesSwing,
      m.exempt,
      m.exemptGain,
      m.results.acoes,
      m.results.etf,
      m.results.bdr,
      m.results.dayTrade,
      m.results.fii,
      m.comum.lossCarryOut,
      m.dayTrade.lossCarryOut,
      m.fii.lossCarryOut,
      m.comum.tax,
      m.dayTrade.tax,
      m.fii.tax,
      m.irrf.month,
      m.irrf.used,
      m.taxAfterIrrf,
      m.darf?.amount,
      m.darf?.dueDate,
      m.darf?.code,
    ]);
  }
  rows.push([]);
  for (const a of report.assumptions) rows.push(['PREMISSA', a]);
  for (const i of report.issues) rows.push(['ALERTA', i.code, i.message]);
  rows.push(['AVISO', report.disclaimer.pt]);
  return toCsv(rows, opts);
}
