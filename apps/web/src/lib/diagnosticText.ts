/**
 * W24: engine diagnostics carry an English `message`. The UI shows a localized sentence built from
 * the code, the transaction and the numbers parsed out of the message: symbols instead of internal
 * ids, money and quantities formatted for the locale.
 */
import type { Diagnostic, Instrument, Transaction } from '@pm/core';
import { formatDate, formatMoney, formatPct } from './format';

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
    // Core R8: structured `data` (no text parsing).
    case 'INSTRUMENT_RENAMED':
      return d.data?.fromId && d.data?.toId ? { from: sym(String(d.data.fromId)), to: sym(String(d.data.toId)) } : undefined;
    case 'MERGER_CASH_PENDING':
      return d.data?.amount !== undefined && d.data?.currency
        ? { ...base, symbol: sym(String(d.data.instrumentId ?? instId)), amount: money(Number(d.data.amount), String(d.data.currency)), date: String(d.data.payDate ?? '') }
        : undefined;
    case 'COST_FRACTION_ESTIMATED':
      return d.data?.costFraction !== undefined
        ? {
            symbol: sym(String(d.data.instrumentId ?? instId)),
            target: sym(String(d.data.targetInstrumentId ?? '')),
            pct: `${new Intl.NumberFormat(c.locale, { maximumFractionDigits: 1 }).format(Number(d.data.costFraction) * 100)} %`,
          }
        : undefined;
    case 'STOCK_DIVIDEND_RATIO_SUSPECT':
      return c.tx?.ratio !== undefined
        ? { ...base, date: formatDate(c.tx.date, c.locale, 'short'), ratio: qty(c.tx.ratio, c.locale), pct: formatPct(c.tx.ratio, c.locale, { decimals: 0 }) }
        : undefined;
    case 'CORPORATE_ACTION_WITHOUT_POSITION':
      return d.data?.instrumentId ? { ...base, symbol: sym(String(d.data.instrumentId)), target: sym(String(d.data.targetInstrumentId ?? '')) } : undefined;
    case 'TRADE_PRICE_UNIT_SUSPECT': {
      const f = unitFactor(m);
      return { ...base, price: c.tx?.price !== undefined ? money(c.tx.price, c.tx.currency) : '—', factor: f ? (f >= 1 ? `×${f}` : `÷${Math.round(1 / f)}`) : '?' };
    }
    case 'POSSIBLE_UNRECORDED_SPLIT':
    case 'POSSIBLE_REDENOMINATION': {
      const sp = splitSuggestion(m, d.data);
      return sp ? { ...base, symbol: sym(sp.instrumentId), ratio: sp.ratio >= 1 ? `${sp.ratio}:1` : `1:${Math.round(1 / sp.ratio)}`, date: sp.date } : undefined;
    }
    case 'TRADE_PRICE_CONFIRMED_BY_RUN':
      return { ...base, price: c.tx?.price !== undefined ? money(c.tx.price, c.tx.currency) : '—' };
    case 'INTEREST_POSSIBLY_NET':
      return c.tx?.amount !== undefined ? { ...base, amount: money(c.tx.amount, c.tx.currency) } : undefined;
    case 'INTEREST_BELOW_ACCRUED':
      r = m.match(new RegExp(`is ${NUM} % of the ${NUM} accrued`));
      return r && c.tx ? { ...base, pct: `${new Intl.NumberFormat(c.locale, { maximumFractionDigits: 1 }).format(Number(r[1]))} %`, accrued: money(r[2]!, c.tx.currency) } : undefined;
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

/**
 * W41: validation issues (`validateTransactions`) carry English messages too ("SELL of 20 BVMF:VALE3
 * on 2023-01-02 exceeds holding of 0"). Localized from the code and the transaction; numbers parsed
 * from the message. Codes without a sentence fall back to the code's label + symbol, never the raw
 * English text.
 */
