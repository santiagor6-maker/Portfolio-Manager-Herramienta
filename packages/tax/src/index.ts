/**
 * @pm/tax — informational tax reports for Portafolio Pro (not tax advice).
 *
 * - Colombia (persona natural residente): patrimonio al 31-dic, Formulario 160, dividendos,
 *   intereses, ventas (Art. 36-1 / ganancia ocasional / renta ordinaria), diferencia en cambio,
 *   GMF, CSV "para tu contador".
 * - Brasil (residente): apuração mensal B3 (isenção R$ 20 mil, swing/day trade, FII, prejuízos,
 *   IRRF, DARF 6015), proventos (dividendos/JCP/FII), Lei 14.754/2023 (exterior), Bens e Direitos.
 * - EE.UU.: retención a no residentes sobre dividendos (tabla de tratados).
 *
 * All yearly parameters live in dated config tables with provenance (`meta`).
 */
export * from './common/types';
export { TAX_DISCLAIMER } from './common/disclaimer';
export { toCsv, type CsvOptions, type CsvCell } from './common/csv';
export * from './common/basis';
export * from './common/xlsx';
export * from './common/document';
export * from './common/reconcile';
export {
  lastBrazilBusinessDayOfMonth,
  brazilBankHolidays,
  addYears,
  nextBrazilBusinessDay,
  colombiaHolidays,
  usMarketHolidays,
  addBusinessDays,
  thirdFriday,
} from './common/dates';

export * from './colombia/config';
export * from './colombia/report';
export * from './colombia/csv';
export * from './colombia/simulate';
export * from './colombia/taxPack';
export * from './colombia/reconcile';

export * from './brazil/config';
export * from './brazil/classify';
export * from './brazil/ledger';
export * from './brazil/apuracao';
export * from './brazil/darf';
export * from './brazil/proventos';
export * from './brazil/exterior';
export * from './brazil/bensDireitos';
export * from './brazil/csv';
export * from './brazil/rendaFixa';
export * from './brazil/crypto';
export * from './brazil/simulate';
export * from './brazil/taxPack';
export * from './brazil/irpfm';
export * from './brazil/comeCotas';
export * from './brazil/reconcile';

export * from './us/withholding';

export { createSimpleMarketData, type SimpleMarketDataInput } from './testing/marketData';
