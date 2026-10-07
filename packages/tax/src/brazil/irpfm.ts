import type { ParamMeta } from '../common/types';
import { sum } from '../common/util';
import type { BrApuracaoReport } from './apuracao';
import { brazilConfig, type BrazilTaxYearConfig } from './config';
import type { BrForeignReport } from './exterior';
import type { BrProventosReport } from './proventos';
import type { RendaFixaReport } from './rendaFixa';

export const IRPFM_META: ParamMeta = {
  status: 'needs-verification',
  source:
    'Lei 15.270/2025 (IRPFM): base = todos os rendimentos do ano, inclusive isentos e de tributação exclusiva; excluídos ganhos de ' +
    'capital (exceto em bolsa), poupança, LCI/LCA/CRI/CRA, FII/Fiagro, FI-Infra, debêntures incentivadas, heranças/doações; ' +
    'deduzem-se o IRPF do ajuste, IRRF e imposto definitivo sobre os rendimentos incluídos.',
  checkedOn: '2026-10-06',
  note:
    'Redutor calculado com a alíquota efetiva informada por empresa (issuerEffectiveRates); sem ela, o resultado é uma faixa ' +
    '(máximo sem redutor; mínimo supondo carga efetiva de 34% na empresa). Dividendos da transição (lucros até 2025) fora da base por padrão. Regulamentação da RFB a conferir.',
};

export interface IrpfmInput {
  year: number;
  apuracao?: BrApuracaoReport;
  proventos?: BrProventosReport;
  rendaFixa?: RendaFixaReport;
  exterior?: BrForeignReport;
  /** Income outside this portfolio included in the base (salary, rents, business...), annual BRL. */
  otherIncome?: number;
  /** IRPF/IRRF already due on that other income (progressive table, withheld at source). */
  otherTaxPaid?: number;
  config?: BrazilTaxYearConfig;
  /**
   * Effective IRPJ+CSLL rate of each distributing company (by issuer key, e.g. 'BVMF:VALE'), for the
   * redutor (T43). Unknown issuers produce a range: no redutor (max) vs. a full 34% burden (min).
   */
  issuerEffectiveRates?: Record<string, number>;
  /** Nominal combined limit per issuer: 34% general, 40% insurers/others, 45% banks. Default 34%. */
  issuerLimits?: Record<string, number>;
  /**
   * Include dividends of the Lei 15.270 transition (profits up to 2025 approved by 31/12/2025) in the
   * base. Default false (needs verification against the regulation).
   */
  includeTransitionDividends?: boolean;
}

export interface IrpfmEstimate {
  year: number;
  applicable: boolean;
  base: number;
  components: { label: string; value: number }[];
  rate: number;
  irpfmGross: number;
  credits: { label: string; value: number }[];
  creditsTotal: number;
  /** Redutor (company + IRPFM burden above the nominal limit) with the issuer rates supplied. */
  redutor: number;
  /** Due when unknown issuers already bear the full 34% (min) or nothing is known (max). */
  irpfmDueRange: { min: number; max: number };
  redutorByIssuer: { issuer: string; dividends: number; effectiveRate?: number; limit: number; redutorMin: number; redutorMax: number }[];
  irpfmDue: number;
  meta: ParamMeta;
  note: string;
}

export function irpfmRate(base: number, p: { lowerLimit: number; upperLimit: number; maxRate: number }): number {
  if (base <= p.lowerLimit) return 0;
  if (base >= p.upperLimit) return p.maxRate;
  return (p.maxRate * (base - p.lowerLimit)) / (p.upperLimit - p.lowerLimit);
}

/**
 * Lei 15.270/2025 minimum annual tax for high incomes (IRPFM), simplified estimate combining the
 * portfolio reports with income declared outside the portfolio.
 */
