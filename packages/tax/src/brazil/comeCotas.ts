import type { ISODate } from '@pm/core';
import { lastBrazilBusinessDayOfMonth } from '../common/dates';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, ParamMeta, TaxInput, TaxIssue } from '../common/types';
import { grossAmount, instrumentMap, sortTransactions, sum } from '../common/util';
import { classifyForBrazil, type BrCategory } from './classify';

export const COME_COTAS_META: ParamMeta = {
  status: 'verified',
  source: 'Lei 11.033/2004 art. 3º e Lei 14.754/2023: come-cotas semestral (último dia útil de maio e novembro), 15% longo prazo / 20% curto prazo; fundos de ações isentos de come-cotas',
  checkedOn: '2026-10-06',
};

export interface ComeCotasRow {
  date: ISODate;
  instrumentId: string;
  name: string;
  quotas: number;
  price: number;
  value: number;
  base: number;
  yield: number;
  rate: number;
  tax: number;
  quotasConsumed: number;
}

export interface ComeCotasReport {
  country: 'BR';
  year: number;
  disclaimer: LocalizedText;
  rows: ComeCotasRow[];
  totalTax: number;
  notes: string[];
  issues: TaxIssue[];
}

export interface ComeCotasOptions {
  year: number;
  categoryOverrides?: Record<string, BrCategory>;
  /** 'longo' (15%, default) or 'curto' (20%) prazo per fund id. */
  fundTerms?: Record<string, 'longo' | 'curto'>;
}

const EQUITY_FUND = /a[cç][oõ]es|\bFIA\b/i;

/**
 * Estimate of the come-cotas of open-ended domestic funds (withheld by the administrator by
 * reducing the number of quotas): on the last business day of May and November, the yield since the
 * last event is taxed at 15% (long term) or 20% (short term). Needs quota prices (market.price).
 */
export function brazilComeCotasReport(input: TaxInput, opts: ComeCotasOptions): ComeCotasReport {
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
  const rows: ComeCotasRow[] = [];
  const isFund = (id?: string) => !!id && classifyForBrazil(instruments.get(id), opts.categoryOverrides) === 'FUNDO';
  const txs = sortTransactions(input.transactions).filter((t) => isFund(t.instrumentId) && t.date <= `${opts.year}-12-31`);
  const ids = [...new Set(txs.map((t) => t.instrumentId!))];
  for (const id of ids) {
    const inst = instruments.get(id)!;
    if (EQUITY_FUND.test(inst.name)) continue;
    const rate = (opts.fundTerms?.[id] ?? 'longo') === 'longo' ? 0.15 : 0.2;
    const fundTxs = txs.filter((t) => t.instrumentId === id);
    const first = fundTxs[0]!.date;
    const events: ISODate[] = [];
    for (let y = Number(first.slice(0, 4)); y <= opts.year; y++) {
      for (const m of ['05', '11']) {
        const d = lastBrazilBusinessDayOfMonth(`${y}-${m}`);
        if (d > first && d <= `${opts.year}-12-31`) events.push(d);
      }
    }
    let quotas = 0;
    let base = 0;
    let i = 0;
    const apply = (until: ISODate) => {
      while (i < fundTxs.length && fundTxs[i]!.date <= until) {
        const t = fundTxs[i++]!;
        if (t.type === 'BUY' || t.type === 'TRANSFER_IN') {
          quotas += t.quantity ?? 0;
          base += grossAmount(t) + (t.fees ?? 0);
        } else if (t.type === 'SELL' || t.type === 'TRANSFER_OUT') {
          const q = Math.min(t.quantity ?? 0, quotas);
          base -= quotas > 0 ? (base * q) / quotas : 0;
          quotas -= q;
        }
      }
    };
    for (const d of events) {
      apply(d);
      if (quotas <= 1e-9) continue;
      const price = input.market.price(id, d);
      if (price === undefined) {
        issues.push({ level: 'warning', code: 'FUND_PRICE_MISSING', instrumentId: id, message: `Sem cota de ${inst.name} em ${d}: come-cotas não estimado.` });
        continue;
      }
      const value = quotas * price;
      const y = value - base;
      const tax = y > 0 ? y * rate : 0;
      const consumed = tax / price;
      if (d.startsWith(`${opts.year}-`)) {
        rows.push({ date: d, instrumentId: id, name: inst.name, quotas, price, value, base, yield: y, rate, tax, quotasConsumed: consumed });
      }
      quotas -= consumed;
      base = y > 0 ? value - tax : base;
    }
  }
  return {
    country: 'BR',
    year: opts.year,
    disclaimer: TAX_DISCLAIMER,
    rows,
    totalTax: sum(rows.map((r) => r.tax)),
    notes: [
      'Come-cotas: antecipação semestral do IR (maio e novembro) retida pelo administrador com redução da quantidade de cotas; no resgate é cobrada a diferença até a alíquota da tabela regressiva.',
      'Fundos de ações não têm come-cotas. Valores estimados com as cotas informadas (market.price).',
    ],
    issues,
  };
}
