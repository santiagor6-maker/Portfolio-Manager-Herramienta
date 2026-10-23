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

/**
 * W45: @pm/tax writes some quantities with a dot decimal ("0.05 BTC-USD saíram…") even in pt/es.
 * Rewrites plain decimals for the locale. Thousands-style groups ("Lei 14.754", "IN 1.888",
 * "R$ 1.500,00"), CNPJs and dates are left alone: only a leading 0 or a decimal part that is not
 * exactly three digits is treated as a decimal.
 */
export function localizeNumbers(message: string, locale: string): string {
  return message.replace(/(?<![\d.,/:-])(\d+)\.(\d+)(?![\d.,/])/g, (all, int: string, dec: string) => {
    if (int !== '0' && dec.length === 3) return all;
    return new Intl.NumberFormat(locale, { minimumFractionDigits: dec.length, maximumFractionDigits: dec.length }).format(Number(`${int}.${dec}`));
  });
}

/** Notices that say the same thing every year (shown once until acknowledged). */
export const YEARLY_NOTICES = ['PTAX_FALLBACK'];

export interface TaxIssueLike {
  level: string;
  message: string;
  code?: string;
}

/**
 * W45: the same issue reaches the page from several reports (apuração, Bens e Direitos, cripto…):
 * keep one per cleaned message, localized, errors/warnings before infos.
 */
export function tidyTaxIssues<T extends TaxIssueLike>(issues: T[], locale: string): (T & { text: string })[] {
  const seen = new Map<string, T & { text: string }>();
  for (const i of issues) {
    const text = localizeNumbers(cleanTaxMessage(i.message), locale);
    if (!seen.has(text)) seen.set(text, { ...i, text });
  }
  const rank = (l: string) => (l === 'error' ? 0 : l === 'warning' ? 1 : 2);
  return [...seen.values()].sort((a, b) => rank(a.level) - rank(b.level));
}
