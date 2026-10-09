import type { CurrencyCode, ISODate } from '@pm/core';
import { basisTotalCost, resolveTransferBasis, snapRatio, type TransferBasisMap } from '../common/basis';
import { CurrencyPool, type PoolBalance } from '../common/cashPool';
import { addDays, isBrazilBusinessDay, lastBrazilBusinessDayOfMonth, nextMonth, yearOf } from '../common/dates';
import { gcapTax } from './crypto';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, TaxInput, TaxIssue } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap, sortTransactions, sum } from '../common/util';
import { classifyForBrazil, routeCryptoByCustody, type BrCategory, type CryptoCustody } from './classify';
import { brazilConfig, type BrazilTaxYearConfig } from './config';

/** BCB PTAX closing rates (BRL per unit of foreign currency). */
export interface PtaxProvider {
  /** PTAX de compra. */
  buy(currency: CurrencyCode, date: ISODate): number | undefined;
  /** PTAX de venda. */
  sell(currency: CurrencyCode, date: ISODate): number | undefined;
}

export interface BrForeignOptions {
  year: number;
  /** Official PTAX buy/sell. Falls back to `market.fx(currency, 'BRL', date)` for both. */
  ptax?: PtaxProvider;
  /** Losses (BRL) from foreign applications carried into the first computed year. */
  initialLossCarry?: number;
  /** Original cost of securities received by TRANSFER_IN. */
  transferBasis?: TransferBasisMap;
  /** Apply free-text cost hints found in notes; default false (proposal only). */
  acceptNoteProposals?: boolean;
  /** Crypto custody per instrument id (foreign custody → this report, Lei 14.754). */
  cryptoCustody?: Record<string, CryptoCustody>;
  /** Crypto custody per account/broker name (`Transaction.account`). */
  accountCustody?: Record<string, CryptoCustody>;
  /**
   * Pre-2024 only (IN SRF 118/2000): instruments bought with income earned abroad — the gain is computed
   * in foreign currency and converted at the PTAX of the sale date (T45).
   */
  foreignOriginInstruments?: string[];
  /**
   * Portfolio base currency; when 'BRL' (default) `fxRateToBase` of foreign-currency deposits is
   * used as the cost actually paid for the currency (IN RFB 2.180/2024).
   */
  portfolioBaseCurrency?: CurrencyCode;
  config?: (year: number) => BrazilTaxYearConfig;
  categoryOverrides?: Record<string, BrCategory>;
}

export interface BrForeignSaleRow {
  transactionId: string;
  date: ISODate;
  instrumentId: string;
  symbol: string;
  currency: CurrencyCode;
  quantity: number;
  /** Net of fees, foreign currency. */
  proceedsFx: number;
  ptaxSell: number;
  proceedsBrl: number;
  /** Average acquisition cost in BRL (each purchase at PTAX de compra of its date). */
  costBrl: number;
  /** Average acquisition cost in the foreign currency. */
  costFx: number;
  gainBrl: number;
  /** Sold units without recorded acquisition (crypto): gain pending, excluded from the base (T56). */
  pendingCost?: boolean;
}

export interface BrForeignIncomeRow {
  transactionId: string;
  date: ISODate;
  instrumentId?: string;
  symbol?: string;
  type: 'DIVIDENDO' | 'JUROS';
  currency: CurrencyCode;
  grossFx: number;
  ptaxSell: number;
  grossBrl: number;
  foreignTaxFx: number;
  ptaxBuy: number;
  foreignTaxBrl: number;
  /** Credit cap for this income: min(foreign tax, Brazilian rate x income). */
  creditCapBrl: number;
}

export interface BrForeignPosition {
  instrumentId: string;
  symbol: string;
  name?: string;
  country?: string;
  assetClass?: string;
  currency: CurrencyCode;
  quantity: number;
  costFx: number;
  costBrl: number;
}

