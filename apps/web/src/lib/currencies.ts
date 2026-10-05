import type { CurrencyCode } from '@pm/core';

export interface CurrencyMeta {
  code: CurrencyCode;
  /** Display decimals for amounts (COP and CLP are shown without cents). */
  decimals: number;
  flag: string;
  country: string;
}

export const CURRENCIES: CurrencyMeta[] = [
  { code: 'COP', decimals: 0, flag: '🇨🇴', country: 'CO' },
  { code: 'BRL', decimals: 2, flag: '🇧🇷', country: 'BR' },
  { code: 'USD', decimals: 2, flag: '🇺🇸', country: 'US' },
  { code: 'EUR', decimals: 2, flag: '🇪🇺', country: 'EU' },
  { code: 'MXN', decimals: 2, flag: '🇲🇽', country: 'MX' },
  { code: 'CLP', decimals: 0, flag: '🇨🇱', country: 'CL' },
  { code: 'PEN', decimals: 2, flag: '🇵🇪', country: 'PE' },
  { code: 'GBP', decimals: 2, flag: '🇬🇧', country: 'GB' },
  { code: 'CHF', decimals: 2, flag: '🇨🇭', country: 'CH' },
];

export const CURRENCY_CODES = CURRENCIES.map((c) => c.code);

export function currencyDecimals(code: CurrencyCode): number {
  return CURRENCIES.find((c) => c.code === code)?.decimals ?? 2;
}

/** Common FX pairs shown in the currencies page (base/quote). */
export const FX_PAIRS: [CurrencyCode, CurrencyCode][] = [
  ['USD', 'COP'],
  ['USD', 'BRL'],
  ['EUR', 'USD'],
  ['EUR', 'COP'],
  ['BRL', 'COP'],
  ['USD', 'MXN'],
];
