import type { CurrencyCode, ISODate, YearMonth } from '@pm/core';
import { lastBrazilBusinessDayOfMonth, lastDayOfMonth, monthOf, nextMonth } from '../common/dates';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, ParamMeta, TaxInput, TaxIssue } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap, round2, sortTransactions, sum } from '../common/util';
import { classifyForBrazil, cryptoCustodyOf, routeCryptoByCustody, type BrCategory, type CryptoCustody } from './classify';
import { sicalcData, type SicalcData } from './darf';

/** GCAP progressive rates on capital gains of individuals (Lei 13.259/2016 art. 21 da Lei 8.981). */
export const GCAP_BRACKETS: { upTo: number; rate: number }[] = [
  { upTo: 5_000_000, rate: 0.15 },
  { upTo: 10_000_000, rate: 0.175 },
  { upTo: 30_000_000, rate: 0.2 },
  { upTo: Infinity, rate: 0.225 },
];

export const CRYPTO_META: Record<string, ParamMeta> = {
  exemption: {
    status: 'needs-verification',
    source: 'IN RFB 1.888/2019; Perguntas e Respostas IRPF: alienações de criptoativos até R$ 35 mil/mês isentas (soma de todos os criptoativos)',
    note: 'Custódia no exterior (exchange estrangeira) segue a Lei 14.754/2023 desde 2024 — não calculada aqui.',
  },
  rates: { status: 'verified', source: 'Lei 8.981/1995 art. 21 (redação Lei 13.259/2016): 15% a 22,5%' },
  darfCode: { status: 'verified', source: 'Código 4600 — ganho de capital na alienação de bens e direitos (PF)' },
};

export function gcapTax(gain: number): number {
  let tax = 0;
  let prev = 0;
  for (const b of GCAP_BRACKETS) {
    if (gain <= prev) break;
    tax += (Math.min(gain, b.upTo) - prev) * b.rate;
    prev = b.upTo;
  }
  return tax;
}

export interface CryptoSale {
  transactionId: string;
  date: ISODate;
  instrumentId: string;
  symbol: string;
  quantity: number;
  grossBrl: number;
  costBrl: number;
  gainBrl: number;
}

export interface CryptoMonth {
  month: YearMonth;
  salesBrl: number;
  exempt: boolean;
  gainBrl: number;
  tax: number;
  darf?: { code: '4600'; amount: number; dueDate: ISODate; sicalc: SicalcData };
  /** Tax computed but DARF withheld because the custody of some sold asset is not confirmed (T22). */
  darfBlockedUnknownCustody?: boolean;
}

export interface CryptoPosition {
  instrumentId: string;
  symbol: string;
  quantity: number;
  costBrl: number;
}

export interface CryptoReport {
  country: 'BR';
  year: number;
  disclaimer: LocalizedText;
  sales: CryptoSale[];
  months: CryptoMonth[];
  positions: CryptoPosition[];
  positionsPrevYear: CryptoPosition[];
  notes: string[];
  issues: TaxIssue[];
}

export interface CryptoOptions {
  year: number;
  categoryOverrides?: Record<string, BrCategory>;
  /**
   * Custody per instrument id. Default: inferred from the exchange (Brazilian exchange → 'brasil';
   * Binance/Coinbase/... or non-BRL currency → 'exterior', handled by `brazilForeignAnnualReport`
   * under Lei 14.754; anything else → 'desconhecida', tax shown but no DARF until confirmed).
   */
  cryptoCustody?: Record<string, CryptoCustody>;
  /** Custody per account/broker name (`Transaction.account`), e.g. { 'Binance': 'brasil' }. */
  accountCustody?: Record<string, CryptoCustody>;
  /** @deprecated use cryptoCustody. 'exterior' forces every crypto-asset abroad. */
  custody?: 'brasil' | 'exterior';
  exemptionLimit?: number;
}

/**
 * Crypto-assets of a Brazilian resident custodied in Brazil: average cost in BRL, monthly R$ 35k
 * sales exemption, GCAP progressive rates on net gains of each sale, DARF 4600 due on the last
 * bank business day of the following month. Losses are not offset (GCAP has no compensation).
 */
