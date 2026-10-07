import type { ISODate, Transaction, YearMonth } from '@pm/core';
import { b3Root, basisTotalCost, resolveTransferBasis, snapRatio, type TransferBasisMap } from '../common/basis';
import { daysInMonth, monthOf, thirdFriday } from '../common/dates';
import type { TaxInput, TaxIssue } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap, sortTransactions } from '../common/util';
import { classifyForBrazil, FUTURES_POINT_VALUE, FUTURES_QUOTE_CURRENCY, isB3Category, type BrCategory } from './classify';

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
  /**
   * Opening of a short sale: no result yet (recognized at the buy-back), but its gross value counts
   * toward the month's sales (R$ 20k limit) and the IRRF base in the month it is sold (T23).
   */
  shortOpen?: boolean;
  /** Option expired without exercise: closed at zero on the expiry date (T24). */
  expired?: boolean;
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
  /** Apply free-text cost hints found in notes; default false (proposal only). */
  acceptNoteProposals?: boolean;
  /** Option expiry dates by instrument id (override the date derived from the B3 series letter). */
  optionExpiries?: Record<string, ISODate>;
  /** Expiries after this date are not applied (default: `until`, else the latest transaction date). */
  asOf?: ISODate;
}

const CALL_LETTERS = 'ABCDEFGHIJKL';
const PUT_LETTERS = 'MNOPQRSTUVWX';

/** B3 option type from the series letter (5th character). */
export function b3OptionType(symbol: string): 'call' | 'put' | undefined {
  const c = symbol.toUpperCase()[4] ?? '';
  return CALL_LETTERS.includes(c) ? 'call' : PUT_LETTERS.includes(c) ? 'put' : undefined;
}

/**
 * Expiry of a B3 stock option: the series letter gives the month (A-L calls, M-X puts = Jan-Dec);
 * the year is the first such month on/after `from`; the day is the third Friday (B3 rule since 2021).
 */
export function b3OptionExpiry(symbol: string, from: ISODate): ISODate | undefined {
  const sym = symbol.toUpperCase();
  const c = sym[4] ?? '';
  const idx = CALL_LETTERS.indexOf(c) >= 0 ? CALL_LETTERS.indexOf(c) : PUT_LETTERS.indexOf(c);
  if (idx < 0) return undefined;
  const month = idx + 1;
  // Weekly options (T40): suffix Wn = Friday of the n-th week of the series month.
  const weekly = /W([1-5])$/.exec(sym);
  const dayOf = (y: number) => (weekly ? nthFriday(y, month, Number(weekly[1])) : thirdFriday(y, month));
  let year = Number(from.slice(0, 4));
  let d = dayOf(year);
  while (d < from) d = dayOf(++year);
  return d;
}

