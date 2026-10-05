import type { CurrencyCode } from '@pm/core';
import { currencyDecimals } from './currencies';

export type Lang = 'es' | 'pt' | 'en';

/** Number/date locale per UI language. */
export const LOCALE_BY_LANG: Record<Lang, string> = {
  es: 'es-CO',
  pt: 'pt-BR',
  en: 'en-US',
};

const cache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = locale + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    cache.set(key, f);
  }
  return f;
}

/** Normalizes the narrow no-break spaces Intl emits so output is stable across engines. */
function clean(s: string): string {
  return s.replace(/[  ]/g, ' ');
}

export const MASK = '•••••';

export interface MoneyOptions {
  decimals?: number;
  compact?: boolean;
  /** Prefix positive values with '+'. */
  signed?: boolean;
  privacy?: boolean;
}

/**
 * Format an amount in a currency for a locale.
 * es-CO + COP → "$ 1.234.567"; pt-BR + BRL → "R$ 1.234,56"; en-US + USD → "$1,234.56".
 */
export function formatMoney(
  amount: number | undefined | null,
  currency: CurrencyCode,
  locale: string,
  opts: MoneyOptions = {},
): string {
  if (opts.privacy) return MASK;
  if (amount === undefined || amount === null || !Number.isFinite(amount)) return '—';
  const decimals = opts.decimals ?? currencyDecimals(currency);
  const o: Intl.NumberFormatOptions = {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: opts.compact ? 0 : decimals,
    maximumFractionDigits: opts.compact ? 1 : decimals,
  };
  if (opts.compact) o.notation = 'compact';
  if (opts.signed) o.signDisplay = 'exceptZero';
  let out = nf(locale, o).format(amount === 0 ? 0 : amount);
  // Disambiguate dollar-sign currencies that are not the locale's own currency.
  if (needsCodePrefix(currency, locale)) {
    out = out.replace('$', `${currency} `).replace(/  /g, ' ');
  }
  return clean(out);
}

const LOCAL_DOLLAR: Record<string, CurrencyCode> = { 'es-CO': 'COP', 'en-US': 'USD', 'es-MX': 'MXN', 'es-CL': 'CLP' };

function needsCodePrefix(currency: CurrencyCode, locale: string): boolean {
  const dollarish = ['COP', 'USD', 'MXN', 'CLP'];
  if (!dollarish.includes(currency)) return false;
  return LOCAL_DOLLAR[locale] !== currency;
}

export function formatNumber(value: number | undefined | null, locale: string, decimals = 2, privacy = false): string {
  if (privacy) return MASK;
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return clean(nf(locale, { minimumFractionDigits: 0, maximumFractionDigits: decimals }).format(value));
}

export function formatQuantity(value: number | undefined | null, locale: string, privacy = false): string {
  if (privacy) return MASK;
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const decimals = Number.isInteger(value) ? 0 : 4;
  return clean(nf(locale, { maximumFractionDigits: decimals }).format(value));
}

/** Price in instrument currency (more decimals for small prices). */
export function formatPrice(value: number | undefined | null, currency: CurrencyCode, locale: string): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const decimals = Math.abs(value) < 10 ? 4 : currencyDecimals(currency) === 0 ? 0 : 2;
  return formatMoney(value, currency, locale, { decimals });
}

/** Percent from a decimal (0.0123 → "1,23 %" in es-CO). */
export function formatPct(
  value: number | undefined | null,
  locale: string,
  opts: { decimals?: number; signed?: boolean } = {},
): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const d = opts.decimals ?? 2;
  return clean(
    nf(locale, {
      style: 'percent',
      minimumFractionDigits: d,
      maximumFractionDigits: d,
      signDisplay: opts.signed ? 'exceptZero' : 'auto',
    }).format(value),
  );
}

export function formatFxRate(value: number | undefined | null, locale: string): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const d = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return clean(nf(locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(value));
}

/** Direction of a change for colour + icon cues (colourblind-safe: always paired with sign/arrow). */
export function trend(value: number | undefined | null, epsilon = 1e-9): 'up' | 'down' | 'flat' {
  if (value === undefined || value === null || !Number.isFinite(value) || Math.abs(value) < epsilon) return 'flat';
  return value > 0 ? 'up' : 'down';
}

const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
function df(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(opts);
  let f = dateFmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' });
    dateFmtCache.set(key, f);
  }
  return f;
}

function parseIso(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

export function formatDate(date: string | undefined, locale: string, style: 'short' | 'medium' = 'medium'): string {
  if (!date) return '—';
  if (style === 'short') return df(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parseIso(date));
  return df(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(parseIso(date));
}

/** "2025-03" → "mar 2025" / "Mar 2025". */
export function formatMonth(month: string, locale: string, style: 'short' | 'long' = 'short'): string {
  const d = parseIso(`${month}-01`);
  return df(locale, { month: style, year: 'numeric' }).format(d).replace('.', '');
}

export function monthName(monthIndex0: number, locale: string): string {
  return df(locale, { month: 'short' })
    .format(new Date(Date.UTC(2020, monthIndex0, 1)))
    .replace('.', '');
}

export function formatDateTime(ts: number | undefined, locale: string): string {
  if (!ts) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
}

/** Relative "hace 5 min" style text. */
export function formatRelative(ts: number | undefined, locale: string, now = Date.now()): string {
  if (!ts) return '—';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const diff = (ts - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}
