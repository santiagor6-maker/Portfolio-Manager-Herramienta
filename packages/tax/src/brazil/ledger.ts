import type { ISODate, Transaction, YearMonth } from '@pm/core';
import { basisTotalCost, transferBasisOf, type TransferBasisMap } from '../common/basis';
import { monthOf } from '../common/dates';
import type { TaxInput, TaxIssue } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap, sortTransactions } from '../common/util';
import { classifyForBrazil, isB3Category, type BrCategory } from './classify';

export interface BrTrade {
  date: ISODate;
  month: YearMonth;
  instrumentId: string;
  symbol: string;
  category: BrCategory;
  kind: 'swing' | 'daytrade';
  quantity: number;
  /** Gross sale value (quantity x price), used for the R$ 20k limit and IRRF base. */
  grossSales: number;
  /** Sale value net of corretagem/emolumentos. */
  netProceeds: number;
  /** Cost: preço médio (swing) or same-day average buy cost (day trade), fees included. */
  cost: number;
  result: number;
  /** IRRF reported by the broker on these sells (`taxes` field), if present. */
  irrfReported?: number;
  /** Closing (buy-back) of a short sale (venda a descoberto); result recognized at the cover date. */
  shortCover?: boolean;
  /** Date of the short sale, for short covers. */
  shortSaleDate?: ISODate;
  transactionIds: string[];
}

export interface BrPosition {
  instrumentId: string;
  symbol: string;
  category: BrCategory;
  quantity: number;
  /** Total acquisition cost in BRL (fees included). */
  totalCost: number;
  averageCost: number;
}

export interface BrShortPosition {
  instrumentId: string;
  symbol: string;
  category: BrCategory;
  quantity: number;
  /** Net proceeds of the open short sales. */
  proceeds: number;
  since: ISODate;
}

export interface BrLedgerResult {
  trades: BrTrade[];
  positions: BrPosition[];
  /** Short sales not yet bought back — or sells without recorded purchases (missing history). */
  openShorts: BrShortPosition[];
  issues: TaxIssue[];
}

export interface BrLedgerOptions {
  /** Process transactions up to and including this date. */
  until?: ISODate;
  categoryOverrides?: Record<string, BrCategory>;
  /** Original cost of securities received by TRANSFER_IN (custody transfer between brokers). */
  transferBasis?: TransferBasisMap;
}

interface Side {
  qty: number;
  gross: number;
  /** Buys: cost incl. fees. Sells: proceeds net of fees. */
  value: number;
  irrf: number;
  irrfKnown: boolean;
  ids: string[];
}
const emptySide = (): Side => ({ qty: 0, gross: 0, value: 0, irrf: 0, irrfKnown: false, ids: [] });

interface Pos {
  qty: number;
  cost: number;
  shortQty: number;
  shortNet: number;
  shortGross: number;
  shortIrrf: number;
  shortIrrfKnown: boolean;
  shortSince?: ISODate;
  /** Fraction left by a grupamento/desdobramento, awaiting the company's auction (leilão de frações). */
  fracQty: number;
  fracCost: number;
}

/**
 * Brazilian B3 ledger with preço médio (weighted average cost incl. fees, IN RFB 1.585/2015 art. 58)
 * regardless of the portfolio display cost method, and day-trade detection: buys and sells of the
 * same asset on the same day at the same broker (account) are matched first as day trade.
 *
 * Sells above the long position open a short position (venda a descoberto); its result is
 * recognized when bought back (IN RFB 1.585/2015: in "vendas a descoberto" the gain is computed
 * on the date of the buy-back). A short never bought back produces no tax and is reported in `openShorts`, which
 * also catches incomplete purchase history instead of inventing a zero-cost gain.
 */
