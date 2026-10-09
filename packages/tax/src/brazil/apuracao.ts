import type { ISODate, YearMonth } from '@pm/core';
import type { TransferBasisMap } from '../common/basis';
import { lastBrazilBusinessDayOfMonth, lastDayOfMonth, monthRange, nextMonth } from '../common/dates';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, TaxInput, TaxIssue } from '../common/types';
import { round2, sum } from '../common/util';
import { isApuracaoCategory, type BrCategory } from './classify';
import { brazilConfig, type BrazilTaxYearConfig } from './config';
import { darfPaymentsFromTransactions, newDarf, settleDarfs, type DarfGuide, type DarfPayment } from './darf';
import { runBrazilB3Ledger, type BrShortPosition, type BrTrade } from './ledger';

export interface BrApuracaoOptions {
  /** Shortcut for from = `${year}-01`, to = `${year}-12`. */
  year?: number;
  from?: YearMonth;
  to?: YearMonth;
  /** Losses accumulated before the first recorded transaction (e.g. from a previous tool). */
  initialLosses?: { comum?: number; dayTrade?: number; fii?: number };
  categoryOverrides?: Record<string, BrCategory>;
  transferBasis?: TransferBasisMap;
  acceptNoteProposals?: boolean;
  /** Option expiry dates by instrument id (default: derived from the B3 series). */
  optionExpiries?: Record<string, ISODate>;
  /** Override yearly parameters. */
  config?: (year: number) => BrazilTaxYearConfig;
  /**
   * Credit the IRRF "dedo-duro" estimated when the broker did not report it. Default false: an
   * estimate is shown but not credited, so the DARF is never reduced by a withholding that may
   * not have happened.
   */
  creditEstimatedIrrf?: boolean;
  /** Reference date for DARF status (pendente / vencida). */
  asOf?: ISODate;
  /** DARF payments; TAX transactions in BRL with "DARF"/"6015" in the note are also used. */
  payments?: DarfPayment[];
  /** Monthly Selic (decimal) for late-payment interest, e.g. { '2026-01': 0.0116 } (BCB series 4390). */
  selicMonthly?: Record<YearMonth, number>;
}

export interface BrPoolResult {
  /** Net result of the month for the category (after removing exempt gains). */
  result: number;
  lossCarryIn: number;
  lossUsed: number;
  /** Day trade only: common losses used against day-trade gains. */
  lossUsedFromComum?: number;
  base: number;
  lossCarryOut: number;
  rate: number;
  tax: number;
}

/** Monthly DARF 6015 (same shape as every other DARF code, see `DarfGuide`). */
export type BrDarf = DarfGuide;

export interface BrMonthRow {
  month: YearMonth;
  /** Gross swing-trade sales of shares (ações) — base for the R$ 20k exemption. */
  salesAcoesSwing: number;
  exempt: boolean;
  /** Positive net result of shares exempt under Lei 11.033 art. 3º I (DIRPF isentos). */
  exemptGain: number;
  results: {
    acoes: number;
    /** Short sales of shares bought back this month (never exempt — conservative). */
    acoesShortCover: number;
    etf: number;
    bdr: number;
    opcoes: number;
    futuros: number;
    direitos: number;
    dayTrade: number;
    fii: number;
  };
  comum: BrPoolResult;
  dayTrade: BrPoolResult;
  fii: BrPoolResult;
  taxGross: number;
  irrf: {
    /** IRRF credited this month (reported + estimates when allowed). */
    month: number;
    reported: number;
    estimate: number;
    estimated: boolean;
    estimateCredited: boolean;
    carryIn: number;
    used: number;
    carryOut: number;
  };
  taxAfterIrrf: number;
  /** Tax below the DARF minimum carried from previous months. */
  pendingIn: number;
  darf?: BrDarf;
  pendingOut: number;
  trades: BrTrade[];
}

export interface BrApuracaoReport {
  country: 'BR';
  disclaimer: LocalizedText;
  from: YearMonth;
  to: YearMonth;
  months: BrMonthRow[];
  darfs: BrDarf[];
  totals: { taxGross: number; irrfUsed: number; darfTotal: number; exemptGain: number; darfOpen: number };
  lossesAtEnd: { comum: number; dayTrade: number; fii: number };
  /** IRRF not offset within each calendar year (can be used in the DIRPF annual adjustment). */
  irrfUnusedByYear: Record<number, number>;
  /** Fixed-income ETF trades (taxed at source by the fund; informative). */
  etfRendaFixaTrades: BrTrade[];
  openShorts: BrShortPosition[];
  assumptions: string[];
  issues: TaxIssue[];
}