export function brazilCryptoReport(rawInput: TaxInput, opts: CryptoOptions): CryptoReport {
  const forced: Record<string, CryptoCustody> = { ...(opts.cryptoCustody ?? {}) };
  if (opts.custody) for (const i of rawInput.instruments) if (i.assetClass === 'crypto') forced[i.id] ??= opts.custody;
  const routed = routeCryptoByCustody(rawInput, { cryptoCustody: forced, accountCustody: opts.accountCustody });
  const input = routed.input;
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
  const limit = opts.exemptionLimit ?? 35_000;
  const custodyMap = routed.custody;
  issues.push(...routed.issues);
  const isCrypto = (id?: string) => !!id && classifyForBrazil(instruments.get(id), opts.categoryOverrides, custodyMap) === 'CRYPTO';
  const custodyOf = (id: string): CryptoCustody => {
    const inst = instruments.get(id);
    return inst ? cryptoCustodyOf(inst, custodyMap) : 'desconhecida';
  };
  const abroad = input.instruments.filter((i) => i.assetClass === 'crypto' && cryptoCustodyOf(i, custodyMap) === 'exterior');
  if (abroad.length && input.transactions.some((t) => abroad.some((a) => a.id === t.instrumentId))) {
    issues.push({
      level: 'info',
      code: 'CRYPTO_ABROAD',
      message:
        `Criptoativos custodiados no exterior (${abroad.map((a) => a.symbol).join(', ')}): tributação anual de 15% pela Lei 14.754/2023 ` +
        '(sem isenção de R$ 35 mil e sem DARF mensal) — ver brazilForeignAnnualReport.',
    });
  }
  const toBrl = (ccy: CurrencyCode, date: ISODate) => {
    if (ccy === 'BRL') return 1;
    const r = input.market.fx(ccy, 'BRL', date);
    if (!r) issues.push({ level: 'error', code: 'MISSING_FX', message: `Sem cotação ${ccy}/BRL em ${date}.` });
    return r ?? 0;
  };
  const pos = new Map<string, { qty: number; cost: number }>();
  const sales: CryptoSale[] = [];
  const snap = (): CryptoPosition[] =>
    [...pos.entries()]
      .filter(([, p]) => p.qty > 1e-12)
      .map(([id, p]) => ({ instrumentId: id, symbol: displaySymbol(id, instruments.get(id)), quantity: p.qty, costBrl: p.cost }));
  let prev: CryptoPosition[] | undefined;
  for (const tx of sortTransactions(input.transactions).filter((t) => isCrypto(t.instrumentId) && t.date <= `${opts.year}-12-31`)) {
    if (!prev && tx.date > `${opts.year - 1}-12-31`) prev = snap();
    const id = tx.instrumentId!;
    const p = pos.get(id) ?? { qty: 0, cost: 0 };
    pos.set(id, p);
    const rate = toBrl(tx.currency, tx.date);
    if (tx.type === 'BUY' || tx.type === 'TRANSFER_IN' || tx.type === 'STOCK_DIVIDEND') {
      p.qty += tx.quantity ?? 0;
      p.cost += (grossAmount(tx) + (tx.fees ?? 0)) * rate;
    } else if (tx.type === 'SELL' || tx.type === 'TRANSFER_OUT') {
      const q = Math.min(tx.quantity ?? 0, p.qty);
      if ((tx.quantity ?? 0) > p.qty + 1e-12) {
        issues.push({ level: 'error', code: 'OVERSELL', transactionId: tx.id, instrumentId: id, message: `Venda de ${displaySymbol(id, instruments.get(id))} acima do saldo; excedente não apurado.` });
      }
      const cost = p.qty > 0 ? (p.cost * q) / p.qty : 0;
      p.qty -= q;
      p.cost -= cost;
      if (tx.type === 'SELL' && tx.date.startsWith(`${opts.year}-`) && q > 0) {
        const share = q / (tx.quantity ?? q);
        const grossBrl = grossAmount(tx) * share * rate;
        const net = (grossAmount(tx) - (tx.fees ?? 0)) * share * rate;
        sales.push({ transactionId: tx.id, date: tx.date, instrumentId: id, symbol: displaySymbol(id, instruments.get(id)), quantity: q, grossBrl, costBrl: cost, gainBrl: net - cost });
      }
    }
  }
  prev ??= snap();
  const months: CryptoMonth[] = [];
  const byMonth = new Map<YearMonth, CryptoSale[]>();
  for (const sl of sales) byMonth.set(monthOf(sl.date), [...(byMonth.get(monthOf(sl.date)) ?? []), sl]);
  const unknownWarned = new Set<string>();
  for (const [month, list] of [...byMonth.entries()].sort()) {
    const salesBrl = sum(list.map((x) => x.grossBrl));
    const exempt = salesBrl <= limit;
    const gain = sum(list.map((x) => Math.max(0, x.gainBrl)));
    const tax = exempt ? 0 : round2(sum(list.map((x) => gcapTax(Math.max(0, x.gainBrl)))));
    const due = lastBrazilBusinessDayOfMonth(nextMonth(month));
    const unknown = list.filter((x) => custodyOf(x.instrumentId) !== 'brasil');
    for (const u of unknown) {
      if (unknownWarned.has(u.instrumentId)) continue;
      unknownWarned.add(u.instrumentId);
      issues.push({
        level: 'warning',
        code: 'CRYPTO_CUSTODY_UNKNOWN',
        instrumentId: u.instrumentId,
        message:
          `Custódia de ${u.symbol} não confirmada: se estiver em exchange brasileira, o regime é o GCAP mensal (DARF 4600); ` +
          'se estiver no exterior ou em carteira própria fora do país, Lei 14.754 anual. Informe cryptoCustody para gerar o DARF.',
      });
    }
    const blocked = tax > 0 && unknown.length > 0;
    months.push({
      month,
      salesBrl,
      exempt,
      gainBrl: gain,
      tax,
      darf: tax > 0 && !blocked ? { code: '4600', amount: tax, dueDate: due, sicalc: sicalcData('4600', lastDayOfMonth(month), due, tax) } : undefined,
      darfBlockedUnknownCustody: blocked || undefined,
    });
  }
  return {
    country: 'BR',
    year: opts.year,
    disclaimer: TAX_DISCLAIMER,
    sales,
    months,
    positions: snap(),
    positionsPrevYear: prev,
    notes: [
      'Isenção: total de alienações de criptoativos no mês até R$ 35 mil. Acima, ganho de cada venda tributado de 15% a 22,5% (GCAP), DARF 4600.',
      'Permutas entre criptoativos também são alienações (registre-as como venda e compra).',
      'Prejuízos em criptoativos não são compensáveis no GCAP.',
      'Bens e Direitos: grupo 08 (01 Bitcoin, 02 altcoins, 03 stablecoins), a custo de aquisição.',
    ],
    issues,
  };
}
