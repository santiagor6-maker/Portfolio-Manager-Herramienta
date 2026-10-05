import type { CurrencyCode, ISODate } from '@pm/core';
import { CurrencyPool, type PoolBalance } from '../common/cashPool';
import { lastBrazilBusinessDayOfMonth, yearOf } from '../common/dates';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, TaxInput, TaxIssue } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap, sortTransactions, sum } from '../common/util';
import { classifyForBrazil, type BrCategory } from './classify';
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
  gainBrl: number;
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
export function brazilForeignAnnualReport(input: TaxInput, opts: BrForeignOptions): BrForeignReport {
  const cfgOf = opts.config ?? brazilConfig;
  const year = opts.year;
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
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
  if (!opts.ptax) {
    issues.push({
      level: 'info',
      code: 'PTAX_FALLBACK',
      message: 'Sem PTAX compra/venda separada: usada a cotação de mercado disponível para ambas (diferença normalmente < 0,1%).',
    });
  }

  const isForeign = (id?: string) => classifyForBrazil(id ? instruments.get(id) : undefined, opts.categoryOverrides) === 'FOREIGN';
  const pos = new Map<string, { qty: number; costFx: number; costBrl: number }>();
  const pool = new CurrencyPool();
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
          country: inst?.country,
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

  const txs = sortTransactions(input.transactions).filter((t) => t.date <= `${year}-12-31`);
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
      // Cash movements in foreign currency not tied to a domestic instrument.
      if (!foreignCash || (id && !isForeign(id))) continue;
      if (tx.type === 'DEPOSIT') pool.add(ccy, grossAmount(tx), grossAmount(tx) * rate('sell', ccy, tx.date));
      else if (tx.type === 'WITHDRAWAL' || tx.type === 'FEE' || tx.type === 'TAX') pool.remove(ccy, grossAmount(tx));
      else if (tx.type === 'INTEREST') {
        const gross = grossAmount(tx);
        const ps = rate('sell', ccy, tx.date);
        const pb = rate('buy', ccy, tx.date);
        agg(ty).income.push(incomeRow(tx.id, tx.date, undefined, undefined, 'JUROS', ccy, gross, taxes, ps, pb, cfgOf(ty)));
        pool.add(ccy, gross - taxes, (gross - taxes) * ps);
      } else if (tx.type === 'FX_CONVERSION') {
        const amt = grossAmount(tx);
        pool.remove(ccy, amt + fees);
        if (tx.toCurrency && tx.toCurrency !== 'BRL') pool.add(tx.toCurrency, tx.toAmount ?? 0, amt * rate('sell', ccy, tx.date));
      }
      continue;
    }
    // From here: transactions on a foreign instrument.
    const inst = instruments.get(id);
    const p = pos.get(id) ?? { qty: 0, costFx: 0, costBrl: 0 };
    pos.set(id, p);
    switch (tx.type) {
      case 'BUY':
      case 'TRANSFER_IN': {
        const costFx = grossAmount(tx) + fees;
        p.qty += tx.quantity ?? 0;
        p.costFx += costFx;
        p.costBrl += costFx * rate('buy', ccy, tx.date);
        if (tx.type === 'BUY') pool.remove(ccy, costFx);
        break;
      }
      case 'SELL':
      case 'TRANSFER_OUT': {
        const q = tx.quantity ?? 0;
        if (q > p.qty + 1e-9) {
          issues.push({
            level: 'error',
            code: 'OVERSELL',
            transactionId: tx.id,
            instrumentId: id,
            message: `Venda de ${q} ${displaySymbol(id, inst)} acima da posição (${p.qty}); custo do excedente = 0.`,
          });
        }
        const f = p.qty > 0 ? Math.min(1, q / p.qty) : 0;
        const costBrl = p.costBrl * f;
        p.qty = Math.max(0, p.qty - q);
        p.costFx -= p.costFx * f;
        p.costBrl -= costBrl;
        if (tx.type === 'SELL') {
          const proceedsFx = grossAmount(tx) - fees;
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
            gainBrl: proceedsBrl - costBrl,
          });
          pool.add(ccy, proceedsFx - taxes, (proceedsFx - taxes) * ps);
        }
        break;
      }
      case 'SPLIT':
        p.qty *= tx.ratio ?? 1;
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
        'Antes de 2024 os ganhos no exterior seguiam o GCAP mensal (isenção de vendas até R$ 35 mil/mês) e dividendos o carnê-leão; este relatório não calcula esse regime.',
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