export function brazilIrpfmEstimate(inp: IrpfmInput): IrpfmEstimate {
  const cfg = inp.config ?? brazilConfig(inp.year);
  const params = cfg.irpfm;
  const prov = inp.proventos;
  const ap = inp.apuracao;
  const months = ap?.months.filter((m) => m.month.startsWith(`${inp.year}-`)) ?? [];
  const bolsaGains = sum(
    months.map((m) => Math.max(0, m.results.acoes + m.results.etf + m.results.bdr + m.results.opcoes + m.results.futuros + m.results.direitos + m.results.dayTrade + m.results.fii)),
  );
  const divRows = (prov?.rows ?? []).filter((r) => r.type === 'DIVIDENDO' && (inp.includeTransitionDividends || !r.lei15270Transition));
  const dividends = sum(divRows.map((r) => r.gross));
  const components = [
    { label: 'Dividendos (ações)', value: dividends },
    { label: 'Juros sobre capital próprio', value: prov?.totals.jcpGross ?? 0 },
    { label: 'Renda fixa tributável', value: inp.rendaFixa?.totals.rendimentosTributaveis ?? 0 },
    { label: 'Ganhos líquidos em bolsa (inclusive isentos)', value: bolsaGains },
    { label: 'Aplicações no exterior (Lei 14.754)', value: Math.max(0, inp.exterior?.totals.netResultBrl ?? 0) },
    { label: 'Outros rendimentos (fora do portfólio)', value: inp.otherIncome ?? 0 },
  ];
  const base = sum(components.map((c) => c.value));
  const credits = [
    { label: 'IRRF sobre JCP', value: prov?.totals.jcpIrrf ?? 0 },
    { label: 'IRRF sobre dividendos (Lei 15.270)', value: prov?.totals.dividendIrrf ?? 0 },
    { label: 'IR retido em renda fixa', value: inp.rendaFixa?.totals.irrfTributaveis ?? 0 },
    { label: 'IR sobre ganhos em bolsa (DARF 6015)', value: sum(months.map((m) => m.taxGross)) },
    { label: 'IR sobre aplicações no exterior', value: inp.exterior?.totals.taxDueBrl ?? 0 },
    { label: 'IRPF/IRRF sobre outros rendimentos', value: inp.otherTaxPaid ?? 0 },
  ];
  const creditsTotal = sum(credits.map((c) => c.value));
  const rate = params ? irpfmRate(base, params) : 0;
  const gross = base * rate;
  // Redutor (Lei 15.270/2025): when the company's effective rate plus the IRPFM rate exceeds the
  // nominal limit (34% / 40% / 45%), the excess applied to that company's dividends is deducted.
  const byIssuer = new Map<string, number>();
  for (const r of divRows) byIssuer.set(r.issuer ?? r.instrumentId ?? '?', (byIssuer.get(r.issuer ?? r.instrumentId ?? '?') ?? 0) + r.gross);
  const redutorByIssuer = [...byIssuer.entries()].map(([issuer, d]) => {
    const limit = inp.issuerLimits?.[issuer] ?? 0.34;
    const eff = inp.issuerEffectiveRates?.[issuer];
    const red = (e: number) => Math.min(d * rate, d * Math.max(0, e + rate - limit));
    return { issuer, dividends: d, effectiveRate: eff, limit, redutorMin: eff !== undefined ? red(eff) : 0, redutorMax: red(eff ?? limit) };
  });
  const redKnown = sum(redutorByIssuer.map((r) => r.redutorMin));
  const redFull = sum(redutorByIssuer.map((r) => r.redutorMax));
  const due = (red: number) => Math.max(0, gross - creditsTotal - red);
  return {
    year: inp.year,
    applicable: !!params,
    base,
    components,
    rate,
    irpfmGross: gross,
    credits,
    creditsTotal,
    redutor: redKnown,
    irpfmDueRange: { min: due(redFull), max: due(redKnown) },
    redutorByIssuer,
    irpfmDue: due(redKnown),
    meta: IRPFM_META,
    note: params
      ? `IRPFM: 0% até R$ ${params.lowerLimit.toLocaleString('pt-BR')}/ano, crescendo linearmente até ${params.maxRate * 100}% a partir de R$ ${params.upperLimit.toLocaleString('pt-BR')}. Redutor: carga empresa + IRPFM limitada a 34% (40%/45% setor financeiro).`
      : `IRPFM não se aplica a ${inp.year} (vigente a partir de 2026).`,
  };
}