export interface BrForeignYearTotals {
  gainsBrl: number;
  lossesBrl: number;
  netCapitalBrl: number;
  incomeBrl: number;
  netResultBrl: number;
  lossCarryIn: number;
  lossUsed: number;
  lossCarryOut: number;
  baseBrl: number;
  rate: number;
  taxGrossBrl: number;
  foreignTaxPaidBrl: number;
  foreignTaxCreditBrl: number;
  taxDueBrl: number;
}

export interface BrForeignReport {
  country: 'BR';
  year: number;
  regime: 'lei-14754' | 'pre-2024';
  /**
   * Before 2024 (T12): sales of foreign assets were taxed monthly via GCAP (exempt when the month's
   * sales of foreign assets <= R$ 35k; 15%-22.5%; DARF 4600; no loss offset) and dividends via carnê-leão.
   */
  gcapPre2024?: {
    months: { month: string; salesBrl: number; exempt: boolean; gainBrl: number; tax: number; darfDueDate?: ISODate }[];
    totalTax: number;
    dividendsCarneLeaoBrl: number;
    /** Carnê-leão on foreign dividends/interest (T45): monthly progressive table, credit for tax paid abroad. */
    carneLeao: { month: string; incomeBrl: number; taxTable: number; foreignTaxCreditBrl: number; taxDue: number; darfCode: '0190'; dueDate: ISODate }[];
    carneLeaoTotal: number;
  };
  disclaimer: LocalizedText;
  sales: BrForeignSaleRow[];
  income: BrForeignIncomeRow[];
  totals: BrForeignYearTotals;
  /** Positions at Dec 31 of the year and of the previous year (cost in BRL, for Bens e Direitos). */
  positions: BrForeignPosition[];
  positionsPrevYear: BrForeignPosition[];
  /** Foreign cash at Dec 31 at historical BRL cost. */
  cash: PoolBalance[];
  cashPrevYear: PoolBalance[];
  /** Tax is paid with the annual return (DAA), by its deadline (normally the last business day of May). */
  dueDateEstimate: ISODate;
  notes: string[];
  issues: TaxIssue[];
}

interface YearAgg {
  sales: BrForeignSaleRow[];
  income: BrForeignIncomeRow[];
}

/**
 * Lei 14.754/2023 (IN RFB 2.180/2024): from 2024, income and gains from financial applications
 * abroad of Brazilian residents are taxed annually at 15% in the DIRPF ("Aplicações Financeiras
 * no Exterior"): gains include the FX variation of the principal (cost at PTAX de compra on the
 * purchase date, proceeds at PTAX de venda on the sale date), dividends/interest converted at
 * PTAX de venda of the receipt date, losses offset within the year and carried forward, and tax
 * paid abroad credited up to the Brazilian tax on that income.
 */
