/**
 * Adapter over @pm/tax. Builds the common TaxInput from local data and runs the reports with
 * per-report error isolation.
 */
import * as core from '@pm/core';
import {
  brazilApuracaoCsv,
  brazilMonthlyApuracao,
  brazilProventosReport,
  brazilTaxPack,
  buildColombiaTaxReport,
  colombiaAccountantCsv,
  colombiaTaxPack,
  type BrazilTaxPack,
  type ColombiaTaxPack,
  TAX_DISCLAIMER,
  type BrApuracaoReport,
  type BrProventosReport,
  type ColombiaTaxReport,
  type TaxInput,
} from '@pm/tax';
import { loadDataset } from './engineDirect';

export { TAX_DISCLAIMER, colombiaAccountantCsv, brazilApuracaoCsv };
export type { BrApuracaoReport, BrProventosReport, ColombiaTaxReport, BrazilTaxPack, ColombiaTaxPack };

/** Decisions on crypto left "em trânsito" (TRANSFER_OUT id → alienado / mantido), stored in meta. */
export type TransitResolution = Record<string, 'alienado' | 'mantido'>;

export interface TaxReports {
  colombia?: ColombiaTaxReport;
  brazil?: BrApuracaoReport;
  proventos?: BrProventosReport;
  /** Every Brazilian annual report + CSV/XLSX files + document model (tax R8). */
  brPack?: BrazilTaxPack;
  /** Colombian annual pack: report, Formulario 210/160, XLSX and document model. */
  coPack?: ColombiaTaxPack;
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
  const asOf = new Date().toISOString().slice(0, 10);
  if (country === 'CO') {
    out.coPack = attempt('coPack', () => colombiaTaxPack(input, { year }));
    out.colombia = out.coPack?.report ?? attempt('colombia', () => buildColombiaTaxReport(input, { year }));
  } else {
    const { getMeta } = await import('../db/repo');
    const transitResolution = (await getMeta<TransitResolution>('taxTransitResolution')) ?? {};
    // Tax R8: asOf drives DARF status (pendente / vencida) and late charges (multa + Selic).
    out.brPack = attempt('brPack', () => brazilTaxPack(input, { year, asOf, transitResolution }));
    out.brazil = out.brPack?.apuracao ?? attempt('brazil', () => brazilMonthlyApuracao(input, { year, asOf }));
    out.proventos = out.brPack?.proventos ?? attempt('proventos', () => brazilProventosReport(input, { year }));
  }
  return out;
}
