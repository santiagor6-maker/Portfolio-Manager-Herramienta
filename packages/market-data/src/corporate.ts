/**
 * Corporate action classification.
 *
 * Yahoo reports every share-count or price-factor event as a "split" with numerator/denominator.
 * Verified on live data (2026-10-05):
 *  - real splits:        NVDA 10:1, AAPL 4:1, WEGE3 2:1, GE 1:8 (reverse)
 *  - bonificações (B3):  ITUB4 11:10, 3:2 (2018), 110:100 (2025), 103:100; WEGE3 13:10
 *  - spin-offs (US):     GE 1281:1000 (2023-01-04, GE HealthCare), GE 1253:1000 (2024-04-02,
 *                        GE Vernova), MMM 1196:1000 (2024-04-01, Solventum) — here the "ratio"
 *                        is a PRICE factor, the parent share count does not change.
 * Applying a spin-off as a split inflates the parent quantity (GE +25.3 %) and loses the new
 * shares, so spin-offs are typed SPLIT/subtype SPINOFF with `reviewRequired` and are never meant
 * to be applied automatically. Price un-adjustment still uses the factor in every case, because
 * Yahoo divided historical prices by it.
 */
import type { CorporateAction, ISODate } from '@pm/core';
import type { MarketCorporateAction } from './types';

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Known spin-offs: parent Yahoo symbol + ex-date -> receiving instrument and distribution ratio. */
export const KNOWN_SPINOFFS: readonly {
  parent: string;
  date: ISODate;
  targetInstrumentId: string;
  /** New shares received per parent share. */
  ratio: number;
  note: string;
}[] = [
  { parent: 'GE', date: '2024-04-02', targetInstrumentId: 'XNYS:GEV', ratio: 0.25, note: 'GE Vernova spin-off (1 GEV per 4 GE)' },
  { parent: 'GE', date: '2023-01-04', targetInstrumentId: 'XNAS:GEHC', ratio: 1 / 3, note: 'GE HealthCare spin-off (1 GEHC per 3 GE)' },
  { parent: 'MMM', date: '2024-04-01', targetInstrumentId: 'XNYS:SOLV', ratio: 0.25, note: 'Solventum spin-off (1 SOLV per 4 MMM)' },
];

export interface RawSplit {
  date: ISODate;
  numerator: number;
  denominator: number;
}

/** Classify a Yahoo split event for a Yahoo symbol into a typed corporate action. */
export function classifySplit(yahooSymbol: string, s: RawSplit, instrumentId: string): MarketCorporateAction {
  const factor = s.numerator / s.denominator;
  const g = gcd(Math.round(s.numerator), Math.round(s.denominator)) || 1;
  const num = Math.round(s.numerator) / g;
  const den = Math.round(s.denominator) / g;
  const base = { instrumentId, date: s.date, priceFactor: factor, source: 'yahoo' as const };
  const isB3 = /\.SA$/i.test(yahooSymbol);

  const known = KNOWN_SPINOFFS.find((k) => k.parent === yahooSymbol.toUpperCase() && k.date === s.date);
  if (known) {
    return {
      ...base,
      type: 'SPLIT',
      subtype: 'SPINOFF',
      ratio: known.ratio,
      targetInstrumentId: known.targetInstrumentId,
      costFraction: round4(1 - 1 / factor),
      reviewRequired: true,
      note: `${known.note}. costFraction estimated from the ex-date price factor ${s.numerator}:${s.denominator}; confirm with the issuer's cost-basis notice (IRS Form 8937).`,
    };
  }
  if (isB3 && factor > 1 && !Number.isInteger(factor)) {
    return {
      ...base,
      type: 'STOCK_DIVIDEND',
      ratio: factor,
      note: `Bonificação ${num}:${den} (${round4((factor - 1) * 100)} % em ações). For IR the new shares carry the "custo atribuído" announced by the company.`,
    };
  }
  if (num <= 20 && den <= 20) {
    return { ...base, type: 'SPLIT', ratio: factor };
  }
  // Odd factor such as 1253:1000 outside Brazil: almost always a spin-off or special distribution.
  return {
    ...base,
    type: 'SPLIT',
    subtype: 'SPINOFF',
    costFraction: round4(1 - 1 / factor),
    reviewRequired: true,
    note: `Unusual factor ${s.numerator}:${s.denominator}: likely a spin-off or special distribution, not a split. The parent share count does not change; confirm the received instrument and ratio.`,
  };
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/**
 * @deprecated core's CorporateAction now carries every field; market actions are already core
 * actions. Kept for compatibility: returns the actions without the provider-only `priceFactor`.
 */
export function toCoreCorporateActions(actions: readonly MarketCorporateAction[]): CorporateAction[] {
  return actions.map(({ priceFactor: _pf, ...rest }) => rest);
}