/** n-th Friday of a month (clamped to the last Friday when the month has fewer). */
function nthFriday(year: number, month: number, n: number): ISODate {
  const third = thirdFriday(year, month);
  const firstDay = Number(third.slice(8, 10)) - 14;
  let day = firstDay + (n - 1) * 7;
  if (day > daysInMonth(year, month)) day -= 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const EXERCISE_NOTE = /exerc|assign|atribu/i;

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

  const futuresValue = (t: Transaction, root: string): number => {
    let v = t.amount ?? (t.quantity ?? 0) * (t.price ?? 0) * (FUTURES_POINT_VALUE[root] ?? 1);
    const ccy = FUTURES_QUOTE_CURRENCY[root] ?? (t.currency !== 'BRL' ? t.currency : undefined);
    if (ccy && ccy !== 'BRL') {
      const fx = input.market.fx(ccy, 'BRL', t.date);
      if (fx === undefined) {
        issues.push({ level: 'error', code: 'MISSING_FX', transactionId: t.id, message: `Sem cotação ${ccy}/BRL em ${t.date} para o futuro ${root}.` });
      } else v *= fx;
    }
    return v;
  };

  const byDay = new Map<string, Transaction[]>();
  for (const t of txs) {
    const k = `${t.date}|${t.instrumentId}`;
    const list = byDay.get(k) ?? [];
    list.push(t);
    byDay.set(k, list);
  }

  // Option expiries (T24): add an expiry "day" for every option instrument.
  const horizon = opts.until ?? opts.asOf ?? input.transactions.reduce((m, t) => (t.date > m ? t.date : m), '');
  // Expiry per series AND year (T39): every transaction on an option schedules the next expiry of
  // its series after that date, so a ticker reused the following year expires again.
  const expiriesOf = new Map<string, Set<ISODate>>();
  for (const t of txs) {
    const id = t.instrumentId!;
    if (cat(id) !== 'OPCAO') continue;
    const set = expiriesOf.get(id) ?? new Set<ISODate>();
    expiriesOf.set(id, set);
    const e = opts.optionExpiries?.[id] ?? b3OptionExpiry(instruments.get(id)?.symbol ?? '', t.date);
    if (!e) continue;
    set.add(e);
    if (e <= horizon && !byDay.has(`${e}|${id}`)) byDay.set(`${e}|${id}`, []);
  }
  /** Next scheduled expiry of an option on/after a date. */
  const nextExpiry = (id: string, from: ISODate) => [...(expiriesOf.get(id) ?? [])].filter((d) => d >= from).sort()[0];
  // Process by date; options before other assets of the same day so exercise premiums reach the
  // underlying trade.
  const keys = [...byDay.keys()]
    .map((k, i) => ({ k, i, date: k.slice(0, 10), opt: cat(k.slice(11)) === 'OPCAO' ? 0 : 1 }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.opt - b.opt || a.i - b.i)
    .map((x) => x.k);
  /** Premium adjustments from option exercise, applied to same-day trades of the underlying (by B3 root). */
  const exerciseAdj = new Map<string, { buyAdj: number; sellAdj: number; used: boolean; optionId: string }>();

  for (const key of keys) {
    const dayTxs = byDay.get(key)!;
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
          const ratio = snapRatio(t.ratio ?? 1);
          p.qty *= ratio;
          p.shortQty *= ratio;
          // Rounded ratios (e.g. 0.3333 for 3:1) leave 99.99 shares: snap to the integer (T30).
          if (Math.abs(p.qty - Math.round(p.qty)) < 0.01) p.qty = Math.round(p.qty);
          if (Math.abs(p.shortQty - Math.round(p.shortQty)) < 0.01) p.shortQty = Math.round(p.shortQty);
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
          if (category === 'OPCAO' && EXERCISE_NOTE.test(t.note ?? '') && p.shortQty > 1e-12) {
            // Assignment of a written option: the premium received adjusts the underlying trade.
            const q = Math.min(t.quantity ?? p.shortQty, p.shortQty);
            const premium = (p.shortNet * q) / p.shortQty;
            p.shortNet -= premium;
            p.shortGross -= (p.shortGross * q) / p.shortQty;
            p.shortQty -= q;
            const type = b3OptionType(symbol);
            const k = `${date}|${symbol.slice(0, 4).toUpperCase()}`;
            const a = exerciseAdj.get(k) ?? { buyAdj: 0, sellAdj: 0, used: false, optionId: id };
            if (type === 'call') a.sellAdj += premium; // writer sells the underlying: premium raises the sale value
            else a.buyAdj -= premium; // put writer buys the underlying: premium lowers the cost
            exerciseAdj.set(k, a);
            break;
          }
          const qty = t.quantity ?? 0;
          const { basis, proposal } = resolveTransferBasis(t, opts.transferBasis, opts.acceptNoteProposals);
          const original = basis ? basisTotalCost(basis, qty) : undefined;
          if (proposal) {
            issues.push({
              level: 'warning',
              code: 'TRANSFER_BASIS_PROPOSED',
              transactionId: t.id,
              instrumentId: id,
              message:
                `A nota da transferência de ${symbol} sugere compra em ${proposal.openDate} a ${proposal.unitCost} por unidade; ` +
                'não aplicada automaticamente. Confirme (transferBasis, nota "[custo: AAAA-MM-DD @ preço]" ou acceptNoteProposals).',
            });
          }
          if (original === undefined && !proposal) {
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
      const gross = category === 'FUTURO' ? futuresValue(t, symbol.slice(0, 3)) : grossAmount(t);
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

    const adj = category !== 'OPCAO' ? exerciseAdj.get(`${date}|${b3Root(symbol)}`) : undefined;
    if (adj && !adj.used) {
      const groups = [...byAccount.values()];
      const gb = groups.find((g) => g.buy.qty > 0);
      const gs = groups.find((g) => g.sell.qty > 0);
      if ((adj.buyAdj !== 0 && gb) || (adj.sellAdj !== 0 && gs)) {
        if (gb) gb.buy.value += adj.buyAdj;
        if (gs) gs.sell.value += adj.sellAdj;
        adj.used = true;
      }
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
        const cost = (buyValue * cover) / buyQty;
        trades.push({
          date,
          month: monthOf(date),
          instrumentId: id,
          symbol,
          category,
          kind: 'swing',
          quantity: cover,
          // gross and IRRF were already counted in the month of the short sale (shortOpen)
          grossSales: 0,
          netProceeds: proceeds,
          cost,
          result: proceeds - cost,
          shortCover: true,
          shortSaleDate: p.shortSince,
          transactionIds: restBuy.ids,
        });
        p.shortQty -= cover;
        p.shortNet -= proceeds;
        p.shortGross -= p.shortGross * f;
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
        trades.push({
          date,
          month: monthOf(date),
          instrumentId: id,
          symbol,
          category,
          kind: 'swing',
          quantity: excess,
          grossSales: restSell.gross * f,
          netProceeds: 0,
          cost: 0,
          result: 0,
          irrfReported: restSell.irrfKnown ? restSell.irrf * f : undefined,
          shortOpen: true,
          transactionIds: restSell.ids,
        });
        issues.push({
          level: category === 'OPCAO' ? 'info' : 'warning',
          code: category === 'OPCAO' ? 'OPCAO_LANCADA' : 'SHORT_SALE',
          instrumentId: id,
          transactionId: restSell.ids[0],
          message:
            `Venda de ${excess} ${symbol} em ${date} sem posição comprada: tratada como venda a descoberto; o resultado ` +
            'é apurado na recompra. Se faltar histórico de compras, registre a compra/transferência com o custo original.',
        });
      }
    }

    // 3) transfers out (no taxable event; reduce at average cost) and option exercise
    for (const t of dayTxs) {
      if (t.type !== 'TRANSFER_OUT') continue;
      if (category === 'OPCAO' && EXERCISE_NOTE.test(t.note ?? '') && p.qty > 1e-12) {
        const q = Math.min(t.quantity ?? p.qty, p.qty);
        const premium = (p.cost * q) / p.qty;
        p.qty -= q;
        p.cost -= premium;
        const type = b3OptionType(symbol);
        const k = `${date}|${symbol.slice(0, 4).toUpperCase()}`;
        const a = exerciseAdj.get(k) ?? { buyAdj: 0, sellAdj: 0, used: false, optionId: id };
        if (type === 'call') a.buyAdj += premium; // call holder buys the underlying: premium adds to cost
        else a.sellAdj -= premium; // put holder sells the underlying: premium reduces the sale value
        exerciseAdj.set(k, a);
        continue;
      }
      const q = Math.min(t.quantity ?? 0, p.qty);
      const c = p.qty > 0 ? (p.cost * q) / p.qty : 0;
      p.qty -= q;
      p.cost -= c;
    }

    // 4) option expiry without exercise (T24): close at zero
    if (category === 'OPCAO' && expiriesOf.get(id)?.has(date)) {
      if (p.qty > 1e-12) {
        trades.push({
          date, month: monthOf(date), instrumentId: id, symbol, category, kind: 'swing',
          quantity: p.qty, grossSales: 0, netProceeds: 0, cost: p.cost, result: -p.cost, expired: true, transactionIds: [],
        });
        p.qty = 0;
        p.cost = 0;
      }
      if (p.shortQty > 1e-12) {
        trades.push({
          date, month: monthOf(date), instrumentId: id, symbol, category, kind: 'swing',
          quantity: p.shortQty, grossSales: 0, netProceeds: p.shortNet, cost: 0, result: p.shortNet,
          shortCover: true, shortSaleDate: p.shortSince, expired: true, transactionIds: [],
        });
        Object.assign(p, { shortQty: 0, shortNet: 0, shortGross: 0, shortIrrf: 0, shortIrrfKnown: false, shortSince: undefined });
      }
      issues.push({
        level: 'info',
        code: 'OPCAO_VENCIDA',
        instrumentId: id,
        message: `Opção ${symbol} vencida em ${date} sem exercício: posição encerrada a zero (prêmio reconhecido como ${'ganho do lançador / perda do titular'}).`,
      });
    }
  }
  for (const [k, a] of exerciseAdj) {
    if (!a.used) {
      issues.push({
        level: 'warning',
        code: 'EXERCICIO_SEM_ATIVO',
        instrumentId: a.optionId,
        message: `Exercício de opção em ${k.slice(0, 10)} sem negócio do ativo-objeto (${k.slice(11)}) no mesmo dia: registre a compra/venda do ativo para ajustar o prêmio ao custo/preço.`,
      });
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
    if (p.shortQty > 1e-9 && cat(id) === 'OPCAO' && (nextExpiry(id, p.shortSince ?? '') ?? '') > horizon) {
      openShorts.push({
        instrumentId: id,
        symbol: displaySymbol(id, inst),
        category: cat(id),
        quantity: p.shortQty,
        proceeds: p.shortNet,
        since: p.shortSince ?? '',
      });
      issues.push({
        level: 'info',
        code: 'OPCAO_LANCADA_EM_ABERTO',
        instrumentId: id,
        message: `Opção lançada ${displaySymbol(id, inst)} em aberto (${p.shortQty}); vence em ${nextExpiry(id, p.shortSince ?? '')}: o prêmio será apurado na recompra ou no vencimento.`,
      });
    } else if (p.shortQty > 1e-9) {
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