export function brazilForeignAnnualReport(rawInput: TaxInput, opts: BrForeignOptions): BrForeignReport {
  const routed = routeCryptoByCustody(rawInput, {
    cryptoCustody: opts.cryptoCustody,
    accountCustody: opts.accountCustody,
    brlRate: opts.ptax ? (c, d) => opts.ptax!.buy(c, d) : undefined,
  });
  const routingIssues = routed.issues;
  const input = routed.input;
  const cryptoCustody = routed.custody;
  const cfgOf = opts.config ?? brazilConfig;
  const year = opts.year;
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [...routingIssues];
  const missing = new Set<string>();

  const rate = (kind: 'buy' | 'sell', ccy: CurrencyCode, date: ISODate): number => {
    if (ccy === 'BRL') return 1;
    const r = opts.ptax ? opts.ptax[kind](ccy, date) : input.market.fx(ccy, 'BRL', date);
    if (r === undefined || !(r > 0)) {
      const k = `${ccy}@${date}`;
      if (!missing.has(k)) {
        missing.add(k);
        issues.push({ level: 'error', code: 'MISSING_PTAX', message: `PTAX ${ccy} ausente para ${date}; valores em BRL zerados.` });
      }
      return 0;
    }
    return r;
  };
  /** Carnê-leão: USD "cotação de compra" of the last business day of the 1st half of the previous month. */
  const carneLeaoRate = (ccy: CurrencyCode, date: ISODate): number => {
    const [y, m] = date.split('-').map(Number) as [number, number];
    const pm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    let d = `${pm}-15`;
    while (!isBrazilBusinessDay(d)) d = addDays(d, -1);
    return rate('buy', ccy, d);
  };
  if (!opts.ptax) {
    issues.push({
      level: 'info',
      code: 'PTAX_FALLBACK',
      message: 'Sem PTAX compra/venda separada: usada a cotação de mercado disponível para ambas (diferença normalmente < 0,1%).',
    });
  }

  const isForeign = (id?: string) => classifyForBrazil(id ? instruments.get(id) : undefined, opts.categoryOverrides, cryptoCustody) === 'FOREIGN';
  const pos = new Map<string, { qty: number; costFx: number; costBrl: number }>();
  const pool = new CurrencyPool();
  let shortfallWarned = false;
  const removeCash = (tx: { id: string; date: ISODate }, ccy: CurrencyCode, units: number) => {
    const r = pool.remove(ccy, units);
    if (r.uncovered > 1e-6 && !shortfallWarned) {
      shortfallWarned = true;
      issues.push({
        level: 'info',
        code: 'FOREIGN_CASH_NOT_RECORDED',
        transactionId: tx.id,
        message:
          `Saída de ${ccy} sem saldo registrado (falta a remessa/depósito). Registre a remessa (FX_CONVERSION BRL→${ccy} ou ` +
          'DEPOSIT com a taxa efetiva) para que o saldo e o custo em reais do dinheiro no exterior fiquem corretos.',
      });
    }
    return r;
  };
  const byYear = new Map<number, YearAgg>();
  const agg = (y: number) => {
    let a = byYear.get(y);
    if (!a) byYear.set(y, (a = { sales: [], income: [] }));
    return a;
  };
  const snapshots = new Map<number, { positions: BrForeignPosition[]; cash: PoolBalance[] }>();
  const snapshot = (): { positions: BrForeignPosition[]; cash: PoolBalance[] } => ({
    positions: [...pos.entries()]
      .filter(([, p]) => p.qty > 1e-9)
      .map(([id, p]) => {
        const inst = instruments.get(id);
        return {
          instrumentId: id,
          symbol: displaySymbol(id, inst),
          name: inst?.name,
          // Crypto: country of the custodian venue, not of the quote (T50); '' when unknown.
          country: inst?.assetClass === 'crypto' ? (routed.venueCountry[id] ?? '') : inst?.country,
          assetClass: inst?.assetClass,
          currency: inst?.currency ?? 'USD',
          quantity: p.qty,
          costFx: p.costFx,
          costBrl: p.costBrl,
        };
      })
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    cash: pool.snapshot(),
  });

  const txs = sortTransactions(input.transactions, { outBeforeIn: true }).filter((t) => t.date <= `${year}-12-31`);
  let curYear: number | undefined;
  const firstYear = txs[0] ? yearOf(txs[0].date) : year;
  for (const tx of txs) {
    const ty = yearOf(tx.date);
    if (curYear !== undefined && ty !== curYear) {
      for (let y = curYear; y < ty; y++) snapshots.set(y, snapshot());
    }
    curYear = ty;
    const ccy = tx.currency;
    const foreignCash = ccy !== 'BRL';
    const fees = tx.fees ?? 0;
    const taxes = tx.taxes ?? 0;
    const id = tx.instrumentId;

    if (!id || !isForeign(id)) {
      if (id && !isForeign(id)) continue;
      if (tx.type === 'FX_CONVERSION') {
        const amt = grossAmount(tx);
        const to = tx.toCurrency;
        const toAmt = tx.toAmount ?? 0;
        if (!foreignCash) {
          // Remittance BRL -> foreign currency: cost is the amount effectively paid (IN RFB 2.180/2024).
          if (to && to !== 'BRL') pool.add(to, toAmt, amt + fees);
        } else {
          const r = removeCash(tx, ccy, amt + fees);
          if (to && to !== 'BRL') pool.add(to, toAmt, r.costRemoved + r.uncovered * rate('sell', ccy, tx.date));
        }
        continue;
      }
      // Cash movements in foreign currency not tied to a domestic instrument.
      if (!foreignCash) continue;
      if (tx.type === 'DEPOSIT') {
        const amt = grossAmount(tx);
        const paid = tx.fxRateToBase !== undefined && (opts.portfolioBaseCurrency ?? 'BRL') === 'BRL' ? amt * tx.fxRateToBase : undefined;
        pool.add(ccy, amt, paid ?? amt * rate('sell', ccy, tx.date));
      } else if (tx.type === 'WITHDRAWAL' || tx.type === 'FEE' || tx.type === 'TAX') removeCash(tx, ccy, grossAmount(tx));
      else if (tx.type === 'INTEREST') {
        const gross = grossAmount(tx);
        const ps = rate('sell', ccy, tx.date);
        const pb = rate('buy', ccy, tx.date);
        agg(ty).income.push(incomeRow(tx.id, tx.date, undefined, undefined, 'JUROS', ccy, gross, taxes, ps, pb, cfgOf(ty)));
        pool.add(ccy, gross - taxes, (gross - taxes) * ps);
      }
      continue;
    }
    // From here: transactions on a foreign instrument.
    const inst = instruments.get(id);
    const p = pos.get(id) ?? { qty: 0, costFx: 0, costBrl: 0 };
    pos.set(id, p);
    switch (tx.type) {
      case 'BUY': {
        const costFx = grossAmount(tx) + fees;
        p.qty += tx.quantity ?? 0;
        p.costFx += costFx;
        p.costBrl += costFx * rate('buy', ccy, tx.date);
        removeCash(tx, ccy, costFx);
        break;
      }
      case 'TRANSFER_IN': {
        const qty = tx.quantity ?? 0;
        const { basis, proposal } = resolveTransferBasis(tx, { ...routed.transferBasis, ...(opts.transferBasis ?? {}) }, opts.acceptNoteProposals);
        const original = basis ? basisTotalCost(basis, qty) : undefined;
        const costFx = original ?? grossAmount(tx) + fees;
        const fx = basis?.fxRate ?? rate('buy', ccy, basis?.openDate ?? tx.date);
        if (proposal) {
          issues.push({
            level: 'warning',
            code: 'TRANSFER_BASIS_PROPOSED',
            transactionId: tx.id,
            instrumentId: id,
            message:
              `A nota da transferência de ${displaySymbol(id, inst)} sugere compra em ${proposal.openDate} a ${proposal.unitCost} por unidade; ` +
              'não aplicada automaticamente. Confirme (transferBasis, nota "[custo: AAAA-MM-DD @ preço]" ou acceptNoteProposals).',
          });
        }
        if (original === undefined && !proposal) {
          issues.push({
            level: 'warning',
            code: 'TRANSFER_COST_UNKNOWN',
            transactionId: tx.id,
            instrumentId: id,
            message: `Transferência de ${displaySymbol(id, inst)} sem custo original: usado o valor da transferência. Informe o custo de aquisição (transferBasis ou nota "[custo: AAAA-MM-DD @ preço]").`,
          });
        }
        p.qty += qty;
        p.costFx += costFx;
        p.costBrl += costFx * fx;
        break;
      }
      case 'SELL':
      case 'TRANSFER_OUT': {
        if (tx.type === 'SELL' && routed.pendingCostSales.has(tx.id)) {
          const ps = rate('sell', ccy, tx.date);
          const proceedsFx = grossAmount(tx) - fees;
          agg(ty).sales.push({
            transactionId: tx.id,
            date: tx.date,
            instrumentId: id,
            symbol: displaySymbol(id, inst),
            currency: ccy,
            quantity: tx.quantity ?? 0,
            proceedsFx,
            ptaxSell: ps,
            proceedsBrl: proceedsFx * ps,
            costBrl: 0,
            costFx: 0,
            gainBrl: 0,
            pendingCost: true,
          });
          break;
        }
        const qRequested = tx.quantity ?? 0;
        const q = Math.min(qRequested, p.qty);
        if (qRequested > p.qty + 1e-9) {
          issues.push({
            level: 'error',
            code: 'OVERSELL',
            transactionId: tx.id,
            instrumentId: id,
            message:
              `Venda de ${qRequested} ${displaySymbol(id, inst)} acima da posição (${p.qty}): o excedente não foi apurado ` +
              '(sem ganho fictício). Registre a compra ou a transferência com o custo original.',
          });
        }
        const coveredShare = qRequested > 0 ? q / qRequested : 0;
        const f = p.qty > 0 ? Math.min(1, q / p.qty) : 0;
        const costBrl = p.costBrl * f;
        const costFxSold = p.costFx * f;
        p.qty = Math.max(0, p.qty - q);
        p.costFx -= p.costFx * f;
        p.costBrl -= costBrl;
        if (tx.type === 'SELL' && q > 1e-12) {
          const proceedsFx = (grossAmount(tx) - fees) * coveredShare;
          const ps = rate('sell', ccy, tx.date);
          const proceedsBrl = proceedsFx * ps;
          agg(ty).sales.push({
            transactionId: tx.id,
            date: tx.date,
            instrumentId: id,
            symbol: displaySymbol(id, inst),
            currency: ccy,
            quantity: q,
            proceedsFx,
            ptaxSell: ps,
            proceedsBrl,
            costBrl,
            costFx: costFxSold,
            gainBrl: proceedsBrl - costBrl,
          });
          pool.add(ccy, proceedsFx - taxes, (proceedsFx - taxes) * ps);
        }
        break;
      }
      case 'SPLIT':
        p.qty *= snapRatio(tx.ratio ?? 1);
        if (Math.abs(p.qty - Math.round(p.qty)) < 0.01) p.qty = Math.round(p.qty);
        break;
      case 'STOCK_DIVIDEND': {
        const newQty = tx.quantity ?? p.qty * (tx.ratio ?? 0);
        p.qty += newQty;
        if (tx.price) {
          p.costFx += newQty * tx.price;
          p.costBrl += newQty * tx.price * rate('buy', ccy, tx.date);
        }
        break;
      }
      case 'RETURN_OF_CAPITAL': {
        const amt = grossAmount(tx);
        const f = p.costFx > 0 ? Math.min(1, amt / p.costFx) : 0;
        p.costFx -= p.costFx * f;
        p.costBrl -= p.costBrl * f;
        pool.add(ccy, amt, amt * rate('sell', ccy, tx.date));
        break;
      }
      case 'DIVIDEND':
      case 'INTEREST': {
        const gross = grossAmount(tx);
        const ps = rate('sell', ccy, tx.date);
        const pb = rate('buy', ccy, tx.date);
        agg(ty).income.push(
          incomeRow(tx.id, tx.date, id, displaySymbol(id, inst), tx.type === 'DIVIDEND' ? 'DIVIDENDO' : 'JUROS', ccy, gross, taxes, ps, pb, cfgOf(ty)),
        );
        pool.add(ccy, gross - taxes, (gross - taxes) * ps);
        break;
      }
      default:
        break;
    }
  }
  if (curYear !== undefined) for (let y = curYear; y <= year; y++) snapshots.set(y, snapshot());

  // Loss carryforward across years (Lei 14.754 regime only).
  let carry = opts.initialLossCarry ?? 0;
  let totals: BrForeignYearTotals | undefined;
  for (let y = Math.min(firstYear, year); y <= year; y++) {
    const cfg = cfgOf(y);
    const a = byYear.get(y) ?? { sales: [], income: [] };
    const t = computeYear(a, carry, cfg);
    if (cfg.foreignApplicationsRate !== undefined) carry = t.lossCarryOut;
    totals = t;
  }
  const cfgYear = cfgOf(year);
  const regime = cfgYear.foreignApplicationsRate !== undefined ? 'lei-14754' : 'pre-2024';
  if (regime === 'pre-2024') {
    issues.push({
      level: 'warning',
      code: 'PRE_LEI_14754',
      message:
        'Antes de 2024 os ganhos no exterior seguiam o GCAP mensal (isenção de vendas até R$ 35 mil/mês, DARF 4600) e dividendos o carnê-leão: ver gcapPre2024 (estimativa; regras de conversão cambial do período anterior simplificadas).',
    });
  }
  const a = byYear.get(year) ?? { sales: [], income: [] };
  const snap = snapshots.get(year) ?? { positions: [], cash: [] };
  const prev = snapshots.get(year - 1) ?? { positions: [], cash: [] };

  return {
    country: 'BR',
    year,
    regime,
    disclaimer: TAX_DISCLAIMER,
    sales: a.sales,
    income: a.income,
    totals: totals ?? computeYear(a, carry, cfgYear),
    gcapPre2024: regime === 'pre-2024' ? pre2024(a, opts.foreignOriginInstruments ?? [], carneLeaoRate) : undefined,
    positions: snap.positions,
    positionsPrevYear: prev.positions,
    cash: snap.cash,
    cashPrevYear: prev.cash,
    dueDateEstimate: lastBrazilBusinessDayOfMonth(`${year + 1}-05`),
    notes: [
      'Lei 14.754/2023 arts. 2º a 6º e IN RFB 2.180/2024: alíquota de 15% na DAA, ficha "Bens e Direitos" / "Aplicações Financeiras no Exterior"; apuração anual em regime de caixa.',
      'Custo de aquisição convertido pela PTAX de compra da data da compra; valor de venda e rendimentos pela PTAX de venda da data do recebimento; imposto pago no exterior pela PTAX de compra da data do pagamento (IN RFB 2.180/2024).',
      'Prejuízos compensam ganhos e rendimentos de aplicações no exterior do mesmo ano e de anos seguintes (apurados a partir de 2024).',
      'Crédito do imposto pago no exterior limitado ao imposto brasileiro sobre o mesmo rendimento; exige acordo para evitar bitributação ou reciprocidade (os EUA têm reciprocidade reconhecida pela RFB).',
      'Variação cambial de depósitos em moeda estrangeira não remunerados não é tributada; contas remuneradas (ex.: juros da corretora) geram rendimento tributável.',
      'Prazo de pagamento: até a data de entrega da DIRPF do ano seguinte (estimado como último dia útil de maio; conferir a IN anual).',
    ],
    issues,
  };
}

