/**
 * Listing notices (review R6, M41): a listing that stopped trading on a venue WITHOUT a ratio event
 * (no rename, merger or conversion to model), e.g. Telefónica's NYSE ADS. These are not part of the
 * shared rename table (@pm/core TICKER_EVENTS): holders keep the same security, only the venue or the
 * provider coverage changed. A response for such a listing carries the notice and a suggestion.
 */
import type { ISODate } from '@pm/core';

export interface ListingNotice {
  /** The listing that stopped (e.g. XNYS:TEF). */
  instrumentId: string;
  /** Its bare Yahoo symbol (Yahoo answers 404 for it now). */
  yahoo: string;
  /** Last trading day on that venue. */
  lastTradingDay?: ISODate;
  /** `lastTradingDay` is an estimate (no exchange notice with the exact date was found). */
  approximate?: boolean;
  /** Where the same security still trades. */
  suggest?: string;
  note: string;
  sources: string[];
}

export const LISTING_NOTICES: readonly ListingNotice[] = [
  {
    instrumentId: 'XNYS:TEF',
    yahoo: 'TEF',
    lastTradingDay: '2026-01-20',
    approximate: true,
    suggest: 'XMAD:TEF',
    note:
      'Telefónica deslistó voluntariamente sus ADS de la NYSE (anunciado en diciembre de 2025, completado hacia el 2026-01-20); el programa de ADR pasó a Level 1 (OTC) y los tenedores podían canjear los ADS por acciones ordinarias en las bolsas españolas (XMAD:TEF). Los precios de NYSE ya no están disponibles en el proveedor.',
    sources: [
      'https://www.telefonica.com/en/communication-room/press-room/telefonica-announces-intention-listing-nyse/',
      'https://www.solactive.com/announcements/57516',
    ],
  },
];

/** Notice for a listing id or its bare Yahoo symbol (case-insensitive). */
export function listingNoticeFor(key: string): ListingNotice | undefined {
  const k = key.trim().toUpperCase();
  return LISTING_NOTICES.find((n) => n.instrumentId === k || n.yahoo === k);
}
