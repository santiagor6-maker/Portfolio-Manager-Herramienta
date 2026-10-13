import type { MarketData, Transaction } from '@pm/core';
import type { TaxIssue } from './types';

/**
 * Corporate restructurings of the core contract (`Transaction.subtype` on a SPLIT, T64/T65):
 * - MERGER / TICKER_CHANGE: every lot moves to `targetInstrumentId` at `ratio` new shares per old
 *   share; cost and acquisition dates are preserved (not a disposal). Optional `amount` = cash
 *   received (merger cash / cash in lieu): a partial disposal of the parent.
 * - SPINOFF: the parent keeps its shares; `targetInstrumentId` receives `ratio` shares per share
 *   held, with `costFraction` of the parent cost and the parent's acquisition dates.
 *
 * Mirrors `@pm/core` ledger semantics (LotBook.extractAll / carveOutCost + scale by ratio, cash
 * allocated by value when the target has a price, else by cost). Core's lot book is not part of its
 * public contract, so each tax ledger applies the same rule to its own lots (FIFO in Colombia, preço
 * médio in Brazil) through the helpers below.
 */
export type RestructureKind = 'SPINOFF' | 'MERGER' | 'TICKER_CHANGE';

export interface Restructure {
  kind: RestructureKind;
  /** Receiving instrument ('' when missing: the action is not applied, error issued). */
  target: string;
  /** New shares per old share (default 1). */
  ratio: number;
  /** SPINOFF: share of the parent cost moved to the target (0..1). MERGER/TICKER_CHANGE: 1. */
  costFraction: number;
  /** MERGER/TICKER_CHANGE: cash received (in the transaction currency); 0 for SPINOFF. */
  cash: number;
}

export function restructureOf(t: Transaction): Restructure | undefined {
  if (t.type !== 'SPLIT') return undefined;
  const k = t.subtype;
  if (k !== 'SPINOFF' && k !== 'MERGER' && k !== 'TICKER_CHANGE') return undefined;
  const ratio = t.ratio !== undefined && t.ratio > 0 ? t.ratio : 1;
  const cf = k === 'SPINOFF' ? Math.min(1, Math.max(0, t.costFraction ?? 0)) : 1;
  return { kind: k, target: t.targetInstrumentId ?? '', ratio, costFraction: cf, cash: k === 'SPINOFF' ? 0 : Math.max(0, t.amount ?? 0) };
}

/** True for SPLIT rows that are restructurings (never a plain ratio change on the same instrument). */
export const isRestructure = (t: Transaction) => restructureOf(t) !== undefined;

/**
 * Share (0..1) of the parent cost that the cash part of a merger represents (core C38 rule): by
 * value when the target has a price on the date, otherwise cash over cost (capped at 1).
 */
export function mergerCashCostFraction(
  r: Restructure,
  parentQty: number,
  parentCost: number,
  market: MarketData | undefined,
  date: string,
  cashInCostCurrency: number,
): number {
  if (r.cash <= 0 || parentQty <= 0) return 0;
  const pT = market?.price(r.target, date);
  if (pT !== undefined && pT > 0) {
    const sharesValue = parentQty * r.ratio * pT;
    return cashInCostCurrency / (cashInCostCurrency + sharesValue);
  }
  return parentCost > 0 ? Math.min(1, cashInCostCurrency / parentCost) : 0;
}

/** Issues for an unusable or incomplete restructuring (missing target, SPINOFF without costFraction). */
export function restructureIssues(t: Transaction, r: Restructure, symbol: string, lang: 'es' | 'pt' = 'pt'): TaxIssue[] {
  const out: TaxIssue[] = [];
  if (!r.target) {
    out.push({
      level: 'error',
      code: 'CORPORATE_ACTION_NO_TARGET',
      transactionId: t.id,
      instrumentId: t.instrumentId,
      message:
        lang === 'es'
          ? `${r.kind} de ${symbol} sin instrumento destino (targetInstrumentId): no se aplicó; las posiciones quedan en el ticker anterior.`
          : `${r.kind} de ${symbol} sem instrumento de destino (targetInstrumentId): não aplicado; a posição continua no ticker anterior.`,
    });
  }
  if (r.kind === 'SPINOFF' && t.costFraction === undefined) {
    out.push({
      level: 'warning',
      code: 'SPINOFF_COST_FRACTION_MISSING',
      transactionId: t.id,
      instrumentId: t.instrumentId,
      message:
        lang === 'es'
          ? `Escisión de ${symbol} sin costFraction: las acciones nuevas quedan con costo 0 y la matriz con todo el costo. Indique la proporción del costo que informó el emisor.`
          : `Cisão de ${symbol} sem costFraction: as ações novas ficam com custo 0 e a original com todo o custo. Informe a proporção do custo do fato relevante.`,
    });
  }
  return out;
}

/** Same-day processing order: restructurings before anything else of that day (core order). */
export const restructureFirst = (a: Transaction, b: Transaction) => (isRestructure(a) ? 0 : 1) - (isRestructure(b) ? 0 : 1);