export function describeIssue(i: { code: string; message: string; transactionId?: string }, c: DiagContext): string {
  const m = i.message;
  const sym = (id?: string) => (id ? (c.instruments.get(id)?.symbol ?? id.split(':').pop() ?? id) : '');
  const tx = c.tx;
  const day = (d?: string) => (d ? formatDate(d, c.locale, 'short') : '');
  const base: Record<string, string> = {
    symbol: sym(tx?.instrumentId),
    type: tx ? c.t(`tx.type.${tx.type}`, { defaultValue: tx.type }) : '',
    date: day(tx?.date),
  };
  let p: Record<string, string> | undefined = base;
  let r: RegExpMatchArray | null;
  switch (i.code) {
    case 'OVERSELL':
      r = m.match(new RegExp(`^(\\w+) of ${NUM} (\\S+) on (\\d{4}-\\d{2}-\\d{2}) exceeds holding of ${NUM}`));
      p = r ? { ...base, symbol: sym(r[3]), quantity: qty(r[2]!, c.locale), date: day(r[4]), held: qty(r[5]!, c.locale), type: c.t(`tx.type.${r[1]}`, { defaultValue: r[1] }) } : undefined;
      break;
    case 'INCOME_WITHOUT_POSITION':
      r = m.match(/^(\w+) for (\S+) on (\d{4}-\d{2}-\d{2})/);
      p = r ? { ...base, symbol: sym(r[2]), date: day(r[3]), type: c.t(`tx.type.${r[1]}`, { defaultValue: r[1] }) } : base;
      break;
    case 'CURRENCY_MISMATCH':
      r = m.match(new RegExp(`currency ${CCY} differs from instrument currency ${CCY}`));
      p = r ? { ...base, from: r[1]!, to: r[2]! } : undefined;
      break;
    case 'FUTURE_DATE':
      r = m.match(/Date (\d{4}-\d{2}-\d{2})/);
      p = { ...base, date: r ? day(r[1]) : base.date! };
      break;
  }
  if (p) {
    const s = c.t(`diag.vtext.${i.code}`, { ...p, defaultValue: '' });
    if (s) return s;
  }
  const label = c.t(`diag.code.${i.code}`, { defaultValue: '' });
  if (label) return [label, base.symbol, base.date].filter(Boolean).join(' · ');
  return cleanMessage(m, c.instruments, c.locale);
}

/** Core R7: "close to a factor of 10" / "1/100" in a TRADE_PRICE_UNIT_SUSPECT message. */
export function unitFactor(message: string): number | undefined {
  const m = message.match(/close to a factor of (1\/)?(\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  const v = Number(m[2]);
  return m[1] ? 1 / v : v;
}

/**
 * Core R7: POSSIBLE_UNRECORDED_SPLIT → instrument, ratio (new shares per old share) and the date of
 * the first close after it. The ratio comes from the two closes in the message (old / new price,
 * snapped to the usual split factors), not from the label wording.
 */
const SPLIT_FACTORS = [2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50, 100];
export function splitSuggestion(
  message: string,
  data?: Record<string, string | number>,
): { instrumentId: string; ratio: number; date: string } | undefined {
  // Core R8: structured fields (no text parsing) when the engine provides them.
  if (data && typeof data.splitRatio === 'number' && data.splitRatio > 0 && data.instrumentId && data.dateTo)
    return { instrumentId: String(data.instrumentId), ratio: data.splitRatio, date: String(data.dateTo) };
  const m = message.match(/^The price of (\S+) went from (-?[\d.]+) \((\d{4}-\d{2}-\d{2})\) to (-?[\d.]+) \((\d{4}-\d{2}-\d{2})\)/);
  if (!m) return undefined;
  const a = Number(m[2]);
  const b = Number(m[4]);
  if (!(a > 0 && b > 0)) return undefined;
  const r = a / b;
  const snap = (x: number) => SPLIT_FACTORS.reduce((best, k) => (Math.abs(Math.log(x / k)) < Math.abs(Math.log(x / best)) ? k : best), SPLIT_FACTORS[0]!);
  return { instrumentId: m[1]!, date: m[5]!, ratio: r >= 1 ? snap(r) : 1 / snap(1 / r) };
}

/** Validation issue RENAMED_TICKER_MIXED: "<old> and <new> are the same security…". */
export function renamedPair(message: string): { from: string; to: string } | undefined {
  const m = message.match(/^(\S+) and (\S+) are the same security/);
  return m ? { from: m[1]!, to: m[2]! } : undefined;
}
