/**
 * Adapter over @pm/tax. Builds the common TaxInput from local data and runs the reports with
 * per-report error isolation.
 */
import * as core from '@pm/core';
import {
  brazilApuracaoCsv,
  brazilMonthlyApuracao,
  brazilProventosReport,
  buildColombiaTaxReport,
  colombiaAccountantCsv,
  TAX_DISCLAIMER,
  type BrApuracaoReport,
  type BrProventosReport,
  type ColombiaTaxReport,
  type TaxInput,
} from '@pm/tax';
import { loadDataset } from './engineDirect';

export { TAX_DISCLAIMER, colombiaAccountantCsv, brazilApuracaoCsv };
export type { BrApuracaoReport, BrProventosReport, ColombiaTaxReport };

export interface TaxReports {
  colombia?: ColombiaTaxReport;
  brazil?: BrApuracaoReport;
  proventos?: BrProventosReport;
  errors: Record<string, string>;
}

export async function buildTaxInput(portfolioId: string): Promise<TaxInput> {
  const ds = await loadDataset();
  const market = core.createMarketData({ prices: ds.prices, fx: ds.fx, manualPrices: ds.manualPrices });
  return {
    transactions: portfolioId === 'all' ? ds.transactions : ds.transactions.filter((t) => t.portfolioId === portfolioId),
    instruments: ds.instruments,
    market,
  };
}

export async function runTaxReports(country: 'CO' | 'BR', year: number, portfolioId: string): Promise<TaxReports> {
  const input = await buildTaxInput(portfolioId);
  const out: TaxReports = { errors: {} };
  const attempt = <T>(k: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      out.errors[k] = e instanceof Error ? e.message : String(e);
      return undefined;
    }
  };
  if (country === 'CO') out.colombia = attempt('colombia', () => buildColombiaTaxReport(input, { year }));
  else {
    out.brazil = attempt('brazil', () => brazilMonthlyApuracao(input, { year }));
    out.proventos = attempt('proventos', () => brazilProventosReport(input, { year }));
  }
  return out;
}
