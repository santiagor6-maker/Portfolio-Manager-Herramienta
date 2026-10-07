import { toCsv, type CsvCell, type CsvOptions } from '../common/csv';
import type { TaxInput } from '../common/types';
import { brazilMonthlyApuracao, type BrApuracaoOptions, type BrApuracaoReport } from './apuracao';
import { brazilBensDireitos, type BensDireitosOptions, type BensDireitosReport } from './bensDireitos';
import { brazilCryptoReport, type CryptoReport } from './crypto';
import { brazilApuracaoCsv } from './csv';
import { brazilForeignAnnualReport, type BrForeignReport } from './exterior';
import { brazilProventosReport, type BrProventosReport } from './proventos';
import { brazilRendaFixaReport, type RendaFixaReport } from './rendaFixa';
import { brazilComeCotasReport, type ComeCotasReport } from './comeCotas';
import { brazilIrpfmEstimate, type IrpfmEstimate } from './irpfm';
import type { TaxDocument } from '../common/document';
import { parseCsv, toXlsx } from '../common/xlsx';

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

export interface BrazilTaxPackOptions
  extends Omit<BrApuracaoOptions, 'year' | 'from' | 'to'>,
    Omit<BensDireitosOptions, 'year'> {
  year: number;
  csv?: CsvOptions;
  issuers?: Record<string, string>;
  preLei15270Dividends?: string[];
  jcpCreditDates?: Record<string, string>;
  initialLossCarry?: number;
  portfolioBaseCurrency?: string;
  fundTerms?: Record<string, 'longo' | 'curto'>;
  /** Income outside the portfolio for the IRPFM estimate (Lei 15.270/2025). */
  otherIncome?: number;
  otherTaxPaid?: number;
  /** IRPFM redutor inputs (T43). */
  issuerEffectiveRates?: Record<string, number>;
  issuerLimits?: Record<string, number>;
  includeTransitionDividends?: boolean;
  /** Pre-2024 foreign regime: instruments bought with income earned abroad (IN SRF 118/2000). */
  foreignOriginInstruments?: string[];
}

export interface BrazilTaxPack {
  year: number;
  apuracao: BrApuracaoReport;
  proventos: BrProventosReport;
  exterior: BrForeignReport;
  bensDireitos: BensDireitosReport;
  rendaFixa: RendaFixaReport;
  cripto: CryptoReport;
  comeCotas: ComeCotasReport;
  irpfm: IrpfmEstimate;
  files: Record<string, string>;
  /** Workbook with one sheet per CSV. */
  xlsx: Uint8Array;
  /** Presentation model for PDF/print rendering by the app. */
  document: TaxDocument;
}

