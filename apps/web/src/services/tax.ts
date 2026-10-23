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
  darfLateCharges,
  type BrazilTaxPack,
  type ColombiaTaxPack,
  TAX_DISCLAIMER,
  type BrApuracaoReport,
  type BrProventosReport,
  type ColombiaTaxReport,
  type TaxInput,
} from '@pm/tax';
import { loadDataset } from './engineDirect';
import { buildEngineInput, createMarket } from './analysis';

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
    // W43: CNPJ of common issuers (the package's own table covers nine).
    const { B3_CNPJ_EXTRA } = await import('../lib/b3Cnpj');
    out.brPack = attempt('brPack', () => brazilTaxPack(input, { year, asOf, transitResolution, cnpjByIssuer: B3_CNPJ_EXTRA }));
    out.brazil = out.brPack?.apuracao ?? attempt('brazil', () => brazilMonthlyApuracao(input, { year, asOf }));
    out.proventos = out.brPack?.proventos ?? attempt('proventos', () => brazilProventosReport(input, { year }));
  }
  return out;
}

/**
 * W44: what a DARF costs if paid on `date` (principal + multa de mora + juros Selic, same rules as
 * the report). `total` falls back to principal + multa when a Selic month is not published yet.
 */
export function darfDueOn(darf: { amount: number; dueDate: string }, date: string): { daysLate: number; multa: number; juros?: number; total: number } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const c = darfLateCharges(darf.amount, darf.dueDate, date);
  return { daysLate: c.daysLate, multa: c.multa, juros: c.juros, total: c.total ?? Math.round((darf.amount + c.multa) * 100) / 100 };
}

/**
 * W42: a CDT (accrual instrument) that matured without a recorded payment. The engine redeems it
 * automatically (estimated) so Posiciones shows the cash, but @pm/tax only reads transactions and keeps
 * it in the patrimonio at cost. The Impuestos page warns and offers to record this estimate.
 */
export interface PendingRedemption {
  portfolioId: string;
  instrumentId: string;
  date: string;
  currency: string;
  account?: string;
  quantity: number;
  /** Principal returned (cost of the position). */
  principal: number;
  /** Interest before withholding (accrued value − principal). */
  interestGross: number;
  /** Estimated withholding on the interest (4 % retención in Colombia by default). */
  withholding: number;
}

/** Engine estimates of maturities in `portfolioId` ('all' → every real portfolio) up to `until`. */
export async function pendingRedemptions(portfolioId: string, until: string): Promise<PendingRedemption[]> {
  const ds = await loadDataset();
  // Cheap exit (no engine pass) unless a transaction references an accrual asset that matured by then.
  const matured = new Set(ds.instruments.filter((i) => i.accrual?.maturity && i.accrual.maturity <= until).map((i) => i.id));
  if (!ds.transactions.some((t) => t.instrumentId && matured.has(t.instrumentId))) return [];
  const pids = ds.portfolios.filter((p) => !p.isDemo && (portfolioId === 'all' || p.id === portfolioId)).map((p) => p.id);
  const out: PendingRedemption[] = [];
  for (const pid of pids) {
    const scoped = { ...ds, selectedPortfolioId: pid };
    const input = buildEngineInput(scoped, createMarket(scoped));
    if (!input?.transactions.length) continue;
    try {
      out.push(...redemptionsFromEngine(core.createEngine(input), input.transactions, pid, until));
    } catch {
      /* engine failure: no suggestion */
    }
  }
  return out;
}

/** Groups the engine's estimated realized lots per maturity and reads the withholding from its diagnostic. */
export function redemptionsFromEngine(
  E: Pick<core.Engine, 'realized' | 'diagnostics'>,
  txs: core.Transaction[],
  portfolioId: string,
  until: string,
): PendingRedemption[] {
  const byKey = new Map<string, PendingRedemption>();
  for (const r of E.realized()) {
    if (!r.estimated || r.sellDate > until) continue;
    const key = `${r.instrumentId}|${r.sellDate}`;
    const cur = byKey.get(key) ?? { portfolioId, instrumentId: r.instrumentId, date: r.sellDate, currency: '', quantity: 0, principal: 0, interestGross: 0, withholding: 0 };
    cur.quantity += r.quantity;
    cur.principal += r.cost;
    cur.interestGross += r.proceeds - r.cost;
    byKey.set(key, cur);
  }
  for (const d of E.diagnostics()) {
    if (d.code !== 'MATURITY_REDEEMED') continue;
    const m = d.message.match(/^(\S+) redeemed automatically \(estimated\) for (-?\d+(?:\.\d+)?) ([A-Z]{3})(?: net of an estimated (-?\d+(?:\.\d+)?) withholding)?/);
    const cur = m ? byKey.get(`${m[1]}|${d.date}`) : undefined;
    if (!cur || !m) continue;
    cur.currency = m[3]!;
    cur.withholding = Number(m[4] ?? 0);
    cur.interestGross += cur.withholding; // realized proceeds are net of it
  }
  for (const r of byKey.values()) {
    const buy = txs.filter((t) => t.instrumentId === r.instrumentId && t.type === 'BUY').sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    r.account = buy?.account;
    if (!r.currency) r.currency = buy?.currency ?? 'COP';
  }
  return [...byKey.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * The redemption as the user would record it from the bank statement: the interest (gross, with its
 * withholding → "rendimientos financieros" in the tax report) and the principal returned (a SELL at
 * cost, no gain), both on the maturity date.
 */
export function redemptionTransactions(r: PendingRedemption, note: string): Omit<core.Transaction, 'id'>[] {
  const round = (v: number) => (['COP', 'CLP', 'JPY'].includes(r.currency) ? Math.round(v) : Math.round(v * 100) / 100);
  const base = { portfolioId: r.portfolioId, date: r.date, instrumentId: r.instrumentId, currency: r.currency, account: r.account, note };
  const rows: Omit<core.Transaction, 'id'>[] = [];
  if (r.interestGross > 0) rows.push({ ...base, type: 'INTEREST', amount: round(r.interestGross), taxes: round(r.withholding) });
  rows.push({ ...base, type: 'SELL', quantity: r.quantity, amount: round(r.principal), price: r.quantity ? r.principal / r.quantity : undefined });
  return rows;
}
