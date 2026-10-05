/**
 * European Central Bank euro foreign exchange reference rates (published ~16:00 CET on TARGET
 * business days), via the SDMX REST API in CSV:
 *   https://data-api.ecb.europa.eu/service/data/EXR/D.USD+BRL.EUR.SP00.A?startPeriod=2025-01-01&endPeriod=2025-01-31&format=csvdata
 * Columns include KEY, FREQ, CURRENCY, CURRENCY_DENOM, ..., TIME_PERIOD, OBS_VALUE, ... with
 * quoted fields that contain commas (TITLE_COMPL). OBS_VALUE = units of CURRENCY per 1 EUR.
 *
 * Supports EUR/X, X/EUR and crosses between two ECB currencies (computed through EUR on the
 * same date, which is how the ECB itself recommends deriving cross rates).
 * COP, CLP and PEN are NOT ECB reference currencies.
 *
 * Not reachable from the build container; tested with fixtures in test/fixtures/ecb.
 */
import type { FxPoint, ISODate, ProviderId } from '@pm/core';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { roundSig } from '../series';
import type { FxProvider } from './types';

export const ECB_CURRENCIES = [
  'USD', 'JPY', 'BGN', 'CZK', 'DKK', 'GBP', 'HUF', 'PLN', 'RON', 'SEK', 'CHF', 'ISK', 'NOK', 'TRY',
  'AUD', 'BRL', 'CAD', 'CNY', 'HKD', 'IDR', 'ILS', 'INR', 'KRW', 'MXN', 'MYR', 'NZD', 'PHP', 'SGD',
  'THB', 'ZAR',
] as const;

const isEcb = (c: string) => c === 'EUR' || (ECB_CURRENCIES as readonly string[]).includes(c);

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
  }
  return rows;
}

/** ECB SDMX CSV -> map currency -> points (units of currency per 1 EUR). */
export function parseEcbCsv(text: string): Map<string, FxPoint[]> {
  const rows = parseCsv(text);
  const header = rows[0] ?? [];
  const iCur = header.indexOf('CURRENCY');
  const iDate = header.indexOf('TIME_PERIOD');
  const iVal = header.indexOf('OBS_VALUE');
  const out = new Map<string, FxPoint[]>();
  if (iCur < 0 || iDate < 0 || iVal < 0) return out;
  for (const r of rows.slice(1)) {
    const cur = r[iCur];
    const date = r[iDate];
    const rate = Number(r[iVal]);
    if (!cur || !date || !Number.isFinite(rate) || rate <= 0) continue;
    const list = out.get(cur) ?? [];
    list.push({ date, rate });
    out.set(cur, list);
  }
  for (const list of out.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

export interface EcbOptions {
  http: HttpClient;
  baseUrl?: string;
}

export class EcbProvider implements FxProvider {
  readonly id: ProviderId = 'ecb';
  readonly official = true;
  private readonly base: string;

  constructor(private readonly opts: EcbOptions) {
    this.base = opts.baseUrl ?? 'https://data-api.ecb.europa.eu/service/data/EXR';
  }

  supports(base: string, quote: string): boolean {
    return base !== quote && isEcb(base) && isEcb(quote);
  }

  async eurRates(currencies: string[], from: ISODate, to: ISODate): Promise<Map<string, FxPoint[]>> {
    const key = `D.${currencies.join('+')}.EUR.SP00.A`;
    const text = await this.opts.http.getText(`${this.base}/${key}?startPeriod=${from}&endPeriod=${to}&format=csvdata`, {
      Accept: 'text/csv',
    });
    return parseEcbCsv(text);
  }

  async daily(base: string, quote: string, from: ISODate, to: ISODate): Promise<FxPoint[]> {
    if (!this.supports(base, quote)) throw new MarketDataError('UNSUPPORTED', `ECB does not cover ${base}/${quote}`);
    const legs = [base, quote].filter((c) => c !== 'EUR');
    const rates = await this.eurRates(legs, from, to);
    const per = (c: string) => {
      const pts = rates.get(c);
      if (!pts?.length) throw new MarketDataError('NOT_FOUND', `ECB: no ${c}/EUR reference rates in ${from}..${to}`);
      return new Map(pts.map((p) => [p.date, p.rate]));
    };
    // rate(base->quote) = (quote per EUR) / (base per EUR)
    const q = quote === 'EUR' ? undefined : per(quote);
    const b = base === 'EUR' ? undefined : per(base);
    const dates = [...(q ?? b)!.keys()].sort();
    const out: FxPoint[] = [];
    for (const d of dates) {
      const qv = q ? q.get(d) : 1;
      const bv = b ? b.get(d) : 1;
      if (qv === undefined || bv === undefined) continue;
      out.push({ date: d, rate: roundSig(qv / bv, 10) });
    }
    return out;
  }
}