/** All Brazilian annual reports and their CSV/XLSX files for the accountant / DIRPF (T33: every option is forwarded). */
export function brazilTaxPack(input: TaxInput, opts: BrazilTaxPackOptions): BrazilTaxPack {
  const y = opts.year;
  const co = { categoryOverrides: opts.categoryOverrides };
  const apuracao = brazilMonthlyApuracao(input, { ...opts, year: y });
  const proventos = brazilProventosReport(input, {
    year: y,
    ...co,
    issuers: opts.issuers,
    preLei15270Dividends: opts.preLei15270Dividends,
    jcpCreditDates: opts.jcpCreditDates,
  });
  const exterior = brazilForeignAnnualReport(input, {
    year: y,
    ...co,
    ptax: opts.ptax,
    transferBasis: opts.transferBasis,
    acceptNoteProposals: opts.acceptNoteProposals,
    cryptoCustody: opts.cryptoCustody,
    accountCustody: opts.accountCustody,
    initialLossCarry: opts.initialLossCarry,
    foreignOriginInstruments: opts.foreignOriginInstruments,
    portfolioBaseCurrency: opts.portfolioBaseCurrency,
  });
  const bensDireitos = brazilBensDireitos(input, { ...opts, year: y });
  const rendaFixa = brazilRendaFixaReport(input, { year: y, ...co, exemptIds: opts.rendaFixaExemptIds });
  const cripto = brazilCryptoReport(input, { year: y, ...co, cryptoCustody: opts.cryptoCustody, accountCustody: opts.accountCustody });
  const comeCotas = brazilComeCotasReport(input, { year: y, ...co, fundTerms: opts.fundTerms });
  const irpfm = brazilIrpfmEstimate({
    year: y,
    apuracao,
    proventos,
    rendaFixa,
    exterior,
    otherIncome: opts.otherIncome,
    otherTaxPaid: opts.otherTaxPaid,
    issuerEffectiveRates: opts.issuerEffectiveRates,
    issuerLimits: opts.issuerLimits,
    includeTransitionDividends: opts.includeTransitionDividends,
  });
  const files: Record<string, string> = {
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
      [
        ['mes', 'vendas_brl', 'isento_35k', 'ganho_brl', 'imposto', 'darf_vencimento', 'darf_bloqueado_custodia'],
        ...cripto.months.map((m) => [m.month, m.salesBrl, m.exempt, m.gainBrl, m.tax, m.darf?.dueDate, m.darfBlockedUnknownCustody ?? false]),
      ],
      opts.csv,
    ),
    [`brasil-${y}-come-cotas.csv`]: toCsv(
      [['data', 'fundo', 'cotas', 'cota', 'valor', 'base', 'rendimento', 'aliquota', 'ir'], ...comeCotas.rows.map((r) => [r.date, r.name, r.quotas, r.price, r.value, r.base, r.yield, r.rate, r.tax])],
      opts.csv,
    ),
    [`brasil-${y}-irpfm.csv`]: toCsv(
      [
        ['item', 'valor'],
        ...irpfm.components.map((c) => [`Base: ${c.label}`, c.value]),
        ['Base total', irpfm.base],
        ['Alíquota', irpfm.rate],
        ['IRPFM bruto', irpfm.irpfmGross],
        ...irpfm.credits.map((c) => [`Dedução: ${c.label}`, c.value]),
        ['Redutor (alíquotas informadas)', irpfm.redutor],
        ['IRPFM devido (estimado)', irpfm.irpfmDue],
        ['IRPFM faixa mínima (carga de 34% nas empresas)', irpfm.irpfmDueRange.min],
        ['IRPFM faixa máxima (sem redutor)', irpfm.irpfmDueRange.max],
        ['Nota', irpfm.note],
      ],
      opts.csv,
    ),
  };
  const delimiter = opts.csv?.delimiter ?? ';';
  const decimal = opts.csv?.decimal ?? ',';
  const sheets = Object.entries(files).map(([name, csv]) => ({
    name: name.replace(`brasil-${y}-`, '').replace('.csv', ''),
    rows: parseCsv(csv, delimiter, decimal),
  }));
  const document: TaxDocument = {
    title: `Relatório fiscal ${y} — Brasil`,
    subtitle: 'Pessoa física residente · informações para o contador e a DIRPF',
    country: 'BR',
    year: y,
    locale: 'pt-BR',
    disclaimer: apuracao.disclaimer,
    sections: [
      {
        heading: 'Resumo',
        figures: [
          { label: 'IR renda variável (DARF 6015)', value: apuracao.totals.darfTotal, currency: 'BRL' },
          { label: 'Ganhos isentos (ações até R$ 20 mil)', value: apuracao.totals.exemptGain, currency: 'BRL' },
          { label: 'IR aplicações no exterior (Lei 14.754)', value: exterior.totals.taxDueBrl, currency: 'BRL' },
          { label: 'Dividendos', value: proventos.totals.dividendos, currency: 'BRL' },
          { label: 'JCP (bruto)', value: proventos.totals.jcpGross, currency: 'BRL' },
          { label: 'Bens e Direitos em 31/12', value: bensDireitos.totalAtual, currency: 'BRL' },
          { label: 'IRPFM estimado', value: irpfm.irpfmDue, currency: 'BRL' },
        ],
      },
      ...sheets.map((sh) => ({ heading: sh.name, table: { columns: (sh.rows[0] ?? []).map(String), rows: sh.rows.slice(1) } })),
      { heading: 'Premissas', paragraphs: apuracao.assumptions },
      {
        heading: 'Alertas',
        paragraphs: [...apuracao.issues, ...proventos.issues, ...exterior.issues, ...cripto.issues].map((i) => `[${i.level}] ${i.message}`),
      },
    ],
  };
  return { year: y, apuracao, proventos, exterior, bensDireitos, rendaFixa, cripto, comeCotas, irpfm, files, xlsx: toXlsx(sheets), document };
}
