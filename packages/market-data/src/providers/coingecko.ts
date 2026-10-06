/**
 * CoinGecko (crypto). Reachable keyless; verified 2026-10-05:
 *   GET https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily
 *   -> { prices: [[epochMs, price], ...] }  (one point per day at 00:00 UTC + the current price)
 * Public (keyless) access is limited to the last 365 days; COP is NOT a supported vs_currency
 * (USD, EUR, BRL, MXN, CLP, GBP, CHF... are). Optional COINGECKO_API_KEY (demo key header).
 * A point stamped D 00:00 UTC is the price at the end of D-1 (UTC), so we date it D-1.
 */
import type { FxPoint, ISODate, ProviderId } from '@pm/core';
import { addDays, daysBetween, todayISO } from '../dates';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { dedupeByDate, roundSig, sliceRange } from '../series';
import { mapHttpError, simpleHistory } from './common';
import type { FxProvider, PriceProvider, PriceTarget, ProviderHistory } from './types';

export const COINGECKO_IDS: Readonly<Record<string, string>> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', USDT: 'tether', USDC: 'usd-coin', BNB: 'binancecoin',
  XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin', LTC: 'litecoin', DOT: 'polkadot', AVAX: 'avalanche-2',
  LINK: 'chainlink', TRX: 'tron', MATIC: 'matic-network',
};

export const COINGECKO_VS = ['USD', 'EUR', 'BRL', 'MXN', 'CLP', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'ARS'];

export class CoinGeckoProvider implements PriceProvider {
  readonly id: ProviderId = 'coingecko';

  constructor(private readonly opts: { http: HttpClient; apiKey?: string; baseUrl?: string; now?: () => Date }) {}

  private pair(t: PriceTarget): { coin: string; vs: string } | undefined {
    const m = /^([A-Z0-9]+)-([A-Z]{3})$/.exec(t.symbol.toUpperCase());
    if (!m || t.exchange !== 'CRYPTO') return undefined;
    const coin = COINGECKO_IDS[m[1]!];
    return coin && COINGECKO_VS.includes(m[2]!) ? { coin, vs: m[2]! } : undefined;
  }

  supports(t: PriceTarget): boolean {
    return !!this.pair(t);
  }

  async prices(coin: string, vs: string, from: ISODate, to: ISODate): Promise<FxPoint[]> {
    const today = todayISO(this.opts.now?.());
    const days = Math.min(365, Math.max(1, daysBetween(from, today) + 2));
    const qs = new URLSearchParams({ vs_currency: vs.toLowerCase(), days: String(days), interval: 'daily' });
    const headers: Record<string, string> = this.opts.apiKey ? { 'x-cg-demo-api-key': this.opts.apiKey } : {};
    let body: { prices?: [number, number][]; error?: unknown };
    try {
      body = await this.opts.http.getJson(`${this.opts.baseUrl ?? 'https://api.coingecko.com/api/v3'}/coins/${coin}/market_chart?${qs.toString()}`, headers);
    } catch (e) {
      mapHttpError('coingecko', e);
    }
    if (!body.prices?.length) throw new MarketDataError('NOT_FOUND', `coingecko: no prices for ${coin}/${vs}`);
    const pts = body.prices.map(([ms, price], i, arr) => {
      const iso = new Date(ms).toISOString().slice(0, 10);
      // The last element is the live price (not at midnight): keep its own date.
      const date = i === arr.length - 1 && new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() > 0 ? iso : addDays(iso, -1);
      return { date, rate: roundSig(price, 10) };
    });
    return sliceRange(dedupeByDate(pts), from, to);
  }

  async dailyHistory(t: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const p = this.pair(t);
    if (!p) throw new MarketDataError('UNSUPPORTED', `coingecko does not cover ${t.instrumentId}`);
    const pts = await this.prices(p.coin, p.vs, from, to);
    const notes = daysBetween(from, todayISO(this.opts.now?.())) > 365 ? ['coingecko keyless: only the last 365 days'] : [];
    return simpleHistory(t, this.id, p.vs, pts.map((x) => ({ date: x.date, close: x.rate })), from, to, 'as-traded', { notes });
  }
}

/** Crypto FX pairs (BTC/USD, ETH/BRL...) as fallback after Yahoo's BTC-USD style symbols. */
export class CoinGeckoFxProvider implements FxProvider {
  readonly id: ProviderId = 'coingecko';
  readonly official = false;
  constructor(private readonly cg: CoinGeckoProvider) {}

  supports(base: string, quote: string): boolean {
    return (!!COINGECKO_IDS[base] && COINGECKO_VS.includes(quote)) || (!!COINGECKO_IDS[quote] && COINGECKO_VS.includes(base));
  }

  async daily(base: string, quote: string, from: ISODate, to: ISODate): Promise<FxPoint[]> {
    if (COINGECKO_IDS[base]) return this.cg.prices(COINGECKO_IDS[base]!, quote, from, to);
    const pts = await this.cg.prices(COINGECKO_IDS[quote]!, base, from, to);
    return pts.map((p) => ({ date: p.date, rate: 1 / p.rate }));
  }
}
