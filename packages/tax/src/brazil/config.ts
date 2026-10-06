import type { ParamMeta } from '../common/types';

/** Parameters for a Brazilian resident individual (pessoa física residente), per calendar year. */
export interface BrazilTaxYearConfig {
  year: number;
  /** Lei 11.033/2004 art. 3º I; IN RFB 1.585/2015 art. 59: monthly sales limit for the stock exemption. */
  stockSalesExemptionLimit: number;
  /** Swing trade ("operações comuns") rate on net gains: ações, ETFs, BDRs. */
  swingRate: number;
  dayTradeRate: number;
  /** FII quota sales (Lei 8.668/1993 art. 18). */
  fiiRate: number;
  /** IRRF "dedo-duro" on swing-trade sale value (Lei 11.033/2004 art. 2º §1º). */
  irrfSwingRate: number;
  /** IRRF on positive day-trade results (1%). */
  irrfDayTradeRate: number;
  /** IRRF of up to this amount is not withheld (dispensa). */
  irrfMinimum: number;
  /** DARF below this amount is carried to the next month (Lei 9.430/1996 art. 68). */
  darfMinimum: number;
  darfCode: string;
  /** Losses on common operations may also offset day-trade gains (the opposite is not allowed). */
  commonLossOffsetsDayTrade: boolean;
  /** JCP withholding (Lei 9.249/1995 art. 9º §2º). */
  jcpRate: number;
  /** Lei 15.270/2025: IRRF on dividends from the same company above a monthly amount (from 2026). */
  dividendWithholding?: { monthlyThresholdPerPayer: number; rate: number };
  /**
   * Lei 15.270/2025 IRPFM (tributação mínima anual, from calendar year 2026): rate grows linearly from
   * 0% at `lowerLimit` to `maxRate` at `upperLimit` of total annual income, then stays at maxRate.
   */
  irpfm?: { lowerLimit: number; upperLimit: number; maxRate: number };
  /** Lei 14.754/2023: annual rate on foreign financial applications (from 2024). */
  foreignApplicationsRate?: number;
  meta: Record<string, ParamMeta>;
}

const V = (source: string, note?: string): ParamMeta => ({ status: 'verified', source, checkedOn: '2026-10-05', note });
const NV = (source: string, note?: string): ParamMeta => ({ status: 'needs-verification', source, checkedOn: '2026-10-05', note });

const BASE = {
  stockSalesExemptionLimit: 20_000,
  swingRate: 0.15,
  dayTradeRate: 0.2,
  fiiRate: 0.2,
  irrfSwingRate: 0.00005,
  irrfDayTradeRate: 0.01,
  irrfMinimum: 1,
  darfMinimum: 10,
  darfCode: '6015',
  commonLossOffsetsDayTrade: true,
};

const BASE_META: Record<string, ParamMeta> = {
  stockSalesExemptionLimit: V('Lei 11.033/2004 art. 3º I; IN RFB 1.585/2015 art. 59'),
  swingRate: V('Lei 11.033/2004 art. 2º II'),
  dayTradeRate: V('Lei 8.981/1995 art. 72 / Lei 9.959/2000; IN RFB 1.585/2015 art. 65'),
  fiiRate: V('Lei 8.668/1993 art. 18; IN RFB 1.585/2015 art. 88'),
  irrfSwingRate: V('Lei 11.033/2004 art. 2º §1º (0,005%)'),
  irrfDayTradeRate: V('IRRF de 1% sobre o resultado positivo de day trade (IN RFB 1.585/2015)', 'Artigo exato a conferir.'),
  irrfMinimum: V('Lei 11.033/2004 art. 2º §1º (dispensa de retenção ≤ R$ 1,00)'),
  darfMinimum: V('Lei 9.430/1996 art. 68'),
  darfCode: V('Código 6015 (ganhos líquidos em operações em bolsa, PF)'),
  commonLossOffsetsDayTrade: NV(
    'IN RFB 1.585/2015 art. 65 e Perguntas e Respostas IRPF',
    'Prejuízo de day trade só compensa ganho de day trade; prejuízo de operações comuns pode compensar ambos.',
  ),
  jcpRate: V('Lei 9.249/1995 art. 9º §2º (15%)'),
  foreignApplicationsRate: V('Lei 14.754/2023 arts. 2º-3º; IN RFB 2.180/2024'),
};

