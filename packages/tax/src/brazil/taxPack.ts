import { toCsv, type CsvCell, type CsvOptions } from '../common/csv';
import type { TaxInput } from '../common/types';
import { brazilMonthlyApuracao, type BrApuracaoOptions, type BrApuracaoReport } from './apuracao';
import { brazilBensDireitos, type BensDireitosOptions, type BensDireitosReport } from './bensDireitos';
import { brazilCryptoReport, type CryptoReport } from './crypto';
import { brazilApuracaoCsv } from './csv';
import { brazilForeignAnnualReport, type BrForeignReport } from './exterior';
import { brazilProventosReport, type BrProventosReport } from './proventos';
import { brazilRendaFixaReport, type RendaFixaReport } from './rendaFixa';

export function brazilDarfCsv(r: BrApuracaoReport, opts?: CsvOptions): string {
  const rows: CsvCell[][] = [
    ['periodo_apuracao', 'codigo_receita', 'vencimento', 'valor_principal', 'status', 'data_pagamento', 'multa', 'juros', 'valor_total', 'meses_incluidos'],
  ];
  for (const d of r.darfs) {
    rows.push([
      d.sicalc.periodoApuracao,
      d.code,
      d.sicalc.vencimento,
      d.amount,
      d.status,
      d.payment?.date ?? d.sicalc.dataPagamento,
      d.late?.multa,
      d.late?.juros,
      d.late?.total ?? d.amount,
      d.includesMonths.join(' '),
    ]);
  }
  rows.push([]);
  rows.push(['INSTRUCOES', r.darfs[0]?.sicalc.instrucoes ?? 'Sem DARF no período.']);
  return toCsv(rows, opts);
}

export function brazilProventosCsv(r: BrProventosReport, opts?: CsvOptions): string {
  return toCsv(
    [
      ['data', 'ticker', 'tipo', 'bruto', 'irrf', 'liquido', 'irrf_esperado', 'ficha_dirpf', 'linha', 'transicao_lei_15270'],
      ...r.rows.map((x) => [x.date, x.symbol, x.type, x.gross, x.irrf, x.net, x.expectedIrrf, x.dirpf?.ficha, x.dirpf?.linha, x.lei15270Transition ?? false]),
    ],
    opts,
  );
}

export function brazilExteriorCsv(r: BrForeignReport, opts?: CsvOptions): string {
  const rows: CsvCell[][] = [['tipo', 'data', 'ativo', 'moeda', 'valor_moeda', 'ptax', 'valor_brl', 'custo_brl', 'resultado_brl', 'imposto_exterior_brl', 'credito_max_brl']];
  for (const s of r.sales) rows.push(['venda', s.date, s.symbol, s.currency, s.proceedsFx, s.ptaxSell, s.proceedsBrl, s.costBrl, s.gainBrl, '', '']);
  for (const i of r.income) rows.push([i.type.toLowerCase(), i.date, i.symbol ?? '(conta)', i.currency, i.grossFx, i.ptaxSell, i.grossBrl, '', i.grossBrl, i.foreignTaxBrl, i.creditCapBrl]);
  const t = r.totals;
  rows.push([]);
  rows.push(['TOTAL', '', 'resultado líquido', '', '', '', t.netResultBrl]);
  rows.push(['TOTAL', '', 'prejuízo compensado', '', '', '', t.lossUsed]);
  rows.push(['TOTAL', '', 'base de cálculo', '', '', '', t.baseBrl]);
  rows.push(['TOTAL', '', `imposto ${(t.rate * 100).toFixed(0)}%`, '', '', '', t.taxGrossBrl]);
  rows.push(['TOTAL', '', 'crédito imposto exterior', '', '', '', t.foreignTaxCreditBrl]);
  rows.push(['TOTAL', '', 'imposto devido', '', '', '', t.taxDueBrl]);
  rows.push(['TOTAL', '', 'prejuízo a compensar (anos seguintes)', '', '', '', t.lossCarryOut]);
  return toCsv(rows, opts);
}