function incomeRow(
  transactionId: string,
  date: ISODate,
  instrumentId: string | undefined,
  symbol: string | undefined,
  type: 'DIVIDENDO' | 'JUROS',
  currency: CurrencyCode,
  gross: number,
  taxes: number,
  ptaxSell: number,
  ptaxBuy: number,
  cfg: BrazilTaxYearConfig,
): BrForeignIncomeRow {
  const grossBrl = gross * ptaxSell;
  const foreignTaxBrl = taxes * ptaxBuy;
  return {
    transactionId,
    date,
    instrumentId,
    symbol,
    type,
    currency,
    grossFx: gross,
    ptaxSell,
    grossBrl,
    foreignTaxFx: taxes,
    ptaxBuy,
    foreignTaxBrl,
    creditCapBrl: Math.min(foreignTaxBrl, grossBrl * (cfg.foreignApplicationsRate ?? 0)),
  };
}

function computeYear(a: YearAgg, carryIn: number, cfg: BrazilTaxYearConfig): BrForeignYearTotals {
  const rate = cfg.foreignApplicationsRate ?? 0;
  const gains = sum(a.sales.filter((s) => s.gainBrl > 0).map((s) => s.gainBrl));
  const losses = sum(a.sales.filter((s) => s.gainBrl < 0).map((s) => -s.gainBrl));
  const incomeBrl = sum(a.income.map((i) => i.grossBrl));
  const net = gains - losses + incomeBrl;
  let lossUsed = 0;
  let base = 0;
  let carryOut = carryIn;
  if (net > 0) {
    lossUsed = Math.min(net, carryIn);
    base = net - lossUsed;
    carryOut = carryIn - lossUsed;
  } else {
    carryOut = carryIn - net;
  }
  const taxGross = base * rate;
  const foreignTaxPaid = sum(a.income.map((i) => i.foreignTaxBrl));
  const credit = Math.min(taxGross, sum(a.income.map((i) => i.creditCapBrl)));
  return {
    gainsBrl: gains,
    lossesBrl: losses,
    netCapitalBrl: gains - losses,
    incomeBrl,
    netResultBrl: net,
    lossCarryIn: carryIn,
    lossUsed,
    lossCarryOut: carryOut,
    baseBrl: base,
    rate,
    taxGrossBrl: taxGross,
    foreignTaxPaidBrl: foreignTaxPaid,
    foreignTaxCreditBrl: credit,
    taxDueBrl: taxGross - credit,
  };
}