export const BRAZIL_TAX_YEARS: Record<number, BrazilTaxYearConfig> = {
  2023: { ...BASE, year: 2023, jcpRate: 0.15, meta: { ...BASE_META } },
  2024: { ...BASE, year: 2024, jcpRate: 0.15, foreignApplicationsRate: 0.15, meta: { ...BASE_META } },
  2025: {
    ...BASE,
    year: 2025,
    jcpRate: 0.15,
    foreignApplicationsRate: 0.15,
    meta: {
      ...BASE_META,
      swingRate: V(
        'Lei 11.033/2004 art. 2º II',
        'A MP 1.303/2025 (alíquota única de 17,5%) perdeu a vigência sem conversão em lei (out/2025).',
      ),
    },
  },
  2026: {
    ...BASE,
    year: 2026,
    jcpRate: 0.175,
    irpfm: { lowerLimit: 600_000, upperLimit: 1_200_000, maxRate: 0.1 },
    foreignApplicationsRate: 0.15,
    dividendWithholding: { monthlyThresholdPerPayer: 50_000, rate: 0.1 },
    meta: {
      ...BASE_META,
      swingRate: NV(
        'Lei 11.033/2004 art. 2º II',
        'MP 1.303/2025 perdeu a vigência; confirmar que não houve nova lei alterando as alíquotas em 2026.',
      ),
      jcpRate: V('LC 224/2025: IRRF sobre JCP de 17,5% a partir de 01/01/2026 (pagamento ou crédito)'),
      dividendWithholding: V(
        'Lei 15.270/2025: IRRF de 10% sobre dividendos pagos pela mesma PJ à mesma PF acima de R$ 50.000 no mês (sobre o total)',
        'Também institui a tributação mínima anual (IRPFM) para rendas acima de R$ 600 mil/ano — não calculada aqui.',
      ),
    },
  },
  2027: {
    ...BASE,
    year: 2027,
    jcpRate: 0.175,
    irpfm: { lowerLimit: 600_000, upperLimit: 1_200_000, maxRate: 0.1 },
    foreignApplicationsRate: 0.15,
    dividendWithholding: { monthlyThresholdPerPayer: 50_000, rate: 0.1 },
    meta: {
      ...BASE_META,
      swingRate: NV('Lei 11.033/2004 art. 2º II', 'Ano futuro: confirmar alíquotas vigentes.'),
      jcpRate: NV('LC 224/2025 (17,5%)', 'Confirmar se há escalonamento posterior da alíquota do JCP.'),
      dividendWithholding: NV('Lei 15.270/2025', 'Confirmar limite mensal e alíquota para o ano.'),
    },
  },
  2028: {
    ...BASE,
    year: 2028,
    jcpRate: 0.175,
    irpfm: { lowerLimit: 600_000, upperLimit: 1_200_000, maxRate: 0.1 },
    foreignApplicationsRate: 0.15,
    dividendWithholding: { monthlyThresholdPerPayer: 50_000, rate: 0.1 },
    meta: {
      ...BASE_META,
      swingRate: NV('Lei 11.033/2004 art. 2º II', 'Ano futuro: confirmar alíquotas vigentes.'),
      jcpRate: NV(
        'LC 224/2025',
        'Uma fonte de mercado indica elevação do IRRF sobre JCP para 20% a partir de 2028; não confirmado no texto legal — ajustar se confirmado.',
      ),
      dividendWithholding: NV('Lei 15.270/2025', 'Confirmar limite mensal e alíquota para o ano.'),
    },
  },
};

export function brazilConfig(year: number): BrazilTaxYearConfig {
  const c = BRAZIL_TAX_YEARS[year];
  if (c) return c;
  const years = Object.keys(BRAZIL_TAX_YEARS).map(Number).sort((a, b) => a - b);
  const latest = years[years.length - 1] ?? 2028;
  const base = BRAZIL_TAX_YEARS[year > latest ? latest : (years[0] ?? latest)]!;
  const meta: Record<string, ParamMeta> = {};
  for (const k of Object.keys(base.meta)) meta[k] = NV(`Copiado do ano ${base.year}; sem parâmetros para ${year}`);
  return { ...base, year, meta };
}

