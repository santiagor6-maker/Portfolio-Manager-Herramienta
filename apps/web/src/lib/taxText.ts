/**
 * W36: @pm/tax messages sometimes name an option of the package API (config.meta,
 * creditEstimatedIrrf, foreignCashCountry, accountCustody, transitResolution…). They mean nothing
 * to the user: drop or rewrite those fragments, keeping the rest of the message intact.
 */
const RULES: [RegExp, string][] = [
  [/\s*\((?:ver|veja|see) config\.meta\)/gi, ''],
  [/,?\s*ou ative creditEstimatedIrrf/gi, ''],
  [/,?\s*o active creditEstimatedIrrf/gi, ''],
  [/\s*\(opção foreignCashCountry\)/gi, ''],
  [/\s*\(foreignCashCountry o instrument\.country\)/gi, ' (país del activo, en su ficha)'],
  [/\.?\s*Informe accountCustody\./gi, '. Indique a custódia da conta (corretora brasileira ou exterior).'],
  [/\s*\(transitResolution\)/gi, ''],
  [/\(transitResolution "alienado";\s*/gi, '('],
  [/transitResolution "mantido",?\s*/gi, ''],
  [/marque amountIsNet/gi, 'marque «valor líquido de retenção» no movimento'],
  [/\s*\(T\d+\)/g, ''],
];

export function cleanTaxMessage(message: string): string {
  let out = message;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out.replace(/\s{2,}/g, ' ').trim();
}
