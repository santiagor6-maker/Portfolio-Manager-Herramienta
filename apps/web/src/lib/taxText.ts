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
  // W45/W53: internal option names left in @pm/tax messages.
  [/ver gcapPre2024/gi, 'veja a seção GCAP 4600'],
];

export function cleanTaxMessage(message: string): string {
  let out = message;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * W45/W53: @pm/tax and @pm/importers write some numbers with a dot decimal ("0.05 BTC-USD saíram…") even in pt/es.
 * Rewrites plain decimals for the locale. Thousands-style groups ("Lei 14.754", "IN 1.888",
 * "R$ 1.500,00"), CNPJs and dates are left alone: only a leading 0 or a decimal part that is not
 * exactly three digits is treated as a decimal.
 */
export function localizeNumbers(message: string, locale: string): string {
  return localizeDates(
    message
      .replace(/(?<![\d.,/:])(-?\d+)\.(\d+)(?![\d.,/])/g, (all, int: string, dec: string) => {
        if (int.replace('-', '') !== '0' && dec.length === 3) return all;
        return new Intl.NumberFormat(locale, { minimumFractionDigits: dec.length, maximumFractionDigits: dec.length }).format(Number(`${int}.${dec}`));
      })
      // D16: plain amounts ("250976 COP") get thousands separators; ISO dates the user's format.
      .replace(/(?<![\d.,/:-])(\d{5,})(?= [A-Z]{3}\b)/g, (n) => new Intl.NumberFormat(locale).format(Number(n))),
    locale,
  );
}

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
function localDate(y: string, m: string, d: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(+y, +m - 1, +d)));
}

/** D16: ISO dates inside tax tables in the user's format (other text untouched). */
export function localizeDates(text: string, locale: string): string {
  return text.replace(ISO_DATE, (_all, y: string, m: string, d: string) => localDate(y, m, d, locale));
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
  const seen = new Map<string, T & { text: string; years?: string[] }>();
  for (const i of issues) {
    const text = localizeNumbers(cleanTaxMessage(i.message), locale);
    // The same notice for several years ("Alguns parâmetros de 2023…", "…de 2024…") becomes one line.
    const years = text.match(YEAR) ?? [];
    const key = years.length === 1 ? `${i.code ?? ''}|${text.replace(YEAR, '#')}` : text;
    const prev = seen.get(key);
    if (!prev) seen.set(key, { ...i, text, years: years.length === 1 ? [years[0]!] : undefined });
    else if (prev.years && !prev.years.includes(years[0]!)) prev.years.push(years[0]!);
  }
  const rank = (l: string) => (l === 'error' ? 0 : l === 'warning' ? 1 : 2);
  return [...seen.values()]
    .map(({ years, ...i }) => (years && years.length > 1 ? { ...i, text: i.text.replace(YEAR, years.sort().join(', ')) } : i) as T & { text: string })
    .sort((a, b) => rank(a.level) - rank(b.level));
}

const YEAR = /\b(?:19|20)\d{2}\b(?![-/.]\d)/g;
