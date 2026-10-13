/**
 * W24: engine diagnostics carry an English `message`. The UI shows a localized sentence built from
 * the code, the transaction and the numbers parsed out of the message: symbols instead of internal
 * ids, money and quantities formatted for the locale.
 */
import type { Diagnostic, Instrument, Transaction } from '@pm/core';
import { formatMoney } from './format';

type T = (key: string, opts?: Record<string, unknown>) => string;

export interface DiagContext {
  tx?: Transaction;
  instruments: Map<string, Instrument>;
  locale: string;
  t: T;
}

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const CCY = '([A-Z]{3})';

function qty(v: string | number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(Number(v));
}

/** Parameters per code, parsed from the engine message (undefined → no template applies). */
function params(d: Diagnostic, c: DiagContext): Record<string, string> | undefined {
  const m = d.message;
  const sym = (id?: string) => (id ? (c.instruments.get(id)?.symbol ?? id.split(':').pop() ?? id) : '');
  const money = (v: string | number, ccy: string) => formatMoney(Number(v), ccy, c.locale);
  const instId = c.tx?.instrumentId;
  const base = { symbol: sym(instId), type: c.tx ? c.t(`tx.type.${c.tx.type}`, { defaultValue: c.tx.type }) : '' };
  let r: RegExpMatchArray | null;
  switch (d.code) {
    case 'MATURITY_REDEEMED':
      r = m.match(new RegExp(`^(\\S+) redeemed automatically \\(estimated\\) for ${NUM} ${CCY}(?: net of an estimated ${NUM} withholding)?`));
      if (!r) return undefined;
      return {
        symbol: sym(r[1]),
        amount: money(r[2]!, r[3]!),
        tax: r[4] ? c.t('diag.text.netOfTax', { amount: money(r[4], r[3]!) }) : '',
      };
    case 'IMPLICIT_FX_CONVERSION':
      r = m.match(new RegExp(`Converted ${NUM} ${CCY} to ${NUM} ${CCY}`));
      return r ? { ...base, from: money(r[1]!, r[2]!), to: money(r[3]!, r[4]!) } : undefined;
    case 'IMPLICIT_FX_OTHER_ACCOUNT':
      r = m.match(new RegExp(`^${CCY} cash exists only in other accounts`));
      return r ? { ...base, currency: r[1]!, account: c.tx?.account ?? '' } : undefined;
    case 'WITHDRAWAL_EXCEEDS_CASH':
      r = m.match(new RegExp(`of ${NUM} ${CCY} exceeds cash; shortfall ${NUM}`));
      return r ? { ...base, amount: money(r[1]!, r[2]!), shortfall: money(r[3]!, r[2]!) } : undefined;
    case 'NEGATIVE_CASH':
      r = m.match(new RegExp(`Cash ${CCY} negative \\(${NUM}\\)`));
      return r ? { ...base, amount: money(r[2]!, r[1]!) } : undefined;
    case 'OVERSELL':
      r = m.match(new RegExp(`(?:Sold|Transferred out) ${NUM} (\\S+) but only ${NUM} held`));
      return r ? { ...base, symbol: sym(r[2]), quantity: qty(r[1]!, c.locale), held: qty(r[3]!, c.locale) } : undefined;
    case 'MISSING_FX':
      r = m.match(new RegExp(`No FX ${CCY}/${CCY} for (\\d{4}-\\d{2}-\\d{2})`));
      return r ? { pair: `${r[1]}/${r[2]}`, date: r[3]! } : undefined;
    case 'NEGATIVE_ACCOUNT_QTY':
      r = m.match(new RegExp(`Account '([^']*)' holds ${NUM} (\\S+)`));
      return r ? { account: r[1]!, quantity: qty(r[2]!, c.locale), symbol: sym(r[3]) } : undefined;
    case 'INCOME_WITHOUT_POSITION':
    case 'INTEREST_ALREADY_RECORDED':
    case 'MISSING_PRICE':
    case 'UNKNOWN_INSTRUMENT':
    case 'MISSING_INSTRUMENT':
    case 'INVALID_QUANTITY':
    case 'INVALID_RATIO':
    case 'MISSING_TARGET':
    case 'MISSING_CURRENCY':
    case 'LATE_REDEMPTION':
      return base;
    case 'TRADE_PRICE_OUTLIER':
    case 'TRADE_PRICE_UNCONFIRMED':
      return { ...base, price: c.tx?.price !== undefined ? money(c.tx.price, c.tx.currency) : '—' };
    case 'COUPON_EXCEEDS_ACCRUED_INTEREST':
      r = m.match(new RegExp(`exceeds the interest accrued by ${NUM} ${CCY}`));
      return r ? { ...base, excess: money(r[1]!, r[2]!) } : undefined;
    case 'INTEREST_NET_ASSUMED':
      r = m.match(new RegExp(`gross ${NUM} with an estimated ${NUM} withheld`));
      return r && c.tx ? { ...base, gross: money(r[1]!, c.tx.currency), withheld: money(r[2]!, c.tx.currency) } : undefined;
    case 'COUPON_RECORD_DATE_UNITS':
      r = m.match(new RegExp(`over the ${NUM} units held at the record date \\(${NUM} held`));
      return r ? { ...base, units: qty(r[1]!, c.locale), held: qty(r[2]!, c.locale) } : undefined;
    default:
      return undefined;
  }
}

/** Fallback for codes without a template: ids → symbols, decimals → locale numbers. */
export function cleanMessage(message: string, instruments: Map<string, Instrument>, locale: string): string {
  let out = message;
  for (const [id, inst] of instruments) if (out.includes(id)) out = out.split(id).join(inst.symbol);
  out = out.replace(/\bMANUAL:([A-Z0-9-]+)/g, (_m, s: string) => s);
  return out.replace(/-?\d+\.\d+/g, (n) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(n)));
}

/** Localized one-line description of a diagnostic. */
export function describeDiagnostic(d: Diagnostic, c: DiagContext): string {
  const p = params(d, c);
  const key = `diag.text.${d.code}`;
  if (p) {
    const s = c.t(key, { ...p, defaultValue: '' });
    if (s) return s;
  }
  return cleanMessage(d.message, c.instruments, c.locale);
}
