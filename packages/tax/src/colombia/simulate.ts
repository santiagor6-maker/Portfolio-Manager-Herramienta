import type { ISODate, MarketData } from '@pm/core';
import { daysBetween } from '../common/dates';
import type { TaxInput } from '../common/types';
import { sum } from '../common/util';
import { buildColombiaTaxReport, type ColombiaReportOptions, type CoSaleRow } from './report';

export interface CoSaleSimulationInput {
  instrumentId: string;
  quantity: number;
  price: number;
  date: ISODate;
  currency: string;
  fees?: number;
}

export interface CoSaleSimulation {
  rows: CoSaleRow[];
  proceedsCop: number;
  gainCop: number;
  nonDeductibleLossCop: number;
  /** Additional ganancia ocasional tax of the year. */
  deltaGananciaOcasionalTaxCop: number;
  /** Additional renta líquida in the cédula general (taxed at the marginal Art. 241 rate). */
  deltaRentaOrdinariaCop: number;
  /** Additional cédula general tax when the report can estimate it (otherCedulaGeneralIncomeCop). */
  deltaCedulaGeneralTaxCop?: number;
  note: string;
}

/** "How much tax if I sell now?" for a Colombian resident (FIFO lots, Art. 153, Art. 36-1). */
export function simulateColombiaSale(
  input: TaxInput,
  sale: CoSaleSimulationInput,
  opts: Omit<ColombiaReportOptions, 'year'> = {},
): CoSaleSimulation {
  const year = Number(sale.date.slice(0, 4));
  const o = { ...opts, year, realization: 'trade' as const };
  const before = buildColombiaTaxReport(input, o);
  const hypo = {
    id: '__simulated_sale__',
    portfolioId: 'sim',
    date: sale.date,
    type: 'SELL' as const,
    instrumentId: sale.instrumentId,
    quantity: sale.quantity,
    price: sale.price,
    fees: sale.fees,
    currency: sale.currency,
  };
  const after = buildColombiaTaxReport({ ...input, transactions: [...input.transactions, hypo] }, o);
  const rows = after.ventas.rows.filter((r) => r.transactionId === hypo.id);
  const tb = before.ventas.totals;
  const ta = after.ventas.totals;
  const incB = before.impuestoEstimado?.impuestoCedulaGeneralIncrementalCop;
  const incA = after.impuestoEstimado?.impuestoCedulaGeneralIncrementalCop;
  return {
    rows,
    proceedsCop: sum(rows.map((r) => r.proceedsCop)),
    gainCop: sum(rows.map((r) => r.gainCop)),
    nonDeductibleLossCop: sum(rows.map((r) => r.nonDeductibleLossCop)),
    deltaGananciaOcasionalTaxCop: ta.gananciaOcasional.impuestoEstimadoCop - tb.gananciaOcasional.impuestoEstimadoCop,
    deltaRentaOrdinariaCop: ta.rentaOrdinaria.rentaLiquidaCop - tb.rentaOrdinaria.rentaLiquidaCop,
    deltaCedulaGeneralTaxCop: incA !== undefined && incB !== undefined ? incA - incB : undefined,
    note:
      'En Colombia las pérdidas en venta de acciones no son deducibles (Art. 153 ET): vender con pérdida no reduce el impuesto ' +
      'de otras ventas (no hay "tax-loss harvesting").',
  };
}

export interface CoLotMilestone {
  instrumentId: string;
  symbol: string;
  openDate: ISODate;
  quantity: number;
  costCop: number;
  /** First date on which a sale of the lot is ganancia ocasional (>= 2 years). */
  gananciaOcasionalFrom: ISODate;
  daysRemaining: number;
  /** Informative unrealized gain at the price and TRM of `asOf`. */
  unrealizedCop?: number;
}

/** Open lots that will turn into ganancia ocasional (held >= 2 years), sorted by date. */
export function colombiaLotMilestones(
  input: TaxInput,
  asOf: ISODate,
  opts: Omit<ColombiaReportOptions, 'year'> = {},
  market: MarketData = input.market,
): CoLotMilestone[] {
  const r = buildColombiaTaxReport(
    { ...input, transactions: input.transactions.filter((t) => t.date <= asOf) },
    { ...opts, year: Number(asOf.slice(0, 4)) },
  );
  const out: CoLotMilestone[] = [];
  for (const row of r.patrimonio.rows) {
    if (row.kind !== 'inversion' || !row.lots || !row.instrumentId) continue;
    const price = market.price(row.instrumentId, asOf);
    const fx = row.currency === 'COP' ? 1 : market.fx(row.currency, 'COP', asOf);
    for (const lot of row.lots) {
      out.push({
        instrumentId: row.instrumentId,
        symbol: row.symbol ?? row.instrumentId,
        openDate: lot.openDate,
        quantity: lot.quantity,
        costCop: lot.costCop,
        gananciaOcasionalFrom: lot.gananciaOcasionalFrom,
        daysRemaining: Math.max(0, daysBetween(asOf, lot.gananciaOcasionalFrom)),
        unrealizedCop: price !== undefined && fx !== undefined ? lot.quantity * price * fx - lot.costCop : undefined,
      });
    }
  }
  return out.sort((a, b) => a.gananciaOcasionalFrom.localeCompare(b.gananciaOcasionalFrom));
}
