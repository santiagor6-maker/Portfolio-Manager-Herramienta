import type { ISODate, Transaction, YearMonth } from '@pm/core';
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

export interface BrLedgerResult {
  trades: BrTrade[];
  positions: BrPosition[];
  issues: TaxIssue[];
}

export interface BrLedgerOptions {
  /** Process transactions up to and including this date. */
  until?: ISODate;
  categoryOverrides?: Record<string, BrCategory>;
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

/**
 * Brazilian B3 ledger with preço médio (weighted average cost incl. fees, IN RFB 1.585/2015 art. 58)
 * regardless of the portfolio display cost method, and day-trade detection: buys and sells of the
 * same asset on the same day at the same broker (account) are matched first as day trade.
 */
export function runBrazilB3Ledger(input: TaxInput, opts: BrLedgerOptions = {}): BrLedgerResult {
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
  const pos = new Map<string, { qty: number; cost: number }>();
  const trades: BrTrade[] = [];

  const cat = (id: string | undefined): BrCategory =>
    classifyForBrazil(id ? instruments.get(id) : undefined, opts.categoryOverrides);

  const txs = sortTransactions(input.transactions).filter(
    (t) => t.instrumentId && isB3Category(cat(t.instrumentId)) && (!opts.until || t.date <= opts.until),
  );

  // Group by date then instrument.
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
    const p = pos.get(id) ?? { qty: 0, cost: 0 };
    pos.set(id, p);

    // 1) corporate actions and transfers in
    for (const t of dayTxs) {
      switch (t.type) {
        case 'SPLIT':
          p.qty *= t.ratio ?? 1;
          break;
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
        case 'TRANSFER_IN':
          p.qty += t.quantity ?? 0;
          p.cost += grossAmount(t) + (t.fees ?? 0);
          break;
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
      const addRest = (target: Side, src: Side, f: number) => {
        target.qty += src.qty * f;
        target.gross += src.gross * f;
        target.value += src.value * f;
        target.irrf += src.irrf * f;
        target.irrfKnown ||= src.irrfKnown;
        target.ids.push(...src.ids);
      };
      if (buy.qty - dt > 1e-12) addRest(restBuy, buy, (buy.qty - dt) / buy.qty);
      if (sell.qty - dt > 1e-12) addRest(restSell, sell, (sell.qty - dt) / sell.qty);
    }

    if (restBuy.qty > 0) {
      p.qty += restBuy.qty;
      p.cost += restBuy.value;
    }
    if (restSell.qty > 0) {
      let costOut: number;
      if (restSell.qty > p.qty + 1e-9) {
        issues.push({
          level: 'error',
          code: 'OVERSELL',
          instrumentId: id,
          transactionId: restSell.ids[0],
          message: `Venda de ${restSell.qty} ${symbol} em ${date} acima da posição (${p.qty}); custo do excedente = 0.`,
        });
        costOut = p.cost;
        p.qty = 0;
        p.cost = 0;
      } else {
        costOut = p.qty > 0 ? (p.cost * restSell.qty) / p.qty : 0;
        p.qty -= restSell.qty;
        p.cost -= costOut;
        if (p.qty < 1e-9) {
          p.qty = 0;
          p.cost = 0;
        }
      }
      trades.push({
        date,
        month: monthOf(date),
        instrumentId: id,
        symbol,
        category,
        kind: 'swing',
        quantity: restSell.qty,
        grossSales: restSell.gross,
        netProceeds: restSell.value,
        cost: costOut,
        result: restSell.value - costOut,
        irrfReported: restSell.irrfKnown ? restSell.irrf : undefined,
        transactionIds: restSell.ids,
      });
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
  for (const [id, p] of pos) {
    if (p.qty <= 1e-9) continue;
    const inst = instruments.get(id);
    positions.push({
      instrumentId: id,
      symbol: displaySymbol(id, inst),
      category: cat(id),
      quantity: p.qty,
      totalCost: p.cost,
      averageCost: p.cost / p.qty,
    });
  }
  positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { trades, positions, issues };
}