/** DIRPF "Bens e Direitos" codes (layout in force since DIRPF 2024). */
export const BENS_E_DIREITOS_CODES = {
  ACAO: { grupo: '03', codigo: '01', descricao: 'Ações (inclusive as listadas em bolsa)', meta: V('DIRPF 2024+ tabela de códigos') },
  FII: { grupo: '07', codigo: '03', descricao: 'Fundos de Investimento Imobiliário (FII)', meta: V('DIRPF 2024+ tabela de códigos') },
  ETF: { grupo: '07', codigo: '09', descricao: 'Demais fundos de índice de mercado (ETF)', meta: NV('DIRPF 2024+; ETF de renda fixa usa 07-08') },
  BDR: { grupo: '04', codigo: '04', descricao: 'Ativos negociados em bolsa no Brasil (BDR, opções...)', meta: NV('DIRPF 2024+ tabela de códigos') },
  FOREIGN_STOCK: { grupo: '03', codigo: '01', descricao: 'Ações (exterior) — informar país de localização', meta: V('DIRPF 2024+; Lei 14.754/2023') },
  FOREIGN_FUND: { grupo: '07', codigo: '99', descricao: 'Fundos de investimento no exterior / ETF exterior', meta: NV('Fontes de mercado indicam 07-99; confirmar no programa da DIRPF do ano') },
  FOREIGN_CASH: { grupo: '06', codigo: '01', descricao: 'Depósito em conta corrente ou conta pagamento (exterior)', meta: NV('DIRPF 2024+ tabela de códigos') },
  ETF_RF: { grupo: '07', codigo: '08', descricao: 'Fundos de índice de renda fixa (ETF RF, Lei 13.043/2014)', meta: NV('DIRPF 2024+ tabela de códigos') },
  OPCAO: { grupo: '04', codigo: '04', descricao: 'Ativos negociados em bolsa no Brasil (opções)', meta: NV('DIRPF 2024+ tabela de códigos') },
  DIREITO: { grupo: '04', codigo: '04', descricao: 'Ativos negociados em bolsa no Brasil (direitos de subscrição)', meta: NV('DIRPF 2024+ tabela de códigos') },
  RENDA_FIXA_TRIBUTAVEL: { grupo: '04', codigo: '02', descricao: 'Títulos públicos e privados sujeitos à tributação (Tesouro, CDB, debêntures)', meta: NV('DIRPF 2024+ tabela de códigos') },
  RENDA_FIXA_ISENTA: { grupo: '04', codigo: '03', descricao: 'Títulos isentos de tributação (LCI, LCA, CRI, CRA, debêntures incentivadas)', meta: NV('DIRPF 2024+ tabela de códigos') },
  CRYPTO_BTC: { grupo: '08', codigo: '01', descricao: 'Criptoativo Bitcoin (BTC)', meta: NV('DIRPF 2024+ tabela de códigos') },
  CRYPTO_ALT: { grupo: '08', codigo: '02', descricao: 'Outros criptoativos (altcoins)', meta: NV('DIRPF 2024+ tabela de códigos') },
  CRYPTO_STABLE: { grupo: '08', codigo: '03', descricao: 'Stablecoins', meta: NV('DIRPF 2024+ tabela de códigos') },
} as const;

/**
 * CNPJ of a few large B3 issuers (by root ticker) to prefill Bens e Direitos. Users and importers
 * should extend it (`cnpjByIssuer` option); every value must be checked against the broker's informe.
 */
export const B3_CNPJ: Record<string, { cnpj: string; nome: string; meta: ParamMeta }> = {
  PETR: { cnpj: '33.000.167/0001-01', nome: 'Petróleo Brasileiro S.A. - Petrobras', meta: NV('Cadastro CNPJ / RI da companhia') },
  VALE: { cnpj: '33.592.510/0001-54', nome: 'Vale S.A.', meta: NV('Cadastro CNPJ / RI da companhia') },
  ITUB: { cnpj: '60.872.504/0001-23', nome: 'Itaú Unibanco Holding S.A.', meta: NV('Cadastro CNPJ / RI da companhia') },
  BBDC: { cnpj: '60.746.948/0001-12', nome: 'Banco Bradesco S.A.', meta: NV('Cadastro CNPJ / RI da companhia') },
  BBAS: { cnpj: '00.000.000/0001-91', nome: 'Banco do Brasil S.A.', meta: NV('Cadastro CNPJ / RI da companhia') },
  ABEV: { cnpj: '07.526.557/0001-00', nome: 'Ambev S.A.', meta: NV('Cadastro CNPJ / RI da companhia') },
  ITSA: { cnpj: '61.532.644/0001-15', nome: 'Itaúsa S.A.', meta: NV('Cadastro CNPJ / RI da companhia') },
  B3SA: { cnpj: '09.346.601/0001-25', nome: 'B3 S.A. - Brasil, Bolsa, Balcão', meta: NV('Cadastro CNPJ / RI da companhia') },
  WEGE: { cnpj: '84.429.695/0001-11', nome: 'WEG S.A.', meta: NV('Cadastro CNPJ / RI da companhia') },
};

/**
 * Version of the built-in CNPJ table. For the remaining issuers (FIIs, ETFs, BDRs, other shares) the
 * CNPJ is imported from the brokers' informes de rendimentos (`reconcileBrazil(...).cnpjByIssuer`)
 * and passed as `cnpjByIssuer` (T34).
 */
export const B3_CNPJ_VERSION = '2026-10-06';

/** DIRPF income lines for proventos. */
export const DIRPF_INCOME_LINES = {
  DIVIDENDO: { ficha: 'Rendimentos Isentos e Não Tributáveis', linha: '09', meta: V('DIRPF: Lucros e dividendos recebidos') },
  RENDIMENTO_FII: { ficha: 'Rendimentos Isentos e Não Tributáveis', linha: '26', meta: NV('Mercado indica linha 26; conferir no programa do ano') },
  ISENCAO_20K: { ficha: 'Rendimentos Isentos e Não Tributáveis', linha: '20', meta: NV('Ganhos líquidos em ações com alienações ≤ R$ 20 mil/mês') },
  JCP: { ficha: 'Rendimentos Sujeitos à Tributação Exclusiva/Definitiva', linha: '10', meta: V('DIRPF: Juros sobre capital próprio') },
  ALUGUEL: { ficha: 'Rendimentos Sujeitos à Tributação Exclusiva/Definitiva', linha: '06', meta: NV('Remuneração do doador no aluguel de ações (renda fixa, tabela regressiva)') },
} as const;
