import type { ISODate, MarketData, YearMonth } from '@pm/core';
import { monthOf } from '../common/dates';
import type { TaxInput } from '../common/types';
import { sum } from '../common/util';
import { brazilMonthlyApuracao, type BrApuracaoOptions } from './apuracao';
import { brazilConfig } from './config';
import { runBrazilB3Ledger } from './ledger';

export interface BrSaleSimulationInput {
  instrumentId: string;
  quantity: number;
  price: number;
  date: ISODate;
  fees?: number;
  account?: string;
}

export interface BrSaleSimulation {
  month: YearMonth;
  /** Result of the simulated sale against preço médio (or day trade if a same-day buy exists). */
  result: number;
  salesAcoesBefore: number;
  salesAcoesAfter: number;
  exemptBefore: boolean;
  exemptAfter: boolean;
  /** Remaining R$ 20k exemption headroom in the month before the sale (shares only). */
  headroomBefore: number;
  taxBefore: number;
  taxAfter: number;
  /** Additional tax of the month caused by the sale (can be negative when a loss offsets gains). */
  deltaTax: number;
  /** Loss carryforward at the end of the month, after the sale. */
  lossesAfter: { comum: number; dayTrade: number; fii: number };
  note?: string;
}

/** "How much tax if I sell now?" — reruns the month's apuração with a hypothetical sale. */
export function simulateBrazilSale(
  input: TaxInput,
  sale: BrSaleSimulationInput,
  opts: Omit<BrApuracaoOptions, 'year' | 'from' | 'to'> = {},
): BrSaleSimulation {
  const month = monthOf(sale.date);
  const base = brazilMonthlyApuracao(input, { ...opts, from: month, to: month });
  const hypo = {
    id: '__simulated_sale__',
    portfolioId: 'sim',
    date: sale.date,
    type: 'SELL' as const,
    instrumentId: sale.instrumentId,
    quantity: sale.quantity,
    price: sale.price,
    fees: sale.fees,
    account: sale.account,
    currency: 'BRL',
  };
  const after = brazilMonthlyApuracao({ ...input, transactions: [...input.transactions, hypo] }, { ...opts, from: month, to: month });
  const b = base.months[0]!;
  const a = after.months[0]!;
  const limit = (opts.config ?? brazilConfig)(Number(month.slice(0, 4))).stockSalesExemptionLimit;
  const simTrades = a.trades.filter((t) => t.transactionIds.includes(hypo.id));
  return {
    month,
    result: sum(simTrades.map((t) => t.result)),
    salesAcoesBefore: b.salesAcoesSwing,
    salesAcoesAfter: a.salesAcoesSwing,
    exemptBefore: b.exempt,
    exemptAfter: a.exempt,
    headroomBefore: Math.max(0, limit - b.salesAcoesSwing),
    taxBefore: b.taxGross,
    taxAfter: a.taxGross,
    deltaTax: a.taxGross - b.taxGross,
    lossesAfter: after.lossesAtEnd,
    note: after.openShorts.some((s) => s.instrumentId === sale.instrumentId)
      ? 'A quantidade simulada excede a posição: o excedente seria venda a descoberto.'
      : undefined,
  };
}

/** Remaining R$ 20k exemption headroom for shares in a month. */
export function brazilExemptionHeadroom(input: TaxInput, month: YearMonth): { salesAcoes: number; limit: number; headroom: number } {
  const r = brazilMonthlyApuracao(input, { from: month, to: month });
  const limit = brazilConfig(Number(month.slice(0, 4))).stockSalesExemptionLimit;
  const sales = r.months[0]?.salesAcoesSwing ?? 0;
  return { salesAcoes: sales, limit, headroom: Math.max(0, limit - sales) };
}

export interface BrUnrealizedRow {
  instrumentId: string;
  symbol: string;
  category: string;
  quantity: number;
  averageCost: number;
  price?: number;
  marketValue?: number;
  unrealized?: number;
  /** Tax if the whole position were sold on `asOf` alone (ignores carryforward and other sales). */
  taxIfSold?: number;
  /** Shares only: could be sold within the remaining monthly exemption. */
  fitsExemption?: boolean;
  /** Unrealized loss that could offset gains (tax-loss harvesting candidate). */
  harvestCandidate: boolean;
}

/** Unrealized gains/losses of B3 positions with a naive tax-if-sold estimate. */
export function brazilUnrealizedReport(input: TaxInput, asOf: ISODate, market: MarketData = input.market): BrUnrealizedRow[] {
  const led = runBrazilB3Ledger(input, { until: asOf });
  const cfg = brazilConfig(Number(asOf.slice(0, 4)));
  const headroom = brazilExemptionHeadroom(input, monthOf(asOf)).headroom;
  return led.positions.map((p) => {
    const price = market.price(p.instrumentId, asOf);
    const mv = price !== undefined ? price * p.quantity : undefined;
    const un = mv !== undefined ? mv - p.totalCost : undefined;
    const rate = p.category === 'FII' ? cfg.fiiRate : cfg.swingRate;
    const fits = p.category === 'ACAO' && mv !== undefined ? mv <= headroom : undefined;
    return {
      instrumentId: p.instrumentId,
      symbol: p.symbol,
      category: p.category,
      quantity: p.quantity,
      averageCost: p.averageCost,
      price,
      marketValue: mv,
      unrealized: un,
      taxIfSold: un === undefined ? undefined : p.category === 'ETF_RF' ? 0 : fits ? 0 : Math.max(0, un) * rate,
      fitsExemption: fits,
      harvestCandidate: un !== undefined && un < 0 && p.category !== 'ETF_RF',
    };
  });
}