function applyPool(result: number, carryIn: number, rate: number): BrPoolResult {
  let lossUsed = 0;
  let base = 0;
  let carryOut = carryIn;
  if (result > 0) {
    lossUsed = Math.min(result, carryIn);
    base = result - lossUsed;
    carryOut = carryIn - lossUsed;
  } else {
    carryOut = carryIn - result;
  }
  return { result, lossCarryIn: carryIn, lossUsed, base, lossCarryOut: carryOut, rate, tax: base * rate };
}

/**
 * Monthly apuração of capital gains on B3 (IN RFB 1.585/2015 arts. 56-71): ações (R$ 20k exemption),
 * ETFs, BDRs, options and rights (15%), day trade (20%), FIIs (20%), with separate loss
 * carryforward pools, IRRF credit, DARF 6015 due on the last bank business day of the following
 * month, the R$ 10 minimum rollover, payment status and late charges.
 */
export function brazilMonthlyApuracao(input: TaxInput, opts: BrApuracaoOptions = {}): BrApuracaoReport {
  const cfgOf = opts.config ?? brazilConfig;
  const to = opts.to ?? (opts.year ? `${opts.year}-12` : undefined);
  const ledger = runBrazilB3Ledger(input, {
    until: to ? lastDayOfMonth(to) : undefined,
    categoryOverrides: opts.categoryOverrides,
    transferBasis: opts.transferBasis,
    acceptNoteProposals: opts.acceptNoteProposals,
    optionExpiries: opts.optionExpiries,
    asOf: opts.asOf,
  });
  const issues: TaxIssue[] = [...ledger.issues];
  const trades = ledger.trades.filter((t) => isApuracaoCategory(t.category));
  const etfRf = ledger.trades.filter((t) => t.category === 'ETF_RF');
  if (etfRf.length) {
    issues.push({
      level: 'info',
      code: 'ETF_RF_WITHHELD_AT_SOURCE',
      message:
        'Vendas de ETF de renda fixa: o IR é retido na fonte (Lei 13.043/2014 art. 2º, alíquota conforme o prazo médio da carteira); ' +
        'não entram na apuração mensal nem em DARF. Declare em Tributação Exclusiva e Bens e Direitos 07-08.',
    });
  }
  const firstTradeMonth = trades.map((t) => t.month).sort()[0];
  const lastTradeMonth = trades.map((t) => t.month).sort().pop();
  const from = opts.from ?? (opts.year ? `${opts.year}-01` : (firstTradeMonth ?? '1970-01'));
  const end = to ?? lastTradeMonth ?? from;
  const start = firstTradeMonth && firstTradeMonth < from ? firstTradeMonth : from;

  const byMonth = new Map<YearMonth, BrTrade[]>();
  for (const t of trades) {
    const list = byMonth.get(t.month) ?? [];
    list.push(t);
    byMonth.set(t.month, list);
  }

  let lossComum = opts.initialLosses?.comum ?? 0;
  let lossDt = opts.initialLosses?.dayTrade ?? 0;
  let lossFii = opts.initialLosses?.fii ?? 0;
  let irrfCarry = 0;
  let pending = 0;
  let pendingMonths: YearMonth[] = [];
  const rows: BrMonthRow[] = [];
  const irrfUnusedByYear: Record<number, number> = {};
  const warnedYears = new Set<number>();
  const creditEstimate = opts.creditEstimatedIrrf ?? false;

  for (const month of monthRange(start, end)) {
    const year = Number(month.slice(0, 4));
    const cfg = cfgOf(year);
    if (!warnedYears.has(year) && Object.values(cfg.meta).some((m) => m.status === 'needs-verification')) {
      warnedYears.add(year);
      issues.push({
        level: 'info',
        code: 'PARAMS_NEED_VERIFICATION',
        message: `Alguns parâmetros de ${year} estão marcados para verificação (ver config.meta).`,
      });
    }
    if (month.endsWith('-01')) {
      if (irrfCarry > 0) irrfUnusedByYear[year - 1] = irrfCarry;
      irrfCarry = 0;
    }
    const mt = byMonth.get(month) ?? [];
    const sw = (c: BrCategory) => mt.filter((t) => t.kind === 'swing' && t.category === c);
    const acoesRegular = sw('ACAO').filter((t) => !t.shortCover);
    const acoesShort = sw('ACAO').filter((t) => t.shortCover);

    const salesAcoesSwing = sum(acoesRegular.map((t) => t.grossSales));
    const exempt = salesAcoesSwing <= cfg.stockSalesExemptionLimit;
    const acoesReg = sum(acoesRegular.map((t) => t.result));
    const acoesShortCover = sum(acoesShort.map((t) => t.result));
    const etf = sum(sw('ETF').map((t) => t.result));
    const bdr = sum(sw('BDR').map((t) => t.result));
    const opcoes = sum(sw('OPCAO').map((t) => t.result));
    const futuros = sum(sw('FUTURO').map((t) => t.result));
    const direitos = sum(sw('DIREITO').map((t) => t.result));
    const dayTrade = sum(mt.filter((t) => t.kind === 'daytrade' && t.category !== 'FII').map((t) => t.result));
    const fii = sum(mt.filter((t) => t.category === 'FII').map((t) => t.result));
    const exemptGain = exempt && acoesReg > 0 ? acoesReg : 0;

    const comumResult = (exempt ? Math.min(0, acoesReg) : acoesReg) + acoesShortCover + etf + bdr + opcoes + futuros + direitos;
    const comum = applyPool(comumResult, lossComum, cfg.swingRate);
    const dt = applyPool(dayTrade, lossDt, cfg.dayTradeRate);
    if (cfg.commonLossOffsetsDayTrade && dt.base > 0 && comum.lossCarryOut > 0) {
      const extra = Math.min(dt.base, comum.lossCarryOut);
      dt.base -= extra;
      dt.lossUsedFromComum = extra;
      dt.tax = dt.base * dt.rate;
      comum.lossCarryOut -= extra;
    }
    const fiiPool = applyPool(fii, lossFii, cfg.fiiRate);
    lossComum = comum.lossCarryOut;
    lossDt = dt.lossCarryOut;
    lossFii = fiiPool.lossCarryOut;
    const taxGross = comum.tax + dt.tax + fiiPool.tax;

    // IRRF: reported by the broker when available, otherwise estimated (credited only on request).
    const swingTrades = mt.filter((t) => t.kind === 'swing');
    const reportedSwing = sum(swingTrades.filter((t) => t.irrfReported !== undefined).map((t) => t.irrfReported!));
    const estSwingBase = sum(swingTrades.filter((t) => t.irrfReported === undefined).map((t) => t.grossSales));
    let estSwing = estSwingBase * cfg.irrfSwingRate;
    if (estSwing <= cfg.irrfMinimum) estSwing = 0;
    const dtTrades = mt.filter((t) => t.kind === 'daytrade');
    const reportedDt = sum(dtTrades.filter((t) => t.irrfReported !== undefined).map((t) => t.irrfReported!));
    const dtByDay = new Map<string, number>();
    for (const t of dtTrades.filter((x) => x.irrfReported === undefined)) {
      dtByDay.set(t.date, (dtByDay.get(t.date) ?? 0) + t.result);
    }
    const estDt = sum([...dtByDay.values()].map((r) => Math.max(0, r) * cfg.irrfDayTradeRate));
    const reported = reportedSwing + reportedDt;
    const estimate = estSwing + estDt;
    const irrfMonth = reported + (creditEstimate ? estimate : 0);
    const irrfAvail = irrfMonth + irrfCarry;
    const irrfUsed = Math.min(taxGross, irrfAvail);
    const irrfCarryIn = irrfCarry;
    irrfCarry = irrfAvail - irrfUsed;
    const taxAfterIrrf = taxGross - irrfUsed;

    const pendingIn = pending;
    const total = taxAfterIrrf + pending;
    let darf: BrDarf | undefined;
    if (total > 0 && round2(total) >= cfg.darfMinimum) {
      darf = newDarf(cfg.darfCode, month, total, [...pendingMonths, month]);
      pending = 0;
      pendingMonths = [];
    } else if (total > 0) {
      pending = total;
      if (taxAfterIrrf > 0) pendingMonths.push(month);
    }

    rows.push({
      month,
      salesAcoesSwing,
      exempt,
      exemptGain,
      results: { acoes: acoesReg + acoesShortCover, acoesShortCover, etf, bdr, opcoes, futuros, direitos, dayTrade, fii },
      comum,
      dayTrade: dt,
      fii: fiiPool,
      taxGross,
      irrf: {
        month: irrfMonth,
        reported,
        estimate,
        estimated: estimate > 0,
        estimateCredited: creditEstimate && estimate > 0,
        carryIn: irrfCarryIn,
        used: irrfUsed,
        carryOut: irrfCarry,
      },
      taxAfterIrrf,
      pendingIn,
      darf,
      pendingOut: pending,
      trades: mt,
    });
  }
  if (irrfCarry > 0) irrfUnusedByYear[Number(end.slice(0, 4))] = irrfCarry;
  if (pending > 0) {
    issues.push({
      level: 'info',
      code: 'DARF_PENDING_BELOW_MINIMUM',
      message: `Imposto de R$ ${pending.toFixed(2)} abaixo do mínimo de DARF (R$ 10,00) acumulado para os meses seguintes.`,
    });
  }
  if (rows.some((r) => r.irrf.estimate > 0 && !r.irrf.estimateCredited)) {
    issues.push({
      level: 'info',
      code: 'IRRF_ESTIMATE_NOT_CREDITED',
      message:
        'IRRF "dedo-duro" estimado (a corretora não o informou) não foi abatido do DARF. Confira a nota de corretagem e registre ' +
        'o valor no campo de impostos da venda, ou ative creditEstimatedIrrf.',
    });
  }

  // DARF payment status and late charges.
  const allDarfs = rows.flatMap((r) => (r.darf ? [r.darf] : []));
  const payments = [...(opts.payments ?? []), ...darfPaymentsFromTransactions(input.transactions)];
  issues.push(...settleDarfs(allDarfs, payments, { asOf: opts.asOf, selicMonthly: opts.selicMonthly }));

  const shown = rows.filter((r) => r.month >= from && r.month <= end);
  const darfs = shown.flatMap((r) => (r.darf ? [r.darf] : []));
  return {
    country: 'BR',
    disclaimer: TAX_DISCLAIMER,
    from,
    to: end,
    months: shown,
    darfs,
    totals: {
      taxGross: sum(shown.map((r) => r.taxGross)),
      irrfUsed: sum(shown.map((r) => r.irrf.used)),
      darfTotal: sum(darfs.map((d) => d.amount)),
      exemptGain: sum(shown.map((r) => r.exemptGain)),
      darfOpen: sum(darfs.filter((d) => d.status === 'pendente' || d.status === 'vencida').map((d) => d.late?.total ?? d.amount)),
    },
    lossesAtEnd: { comum: lossComum, dayTrade: lossDt, fii: lossFii },
    irrfUnusedByYear,
    etfRendaFixaTrades: etfRf.filter((t) => t.month >= from && t.month <= end),
    openShorts: ledger.openShorts,
    assumptions: [
      'Custo pelo preço médio ponderado, incluindo corretagem e emolumentos (IN RFB 1.585/2015 art. 58), independentemente do método de custo do portfólio.',
      'Day trade: compra e venda do mesmo ativo no mesmo dia na mesma corretora (campo account); casadas primeiro, sem alterar o preço médio da posição.',
      'Limite de R$ 20 mil considera as vendas de ações no mercado à vista em operações comuns (swing trade), inclusive vendas a descoberto no mês em que são feitas; não se aplica a ETFs, BDRs, opções, direitos, FIIs nem day trade.',
      'Venda a descoberto: o valor da venda conta para o limite de R$ 20 mil do mês da venda; o resultado é apurado na recompra e não recebe a isenção (leitura conservadora). Vendas sem posição nunca geram DARF até a recompra ou o registro da compra.',
      'Opções: vencimento derivado da letra da série (terceira sexta-feira); sem exercício, a posição é encerrada a zero no vencimento (prêmio do lançador tributado; prêmio pago do titular é perda). Exercício (TRANSFER_OUT/IN com nota "exercício") ajusta o prêmio ao custo/preço do ativo-objeto no mesmo dia.',
      'Prejuízo de ações em mês isento é acumulado para compensação futura; ganho isento não consome prejuízo acumulado.',
      'Prejuízos de day trade compensam só day trade; prejuízos de operações comuns podem compensar também day trade; FII tem compensação separada.',
      'IRRF (0,005% swing / 1% day trade) informado no campo taxes das vendas; quando ausente, é estimado e mostrado, mas só abatido com creditEstimatedIrrf.',
      'ETF de renda fixa (Lei 13.043/2014): IR retido na fonte, fora da apuração mensal.',
      'Futuros (WIN, WDO, IND, DOL...): resultado por compra/venda (valor = quantidade x pontos x valor do ponto); ajustes diários de posições mantidas de um dia para outro não são modelados — registre o resultado de cada encerramento.',
      'Vencimento do DARF: último dia útil bancário do mês seguinte (31/12 sem expediente bancário; feriados locais não considerados).',
    ],
    issues,
  };
}