export function brazilBensDireitosCsv(r: BensDireitosReport, opts?: CsvOptions): string {
  return toCsv(
    [
      ['grupo', 'codigo', 'localizacao', 'cnpj', 'discriminacao', 'situacao_anterior', 'situacao_atual', 'lucro_prejuizo_exterior', 'rendimentos_exterior', 'imposto_pago_exterior'],
      ...r.items.map((i) => [
        i.grupo,
        i.codigo,
        i.localizacao,
        i.cnpj,
        i.discriminacao,
        i.situacaoAnterior,
        i.situacaoAtual,
        i.exterior?.lucroPrejuizoBrl,
        i.exterior?.rendimentosBrl,
        i.exterior?.impostoPagoExteriorBrl,
      ]),
    ],
    opts,
  );
}

export interface BrazilTaxPack {
  year: number;
  apuracao: BrApuracaoReport;
  proventos: BrProventosReport;
  exterior: BrForeignReport;
  bensDireitos: BensDireitosReport;
  rendaFixa: RendaFixaReport;
  cripto: CryptoReport;
  files: Record<string, string>;
}

/** All Brazilian annual reports and their CSV files for the accountant / DIRPF. */
export function brazilTaxPack(
  input: TaxInput,
  opts: { year: number; csv?: CsvOptions } & Omit<BrApuracaoOptions, 'year' | 'from' | 'to'> & Omit<BensDireitosOptions, 'year'>,
): BrazilTaxPack {
  const y = opts.year;
  const apuracao = brazilMonthlyApuracao(input, { ...opts, year: y });
  const proventos = brazilProventosReport(input, { year: y, categoryOverrides: opts.categoryOverrides });
  const exterior = brazilForeignAnnualReport(input, { year: y, ptax: opts.ptax, categoryOverrides: opts.categoryOverrides, transferBasis: opts.transferBasis });
  const bensDireitos = brazilBensDireitos(input, { ...opts, year: y });
  const rendaFixa = brazilRendaFixaReport(input, { year: y, categoryOverrides: opts.categoryOverrides, exemptIds: opts.rendaFixaExemptIds });
  const cripto = brazilCryptoReport(input, { year: y, categoryOverrides: opts.categoryOverrides });
  return {
    year: y,
    apuracao,
    proventos,
    exterior,
    bensDireitos,
    rendaFixa,
    cripto,
    files: {
      [`brasil-${y}-apuracao-mensal.csv`]: brazilApuracaoCsv(apuracao, opts.csv),
      [`brasil-${y}-darfs.csv`]: brazilDarfCsv(apuracao, opts.csv),
      [`brasil-${y}-proventos.csv`]: brazilProventosCsv(proventos, opts.csv),
      [`brasil-${y}-exterior-lei-14754.csv`]: brazilExteriorCsv(exterior, opts.csv),
      [`brasil-${y}-bens-e-direitos.csv`]: brazilBensDireitosCsv(bensDireitos, opts.csv),
      [`brasil-${y}-renda-fixa.csv`]: toCsv(
        [
          ['data', 'titulo', 'tipo', 'isento', 'dias', 'rendimento', 'iof', 'aliquota_ir', 'ir_esperado', 'ir_retido'],
          ...rendaFixa.rows.map((r) => [r.date, r.name, r.type, r.exempt, r.holdingDays, r.rendimento, r.iof, r.irRate, r.expectedIrrf, r.irrfReported]),
        ],
        opts.csv,
      ),
      [`brasil-${y}-cripto.csv`]: toCsv(
        [['mes', 'vendas_brl', 'isento_35k', 'ganho_brl', 'imposto', 'darf_vencimento'], ...cripto.months.map((m) => [m.month, m.salesBrl, m.exempt, m.gainBrl, m.tax, m.darf?.dueDate])],
        opts.csv,
      ),
    },
  };
}
