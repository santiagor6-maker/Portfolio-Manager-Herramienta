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
  note: 'Redutor por tributação da pessoa jurídica (lucros distribuídos) não calculado. Regulamentação da RFB a conferir.',
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
    months.map((m) => Math.max(0, m.results.acoes + m.results.etf + m.results.bdr + m.results.opcoes + m.results.direitos + m.results.dayTrade + m.results.fii)),
  );
  const components = [
    { label: 'Dividendos (ações)', value: prov?.totals.dividendos ?? 0 },
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
  return {
    year: inp.year,
    applicable: !!params,
    base,
    components,
    rate,
    irpfmGross: gross,
    credits,
    creditsTotal,
    irpfmDue: Math.max(0, gross - creditsTotal),
    meta: IRPFM_META,
    note: params
      ? `IRPFM: 0% até R$ ${params.lowerLimit.toLocaleString('pt-BR')}/ano, crescendo linearmente até ${params.maxRate * 100}% a partir de R$ ${params.upperLimit.toLocaleString('pt-BR')}. Estimativa sem o redutor de lucros já tributados na empresa.`
      : `IRPFM não se aplica a ${inp.year} (vigente a partir de 2026).`,
  };
}
