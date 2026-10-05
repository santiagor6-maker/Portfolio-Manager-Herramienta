import type { CurrencyCode } from '@pm/core';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, ParamMeta, TaxInput, TaxIssue } from '../common/types';
import { instrumentMap, sum } from '../common/util';
import type { BrCategory } from './classify';
import { BENS_E_DIREITOS_CODES } from './config';
import { brazilForeignAnnualReport, type PtaxProvider } from './exterior';
import { runBrazilB3Ledger, type BrPosition } from './ledger';

export interface BensDireitosItem {
  grupo: string;
  codigo: string;
  codigoDescricao: string;
  /** 'Brasil' or ISO country of the asset location. */
  localizacao: string;
  /** Left blank for the user (CNPJ of the issuer / fund). */
  cnpj: string;
  instrumentId?: string;
  ticker?: string;
  discriminacao: string;
  quantidade?: number;
  /** "Situação em 31/12" of the previous and current year, at acquisition cost in BRL. */
  situacaoAnterior: number;
  situacaoAtual: number;
  codeMeta: ParamMeta;
}

export interface BensDireitosReport {
  year: number;
  disclaimer: LocalizedText;
  items: BensDireitosItem[];
  totalAnterior: number;
  totalAtual: number;
  notes: string[];
  issues: TaxIssue[];
}

export interface BensDireitosOptions {
  year: number;
  ptax?: PtaxProvider;
  categoryOverrides?: Record<string, BrCategory>;
  /** Broker name per account, appended to the description. */
  brokerLabel?: string;
}

const fmt = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * DIRPF "Bens e Direitos" helper: B3 positions (preço médio) and foreign positions/cash
 * (BRL cost under Lei 14.754/2023) at acquisition cost — never at market value.
 */
export function brazilBensDireitos(input: TaxInput, opts: BensDireitosOptions): BensDireitosReport {
  const { year } = opts;
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
  const cur = runBrazilB3Ledger(input, { until: `${year}-12-31`, categoryOverrides: opts.categoryOverrides });
  const prev = runBrazilB3Ledger(input, { until: `${year - 1}-12-31`, categoryOverrides: opts.categoryOverrides });
  issues.push(...cur.issues);
  const prevMap = new Map(prev.positions.map((p) => [p.instrumentId, p]));
  const ids = new Set([...cur.positions.map((p) => p.instrumentId), ...prev.positions.map((p) => p.instrumentId)]);
  const curMap = new Map(cur.positions.map((p) => [p.instrumentId, p]));
  const items: BensDireitosItem[] = [];

  for (const id of ids) {
    const c = curMap.get(id);
    const p = prevMap.get(id);
    const ref = (c ?? p) as BrPosition;
    const code =
      ref.category === 'FII' ? BENS_E_DIREITOS_CODES.FII : ref.category === 'ETF' ? BENS_E_DIREITOS_CODES.ETF : ref.category === 'BDR' ? BENS_E_DIREITOS_CODES.BDR : BENS_E_DIREITOS_CODES.ACAO;
    const inst = instruments.get(id);
    const desc = c
      ? `${fmt(c.quantity)} ${ref.category === 'FII' ? 'cotas' : ref.category === 'ETF' ? 'cotas do ETF' : ref.category === 'BDR' ? 'BDRs' : 'ações'} ${ref.symbol}${inst?.name ? ` (${inst.name})` : ''}, preço médio R$ ${fmt(c.averageCost)}${opts.brokerLabel ? `, custodiadas na ${opts.brokerLabel}` : ''}.`
      : `${ref.symbol}${inst?.name ? ` (${inst.name})` : ''}: posição totalmente vendida em ${year}.`;
    items.push({
      grupo: code.grupo,
      codigo: code.codigo,
      codigoDescricao: code.descricao,
      localizacao: 'Brasil',
      cnpj: '',
      instrumentId: id,
      ticker: ref.symbol,
      discriminacao: desc,
      quantidade: c?.quantity ?? 0,
      situacaoAnterior: p?.totalCost ?? 0,
      situacaoAtual: c?.totalCost ?? 0,
      codeMeta: code.meta,
    });
  }

  const foreign = brazilForeignAnnualReport(input, { year, ptax: opts.ptax, categoryOverrides: opts.categoryOverrides });
  issues.push(...foreign.issues.filter((i) => i.code !== 'PRE_LEI_14754'));
  const fPrev = new Map(foreign.positionsPrevYear.map((p) => [p.instrumentId, p]));
  const fCur = new Map(foreign.positions.map((p) => [p.instrumentId, p]));
  for (const id of new Set([...fCur.keys(), ...fPrev.keys()])) {
    const c = fCur.get(id);
    const p = fPrev.get(id);
    const ref = (c ?? p)!;
    const isFund = ref.assetClass === 'etf' || ref.assetClass === 'fund' || ref.assetClass === 'reit';
    const code = isFund ? BENS_E_DIREITOS_CODES.FOREIGN_FUND : BENS_E_DIREITOS_CODES.FOREIGN_STOCK;
    items.push({
      grupo: code.grupo,
      codigo: code.codigo,
      codigoDescricao: code.descricao,
      localizacao: ref.country ?? '',
      cnpj: '',
      instrumentId: id,
      ticker: ref.symbol,
      discriminacao: c
        ? `${fmt(c.quantity)} ${isFund ? 'cotas' : 'ações'} ${ref.symbol}${ref.name ? ` (${ref.name})` : ''}, custo ${ref.currency} ${fmt(c.costFx)} convertido pela PTAX de compra das datas de aquisição${opts.brokerLabel ? `, custodiadas na ${opts.brokerLabel}` : ''}.`
        : `${ref.symbol}: posição totalmente vendida em ${year}.`,
      quantidade: c?.quantity ?? 0,
      situacaoAnterior: p?.costBrl ?? 0,
      situacaoAtual: c?.costBrl ?? 0,
      codeMeta: code.meta,
    });
  }

  const cashPrev = new Map<CurrencyCode, number>(foreign.cashPrevYear.map((b) => [b.currency, b.cost]));
  const cashCur = new Map<CurrencyCode, { units: number; cost: number }>(foreign.cash.map((b) => [b.currency, b]));
  for (const ccy of new Set([...cashCur.keys(), ...cashPrev.keys()])) {
    const c = cashCur.get(ccy);
    const code = BENS_E_DIREITOS_CODES.FOREIGN_CASH;
    items.push({
      grupo: code.grupo,
      codigo: code.codigo,
      codigoDescricao: code.descricao,
      localizacao: '',
      cnpj: '',
      discriminacao: `Saldo de ${ccy} ${fmt(c?.units ?? 0)} em conta no exterior${opts.brokerLabel ? ` (${opts.brokerLabel})` : ''}, ao custo de aquisição em reais.`,
      situacaoAnterior: cashPrev.get(ccy) ?? 0,
      situacaoAtual: c?.cost ?? 0,
      codeMeta: code.meta,
    });
  }

  return {
    year,
    disclaimer: TAX_DISCLAIMER,
    items,
    totalAnterior: sum(items.map((i) => i.situacaoAnterior)),
    totalAtual: sum(items.map((i) => i.situacaoAtual)),
    notes: [
      'Valores pelo custo de aquisição em reais (não pelo valor de mercado), conforme instruções da DIRPF.',
      'O CNPJ da empresa/fundo deve ser preenchido pelo usuário (consulte o informe da corretora ou o site da B3).',
      'Para ativos no exterior informe o país de localização e, quando aplicável, o preenchimento da aba "Aplicações Financeiras no Exterior" (Lei 14.754/2023).',
    ],
    issues,
  };
}
