/**
 * brapi.dev (Brazil, B3). Documented API:
 *   GET https://brapi.dev/api/quote/{TICKER}?range=1y&interval=1d&dividends=true[&token=...]
 *   -> { results: [{ symbol, currency, longName, regularMarketPrice, regularMarketTime,
 *        historicalDataPrice: [{ date: epochSeconds, open, high, low, close, volume, adjustedClose }],
 *        dividendsData: { cashDividends: [{ rate, label: 'DIVIDENDO'|'JCP'|'RENDIMENTO', lastDatePrior, paymentDate, ... }] } }] }
 * Without a token only the documented test tickers work (PETR4, MGLU3, VALE3, ITUB4); set
 * BRAPI_TOKEN for the rest. `close` is the unadjusted close (adjustedClose is separate).
 * Not reachable from the build container: tested with a fixture built from the documented shape.
 */
import type { ISODate, ProviderId } from '@pm/core';
import { dateInZone, todayISO } from '../dates';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { mapHttpError, nextWeekday, rangeToken, simpleHistory } from './common';
import type { DividendEvent, PriceProvider, PriceTarget, ProviderHistory } from './types';

export const BRAPI_FREE_TICKERS = ['PETR4', 'MGLU3', 'VALE3', 'ITUB4'];

interface BrapiResult {
  symbol: string;
  currency?: string;
  longName?: string;
  shortName?: string;
  historicalDataPrice?: { date: number; close: number | null; volume?: number | null }[];
  dividendsData?: {
    cashDividends?: { rate: number; label?: string; lastDatePrior?: string; paymentDate?: string }[];
  };
}

export class BrapiProvider implements PriceProvider {
  readonly id: ProviderId = 'brapi';

  constructor(
    private readonly opts: { http: HttpClient; token?: string; baseUrl?: string; now?: () => Date },
  ) {}

  supports(t: PriceTarget): boolean {
    if (t.exchange === 'INDEX') return t.symbol === '^BVSP' && !!this.opts.token;
    if (t.exchange !== 'BVMF') return false;
    return !!this.opts.token || BRAPI_FREE_TICKERS.includes(t.symbol.toUpperCase());
  }

  private async fetch(t: PriceTarget, from: ISODate): Promise<BrapiResult> {
    const today = todayISO(this.opts.now?.());
    const range = rangeToken(from, today, [['1mo', 31], ['3mo', 92], ['6mo', 183], ['1y', 366], ['2y', 731], ['5y', 1827], ['10y', 3653], ['max', 1e9]]);
    const qs = new URLSearchParams({ range, interval: '1d', dividends: 'true' });
    if (this.opts.token) qs.set('token', this.opts.token);
    const url = `${this.opts.baseUrl ?? 'https://brapi.dev/api'}/quote/${encodeURIComponent(t.symbol)}?${qs.toString()}`;
    let body: { results?: BrapiResult[]; error?: boolean; message?: string };
    try {
      body = await this.opts.http.getJson(url);
    } catch (e) {
      mapHttpError('brapi', e);
    }
    const r = body.results?.[0];
    if (!r) throw new MarketDataError('NOT_FOUND', `brapi: ${body.message ?? 'no result'} (${t.symbol})`);
    return r;
  }

  async dailyHistory(t: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const r = await this.fetch(t, from);
    const points = (r.historicalDataPrice ?? [])
      .filter((p) => p.close != null)
      .map((p) => ({ date: dateInZone(p.date, 'America/Sao_Paulo', -10800), close: p.close as number }));
    return simpleHistory(t, this.id, r.currency ?? 'BRL', points, from, to, 'as-traded', {
      name: r.longName ?? r.shortName,
      dividends: parseBrapiDividends(r),
    });
  }

  /** Dividends with type (JCP vs dividend) and payment date, for enriching Yahoo's. */
  async dividends(t: PriceTarget, from: ISODate): Promise<DividendEvent[]> {
    return parseBrapiDividends(await this.fetch(t, from));
  }
}

export function parseBrapiDividends(r: BrapiResult): DividendEvent[] {
  return (r.dividendsData?.cashDividends ?? [])
    .filter((d) => d.lastDatePrior && Number.isFinite(d.rate) && d.rate > 0)
    .map((d) => {
      const ev: DividendEvent = {
        date: nextWeekday(d.lastDatePrior!.slice(0, 10)),
        amount: d.rate,
        kind: /JCP|JUROS/i.test(d.label ?? '') ? 'JCP' : 'ORDINARY',
      };
      if (d.paymentDate) ev.payDate = d.paymentDate.slice(0, 10);
      return ev;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