export function runBrazilB3Ledger(input: TaxInput, opts: BrLedgerOptions = {}): BrLedgerResult {
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
  const pos = new Map<string, Pos>();
  const trades: BrTrade[] = [];

  const cat = (id: string | undefined): BrCategory =>
    classifyForBrazil(id ? instruments.get(id) : undefined, opts.categoryOverrides);

  const txs = sortTransactions(input.transactions).filter(
    (t) => t.instrumentId && isB3Category(cat(t.instrumentId)) && (!opts.until || t.date <= opts.until),
  );

  const byDay = new Map<string, Transaction[]>();
  for (const t of txs) {
    const k = `${t.date}|${t.instrumentId}`;
    const list = byDay.get(k) ?? [];
    list.push(t);
    byDay.set(k, list);
  }

  for (const [key, dayTxs] of byDay) {
    const [date, id] = key.split('|') as [string, string];
    const inst = instruments.get(id);
    const symbol = displaySymbol(id, inst);
    const category = cat(id);
    const p: Pos = pos.get(id) ?? { qty: 0, cost: 0, shortQty: 0, shortNet: 0, shortGross: 0, shortIrrf: 0, shortIrrfKnown: false, fracQty: 0, fracCost: 0 };
    pos.set(id, p);

    // 1) corporate actions and transfers in
    for (const t of dayTxs) {
      switch (t.type) {
        case 'SPLIT': {
          const ratio = t.ratio ?? 1;
          p.qty *= ratio;
          p.shortQty *= ratio;
          const frac = p.qty - Math.floor(p.qty + 1e-9);
          if (frac > 1e-6) {
            const fracCost = (p.cost * frac) / p.qty;
            p.qty -= frac;
            p.cost -= fracCost;
            p.fracQty += frac;
            p.fracCost += fracCost;
            issues.push({
              level: 'warning',
              code: 'FRACAO_GRUPAMENTO',
              transactionId: t.id,
              instrumentId: id,
              message:
                `O ${ratio < 1 ? 'grupamento' : 'desdobramento'} de ${symbol} deixou fração de ${frac.toFixed(4)} ação(ões) ` +
                `(custo R$ ${fracCost.toFixed(2)}), separada da posição. A fração é vendida em leilão pela empresa: registre a venda ` +
                `(SELL de ${frac.toFixed(4)}) com o valor recebido — é uma alienação tributável.`,
            });
          }
          break;
        }
        case 'STOCK_DIVIDEND': {
          // Bonificação: cost of new shares = capitalized value per share informed by the company
          // (Lei 9.249/1995 art. 10 par. único; IN RFB 1.585/2015 art. 58 §2º). Missing => 0.
          const newQty = t.quantity ?? p.qty * (t.ratio ?? 0);
          if (t.price === undefined) {
            issues.push({
              level: 'warning',
              code: 'BONIFICACAO_SEM_CUSTO',
              transactionId: t.id,
              instrumentId: id,
              message: `Bonificação de ${symbol} sem valor unitário atribuído: custo considerado zero (informe o valor do fato relevante).`,
            });
          }
          p.qty += newQty;
          p.cost += newQty * (t.price ?? 0);
          break;
        }
        case 'TRANSFER_IN': {
          const qty = t.quantity ?? 0;
          const basis = transferBasisOf(t, opts.transferBasis);
          const original = basis ? basisTotalCost(basis, qty) : undefined;
          if (original === undefined) {
            issues.push({
              level: 'warning',
              code: 'TRANSFER_COST_UNKNOWN',
              transactionId: t.id,
              instrumentId: id,
              message:
                `Transferência de custódia de ${symbol} sem custo original: usado o valor informado na transferência. ` +
                'Informe o custo de aquisição original (transferBasis ou nota "[custo: AAAA-MM-DD @ preço]").',
            });
          }
          p.qty += qty;
          p.cost += original ?? grossAmount(t) + (t.fees ?? 0);
          break;
        }
        case 'RETURN_OF_CAPITAL': {
          const amt = grossAmount(t);
          if (amt > p.cost) {
            issues.push({
              level: 'warning',
              code: 'ROC_EXCEEDS_COST',
              transactionId: t.id,
              instrumentId: id,
              message: `Restituição de capital de ${symbol} maior que o custo; excesso pode ser tributável.`,
            });
          }
          p.cost = Math.max(0, p.cost - amt);
          break;
        }
      }
    }

    // 2) trades, grouped by broker for day-trade matching
    const byAccount = new Map<string, { buy: Side; sell: Side }>();
    for (const t of dayTxs) {
      if (t.type !== 'BUY' && t.type !== 'SELL') continue;
      const acc = t.account ?? '';
      const g = byAccount.get(acc) ?? { buy: emptySide(), sell: emptySide() };
      byAccount.set(acc, g);
      const side = t.type === 'BUY' ? g.buy : g.sell;
      const gross = grossAmount(t);
      const fees = t.fees ?? 0;
      side.qty += t.quantity ?? 0;
      side.gross += gross;
      side.value += t.type === 'BUY' ? gross + fees : gross - fees;
      if (t.type === 'SELL' && t.taxes !== undefined) {
        side.irrf += t.taxes;
        side.irrfKnown = true;
      }
      side.ids.push(t.id);
    }

    const restBuy = emptySide();
    const restSell = emptySide();
    const addRest = (target: Side, src: Side, f: number) => {
      target.qty += src.qty * f;
      target.gross += src.gross * f;
      target.value += src.value * f;
      target.irrf += src.irrf * f;
      target.irrfKnown ||= src.irrfKnown;
      target.ids.push(...src.ids);
    };
    for (const { buy, sell } of byAccount.values()) {
      const dt = Math.min(buy.qty, sell.qty);
      if (dt > 1e-12) {
        const fb = dt / buy.qty;
        const fs = dt / sell.qty;
        const netProceeds = sell.value * fs;
        const cost = buy.value * fb;
        trades.push({
          date,
          month: monthOf(date),
          instrumentId: id,
          symbol,
          category,
          kind: 'daytrade',
          quantity: dt,
          grossSales: sell.gross * fs,
          netProceeds,
          cost,
          result: netProceeds - cost,
          irrfReported: sell.irrfKnown ? sell.irrf * fs : undefined,
          transactionIds: [...new Set([...buy.ids, ...sell.ids])],
        });
      }
      if (buy.qty - dt > 1e-12) addRest(restBuy, buy, (buy.qty - dt) / buy.qty);
      if (sell.qty - dt > 1e-12) addRest(restSell, sell, (sell.qty - dt) / sell.qty);
    }

    // 2a) buys: first cover an open short, the rest goes long
    if (restBuy.qty > 0) {
      let buyQty = restBuy.qty;
      let buyValue = restBuy.value;
      if (p.shortQty > 1e-12) {
        const cover = Math.min(buyQty, p.shortQty);
        const f = cover / p.shortQty;
        const proceeds = p.shortNet * f;
        const gross = p.shortGross * f;
        const cost = (buyValue * cover) / buyQty;
        trades.push({
          date,
          month: monthOf(date),
          instrumentId: id,
          symbol,
          category,
          kind: 'swing',
          quantity: cover,
          grossSales: gross,
          netProceeds: proceeds,
          cost,
          result: proceeds - cost,
          irrfReported: p.shortIrrfKnown ? p.shortIrrf * f : undefined,
          shortCover: true,
          shortSaleDate: p.shortSince,
          transactionIds: restBuy.ids,
        });
        p.shortQty -= cover;
        p.shortNet -= proceeds;
        p.shortGross -= gross;
        p.shortIrrf -= p.shortIrrf * f;
        if (p.shortQty < 1e-9) Object.assign(p, { shortQty: 0, shortNet: 0, shortGross: 0, shortIrrf: 0, shortIrrfKnown: false, shortSince: undefined });
        buyValue -= cost;
        buyQty -= cover;
      }
      if (buyQty > 1e-12) {
        p.qty += buyQty;
        p.cost += buyValue;
      }
    }

    // 2b0) sale of a pending fraction (leilão de frações)
    if (restSell.qty > 0 && p.fracQty > 1e-9 && restSell.qty <= p.fracQty + 1e-9) {
      const q = restSell.qty;
      const cost = (p.fracCost * Math.min(q, p.fracQty)) / p.fracQty;
      p.fracCost -= cost;
      p.fracQty = Math.max(0, p.fracQty - q);
      trades.push({
        date,
        month: monthOf(date),
        instrumentId: id,
        symbol,
        category,
        kind: 'swing',
        quantity: q,
        grossSales: restSell.gross,
        netProceeds: restSell.value,
        cost,
        result: restSell.value - cost,
        irrfReported: restSell.irrfKnown ? restSell.irrf : undefined,
        transactionIds: restSell.ids,
      });
      restSell.qty = 0;
    }

    // 2b) sells: close the long position at preço médio; the excess opens a short
    if (restSell.qty > 0) {
      const closeQty = Math.min(restSell.qty, p.qty);
      const excess = restSell.qty - closeQty;
      if (closeQty > 1e-12) {
        const f = closeQty / restSell.qty;
        const costOut = (p.cost * closeQty) / p.qty;
        p.qty -= closeQty;
        p.cost -= costOut;
        if (p.qty < 1e-9) {
          p.qty = 0;
          p.cost = 0;
        }
        trades.push({
          date,
          month: monthOf(date),
          instrumentId: id,
          symbol,
          category,
          kind: 'swing',
          quantity: closeQty,
          grossSales: restSell.gross * f,
          netProceeds: restSell.value * f,
          cost: costOut,
          result: restSell.value * f - costOut,
          irrfReported: restSell.irrfKnown ? restSell.irrf * f : undefined,
          transactionIds: restSell.ids,
        });
      }
      if (excess > 1e-9) {
        const f = excess / restSell.qty;
        p.shortQty += excess;
        p.shortNet += restSell.value * f;
        p.shortGross += restSell.gross * f;
        p.shortIrrf += restSell.irrf * f;
        p.shortIrrfKnown ||= restSell.irrfKnown;
        p.shortSince ??= date;
        issues.push({
          level: 'warning',
          code: 'SHORT_SALE',
          instrumentId: id,
          transactionId: restSell.ids[0],
          message:
            `Venda de ${excess} ${symbol} em ${date} sem posição comprada: tratada como venda a descoberto; o resultado ` +
            'é apurado na recompra. Se faltar histórico de compras, registre a compra/transferência com o custo original.',
        });
      }
    }

    // 3) transfers out (no taxable event; reduce at average cost)
    for (const t of dayTxs) {
      if (t.type !== 'TRANSFER_OUT') continue;
      const q = Math.min(t.quantity ?? 0, p.qty);
      const c = p.qty > 0 ? (p.cost * q) / p.qty : 0;
      p.qty -= q;
      p.cost -= c;
    }
  }

  const positions: BrPosition[] = [];
  const openShorts: BrShortPosition[] = [];
  for (const [id, p] of pos) {
    const inst = instruments.get(id);
    if (p.qty > 1e-9) {
      positions.push({
        instrumentId: id,
        symbol: displaySymbol(id, inst),
        category: cat(id),
        quantity: p.qty,
        totalCost: p.cost,
        averageCost: p.cost / p.qty,
      });
    }
    if (p.shortQty > 1e-9) {
      openShorts.push({
        instrumentId: id,
        symbol: displaySymbol(id, inst),
        category: cat(id),
        quantity: p.shortQty,
        proceeds: p.shortNet,
        since: p.shortSince ?? '',
      });
      issues.push({
        level: 'error',
        code: 'SHORT_OR_MISSING_HISTORY',
        instrumentId: id,
        message:
          `Posição vendida em aberto: ${p.shortQty} ${displaySymbol(id, inst)} desde ${p.shortSince}. Nenhum ganho foi apurado ` +
          '(nem DARF gerado) para essa venda. Se não é venda a descoberto, falta registrar a compra ou a transferência com o custo.',
      });
    }
  }
  positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { trades, positions, openShorts, issues };
}