/** Monthly IRPF table (carnê-leão): [upTo, rate, deduction]. Until Apr/2023 and from May/2023 (Lei 14.663/2023). */
const IRPF_MONTHLY_OLD: [number, number, number][] = [[1903.98, 0, 0], [2826.65, 0.075, 142.8], [3751.05, 0.15, 354.8], [4664.68, 0.225, 636.13], [Infinity, 0.275, 869.36]];
const IRPF_MONTHLY_2023_05: [number, number, number][] = [[2112, 0, 0], [2826.65, 0.075, 158.4], [3751.05, 0.15, 370.4], [4664.68, 0.225, 651.73], [Infinity, 0.275, 884.96]];

export function irpfMonthlyTax(base: number, month: string): number {
  const table = month >= '2023-05' ? IRPF_MONTHLY_2023_05 : IRPF_MONTHLY_OLD;
  const row = table.find(([upTo]) => base <= upTo)!;
  return Math.max(0, base * row[1] - row[2]);
}

function pre2024(
  a: YearAgg,
  foreignOrigin: string[],
  carneLeaoRate: (ccy: CurrencyCode, date: ISODate) => number,
): NonNullable<BrForeignReport['gcapPre2024']> {
  const gain = (x: BrForeignSaleRow) => (foreignOrigin.includes(x.instrumentId) ? (x.proceedsFx - x.costFx) * x.ptaxSell : x.gainBrl);
  const byMonth = new Map<string, BrForeignSaleRow[]>();
  for (const s of a.sales) byMonth.set(s.date.slice(0, 7), [...(byMonth.get(s.date.slice(0, 7)) ?? []), s]);
  const months = [...byMonth.entries()].sort().map(([month, list]) => {
    const salesBrl = sum(list.map((x) => x.proceedsBrl));
    const exempt = salesBrl <= 35_000;
    const gainBrl = sum(list.map((x) => Math.max(0, gain(x))));
    const tax = exempt ? 0 : sum(list.map((x) => gcapTax(Math.max(0, gain(x)))));
    return { month, salesBrl, exempt, gainBrl, tax, darfDueDate: tax > 0 ? lastBrazilBusinessDayOfMonth(nextMonth(month)) : undefined };
  });
  const incByMonth = new Map<string, { income: number; foreignTax: number }>();
  for (const i of a.income) {
    const m = i.date.slice(0, 7);
    const r = carneLeaoRate(i.currency, i.date);
    const acc = incByMonth.get(m) ?? { income: 0, foreignTax: 0 };
    acc.income += i.grossFx * r;
    acc.foreignTax += i.foreignTaxFx * r;
    incByMonth.set(m, acc);
  }
  const carneLeao = [...incByMonth.entries()].sort().map(([month, v]) => {
    const taxTable = irpfMonthlyTax(v.income, month);
    const credit = Math.min(v.foreignTax, taxTable);
    return {
      month,
      incomeBrl: v.income,
      taxTable,
      foreignTaxCreditBrl: credit,
      taxDue: taxTable - credit,
      darfCode: '0190' as const,
      dueDate: lastBrazilBusinessDayOfMonth(nextMonth(month)),
    };
  });
  return {
    months,
    totalTax: sum(months.map((m) => m.tax)),
    dividendsCarneLeaoBrl: sum(a.income.map((i) => i.grossBrl)),
    carneLeao,
    carneLeaoTotal: sum(carneLeao.map((c) => c.taxDue)),
  };
}
