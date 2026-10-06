/**
 * Stooq (keyless daily CSV):
 *   GET https://stooq.com/q/d/l/?s=aapl.us&d1=20250101&d2=20250131&i=d[&apikey=...]
 *   -> "Date,Open,High,Low,Close,Volume\n2025-01-02,248.93,249.1,241.82,243.85,55740731"
 * Coverage used here: US (.us), Xetra (.de), Tokyo (.jp), Hong Kong (.hk) and a few indices.
 * Closes are split-adjusted, so results are flagged `split-adjusted` and cached briefly.
 * If stooq starts requiring a key, set STOOQ_API_KEY. Not reachable from the build container.
 */
import type { ISODate, ProviderId } from '@pm/core';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { parseCsv } from './ecb';
import { mapHttpError, simpleHistory } from './common';
import type { PriceProvider, PriceTarget, ProviderHistory } from './types';
import { US_MICS } from '../symbols';

const SUFFIX: Record<string, string> = { XETR: '.de', XTKS: '.jp', XHKG: '.hk' };
const INDICES: Record<string, string> = { '^GSPC': '^spx', '^DJI': '^dji', '^IXIC': '^ndq', '^GDAXI': '^dax' };

export function stooqSymbol(t: PriceTarget): string | undefined {
  if (t.exchange === 'INDEX') return INDICES[t.symbol.toUpperCase()];
  if (US_MICS.includes(t.exchange) && t.exchange !== 'OTC') return `${t.symbol.toLowerCase()}.us`;
  const suf = SUFFIX[t.exchange];
  return suf ? `${t.symbol.toLowerCase()}${suf}` : undefined;
}

export class StooqProvider implements PriceProvider {
  readonly id: ProviderId = 'stooq';

  constructor(private readonly opts: { http: HttpClient; apiKey?: string; baseUrl?: string }) {}

  supports(t: PriceTarget): boolean {
    return !!stooqSymbol(t);
  }

  async dailyHistory(t: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const s = stooqSymbol(t);
    if (!s) throw new MarketDataError('UNSUPPORTED', `stooq does not cover ${t.instrumentId}`);
    const qs = new URLSearchParams({ s, d1: from.replace(/-/g, ''), d2: to.replace(/-/g, ''), i: 'd' });
    if (this.opts.apiKey) qs.set('apikey', this.opts.apiKey);
    let text: string;
    try {
      text = await this.opts.http.getText(`${this.opts.baseUrl ?? 'https://stooq.com'}/q/d/l/?${qs.toString()}`, { Accept: 'text/csv' });
    } catch (e) {
      mapHttpError('stooq', e);
    }
    const rows = parseCsv(text);
    const header = rows[0]?.map((h) => h.toLowerCase()) ?? [];
    const iDate = header.indexOf('date');
    const iClose = header.indexOf('close');
    if (iDate < 0 || iClose < 0) {
      throw new MarketDataError(/no data/i.test(text) ? 'NOT_FOUND' : 'UPSTREAM_ERROR', `stooq: unexpected response for ${s}: ${text.slice(0, 80)}`);
    }
    const points = rows.slice(1).map((r) => ({ date: r[iDate] ?? '', close: Number(r[iClose]) }));
    const currency = t.currency ?? (US_MICS.includes(t.exchange) || t.exchange === 'INDEX' ? 'USD' : 'EUR');
    return simpleHistory(t, this.id, currency, points, from, to, 'split-adjusted');
  }
}
