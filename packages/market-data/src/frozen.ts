/**
 * Frozen histories (review R3, M29): as-traded closes of securities that no longer trade
 * (BRFS3, NTCO3, CPLE6, CPLE5, CPLE11...) recorded ONCE from a source that still had them, and
 * served for their own ticker when no live provider has them anymore. They are immutable.
 *
 * File format (one JSON per security, e.g. BVMF_BRFS3.json):
 *   { "instrumentId": "BVMF:BRFS3", "currency": "BRL", "source": "brapi 2025-10-01",
 *     "points": [{ "date": "2024-01-02", "close": 15.12 }, ...],
 *     "dividends": [{ "date": "2024-03-01", "amount": 0.5 }] }
 * The server loads every *.json of MD_FROZEN_DIR; `scripts/record-frozen.ts` records them on a
 * machine with access to a source (brapi with BRAPI_TOKEN, or a CSV exported from a broker).
 */
import type { CurrencyCode, ISODate, PricePoint } from '@pm/core';
import { MarketDataError } from './errors';
import type { DividendEvent } from './providers/types';
import { dedupeByDate } from './series';

export interface FrozenHistory {
  instrumentId: string;
  currency: CurrencyCode;
  /** Where and when the data was recorded. */
  source: string;
  points: PricePoint[];
  dividends?: DividendEvent[];
}

export function validateFrozen(x: unknown): FrozenHistory {
  const f = x as FrozenHistory;
  if (!f || typeof f.instrumentId !== 'string' || !/^[A-Z]{2,8}:[A-Z0-9.-]{1,32}$/i.test(f.instrumentId) || typeof f.currency !== 'string' || !Array.isArray(f.points)) {
    throw new MarketDataError('BAD_REQUEST', 'Invalid frozen history file (instrumentId, currency, points[] required)');
  }
  const points = dedupeByDate(
    f.points.filter((p) => p && /^\d{4}-\d{2}-\d{2}$/.test(String(p.date)) && Number.isFinite(p.close) && p.close > 0).map((p) => ({ date: p.date as ISODate, close: Number(p.close) })),
  );
  const dividends = (f.dividends ?? []).filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date)) && Number.isFinite(d.amount) && d.amount > 0);
  return { instrumentId: f.instrumentId.toUpperCase(), currency: f.currency.toUpperCase(), source: String(f.source ?? 'frozen'), points, dividends };
}
