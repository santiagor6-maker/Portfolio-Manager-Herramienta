import type { ISODate } from '@pm/core';
import { daysBetween } from '../common/dates';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, ParamMeta, TaxInput, TaxIssue } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap, sortTransactions, sum } from '../common/util';
import { classifyForBrazil, type BrCategory } from './classify';

/** IR regressive table on fixed income (Lei 11.033/2004 art. 1º). */
export const RENDA_FIXA_IR_TABLE: { upToDays: number; rate: number }[] = [
  { upToDays: 180, rate: 0.225 },
  { upToDays: 360, rate: 0.2 },
  { upToDays: 720, rate: 0.175 },
  { upToDays: Infinity, rate: 0.15 },
];

/** IOF regressive table on yields for redemptions before 30 days (Decreto 6.306/2007, anexo). Index = days held (1..29). */
export const IOF_TABLE = [
  0, 0.96, 0.93, 0.9, 0.86, 0.83, 0.8, 0.76, 0.73, 0.7, 0.66, 0.63, 0.6, 0.56, 0.53, 0.5, 0.46, 0.43, 0.4, 0.36, 0.33, 0.3, 0.26, 0.23,
  0.2, 0.16, 0.13, 0.1, 0.06, 0.03,
];

export const RENDA_FIXA_META: ParamMeta = {
  status: 'verified',
  source: 'Lei 11.033/2004 art. 1º (22,5/20/17,5/15%); Decreto 6.306/2007 (IOF regressivo < 30 dias); Lei 11.033 art. 3º (LCI/LCA/CRI/CRA isentos PF)',
  checkedOn: '2026-10-05',
};

export function rendaFixaIrRate(days: number): number {
  return RENDA_FIXA_IR_TABLE.find((r) => days <= r.upToDays)!.rate;
}

export function iofRate(days: number): number {
  return days >= 30 ? 0 : (IOF_TABLE[Math.max(1, days)] ?? 0);
}

const EXEMPT_RE = /\b(LCI|LCA|CRI|CRA|LIG|LCD|incentivad[ao]s?|poupan[cç]a)\b/i;

export interface RendaFixaRow {
  transactionId: string;
  date: ISODate;
  instrumentId: string;
  name: string;
  type: 'resgate' | 'cupom';
  exempt: boolean;
  quantity?: number;
  openDate: ISODate;
  holdingDays: number;
  gross: number;
  cost: number;
  /** Yield (gain) of the redemption, or the coupon. */
  rendimento: number;
  iof: number;
  irRate: number;
  expectedIrrf: number;
  irrfReported: number;
}

export interface RendaFixaPosition {
  instrumentId: string;
  name: string;
  exempt: boolean;
  quantity: number;
  cost: number;
}

export interface RendaFixaReport {
  country: 'BR';
  year: number;
  disclaimer: LocalizedText;
  rows: RendaFixaRow[];
  totals: { rendimentosTributaveis: number; irrfTributaveis: number; rendimentosIsentos: number; iof: number };
  positions: RendaFixaPosition[];
  positionsPrevYear: RendaFixaPosition[];
  notes: string[];
  issues: TaxIssue[];
}

export interface RendaFixaOptions {
  year: number;
  categoryOverrides?: Record<string, BrCategory>;
  /** Instrument ids that are exempt for individuals (LCI/LCA/CRI/CRA/debêntures incentivadas). */
  exemptIds?: string[];
}

interface Lot {
  openDate: ISODate;
  qty: number;
  cost: number;
}

/**
 * Domestic fixed income (CDB, Tesouro Direto, debêntures, LCI/LCA...): IR is withheld at source by
 * the bank/custodian on redemption and coupons (regressive table), so there is no DARF; this report
 * checks the withholding, separates exempt income and gives positions at cost for Bens e Direitos.
 */
export function brazilRendaFixaReport(input: TaxInput, opts: RendaFixaOptions): RendaFixaReport {
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
  const isRf = (id?: string) => !!id && classifyForBrazil(instruments.get(id), opts.categoryOverrides) === 'RENDA_FIXA';
  const exempt = (id: string) => {
    const inst = instruments.get(id);
    return (opts.exemptIds ?? []).includes(id) || EXEMPT_RE.test(`${inst?.symbol ?? ''} ${inst?.name ?? ''}`);
  };
  const lots = new Map<string, Lot[]>();
  const rows: RendaFixaRow[] = [];
  const snap = () =>
    [...lots.entries()]
      .map(([id, list]) => ({
        instrumentId: id,
        name: instruments.get(id)?.name ?? displaySymbol(id, instruments.get(id)),
        exempt: exempt(id),
        quantity: sum(list.map((l) => l.qty)),
        cost: sum(list.map((l) => l.cost)),
      }))
      .filter((p) => p.quantity > 1e-9);
  let prevSnap: RendaFixaPosition[] = [];
  let tookPrev = false;
  const txs = sortTransactions(input.transactions).filter((t) => isRf(t.instrumentId) && t.date <= `${opts.year}-12-31`);
  for (const tx of txs) {
    if (!tookPrev && tx.date > `${opts.year - 1}-12-31`) {
      prevSnap = snap();
      tookPrev = true;
    }
    const id = tx.instrumentId!;
    const list = lots.get(id) ?? [];
    lots.set(id, list);
    const inYear = tx.date.startsWith(`${opts.year}-`);
    const name = instruments.get(id)?.name ?? id;
    if (tx.type === 'BUY' || tx.type === 'TRANSFER_IN') {
      list.push({ openDate: tx.date, qty: tx.quantity ?? 1, cost: grossAmount(tx) + (tx.fees ?? 0) });
    } else if (tx.type === 'SELL') {
      const qTotal = tx.quantity ?? sum(list.map((l) => l.qty));
      const proceeds = grossAmount(tx) - (tx.fees ?? 0);
      let remaining = qTotal;
      const reportedTotal = tx.taxes ?? 0;
      while (remaining > 1e-12 && list[0]) {
        const lot = list[0];
        const take = Math.min(lot.qty, remaining);
        const cost = (lot.cost * take) / lot.qty;
        const gross = (proceeds * take) / qTotal;
        lot.cost -= cost;
        lot.qty -= take;
        if (lot.qty <= 1e-12) list.shift();
        remaining -= take;
        if (!inYear) continue;
        const days = daysBetween(lot.openDate, tx.date);
        const rend = gross - cost;
        const ex = exempt(id);
        const iof = rend > 0 ? rend * iofRate(days) : 0;
        const rate = rendaFixaIrRate(days);
        rows.push({
          transactionId: tx.id,
          date: tx.date,
          instrumentId: id,
          name,
          type: 'resgate',
          exempt: ex,
          quantity: take,
          openDate: lot.openDate,
          holdingDays: days,
          gross,
          cost,
          rendimento: rend,
          iof,
          irRate: ex ? 0 : rate,
          expectedIrrf: ex || rend <= 0 ? 0 : (rend - iof) * rate,
          irrfReported: (reportedTotal * take) / qTotal,
        });
      }
      if (remaining > 1e-9) {
        issues.push({
          level: 'error',
          code: 'OVERSELL',
          transactionId: tx.id,
          instrumentId: id,
          message: `Resgate de ${name} acima da posição registrada; o excedente não foi apurado.`,
        });
      }
    } else if (tx.type === 'INTEREST' && inYear) {
      const first = list[0];
      const days = first ? daysBetween(first.openDate, tx.date) : 0;
      const gross = grossAmount(tx);
      const ex = exempt(id);
      const rate = rendaFixaIrRate(days);
      rows.push({
        transactionId: tx.id,
        date: tx.date,
        instrumentId: id,
        name,
        type: 'cupom',
        exempt: ex,
        openDate: first?.openDate ?? tx.date,
        holdingDays: days,
        gross,
        cost: 0,
        rendimento: gross,
        iof: 0,
        irRate: ex ? 0 : rate,
        expectedIrrf: ex ? 0 : gross * rate,
        irrfReported: tx.taxes ?? 0,
      });
    }
  }
  if (!tookPrev) prevSnap = snap();
  for (const r of rows) {
    if (Math.abs(r.irrfReported - r.expectedIrrf) > Math.max(0.05, r.expectedIrrf * 0.02)) {
      issues.push({
        level: 'info',
        code: 'RF_IRRF_DIFFERS',
        transactionId: r.transactionId,
        instrumentId: r.instrumentId,
        message:
          `IR retido em ${r.name} (${r.irrfReported.toFixed(2)}) difere do estimado (${r.expectedIrrf.toFixed(2)}, ${(r.irRate * 100).toFixed(1)}% ` +
          `após ${r.holdingDays} dias). Confira o informe de rendimentos (o custo pode incluir taxas/ágio).`,
      });
    }
  }
  const trib = rows.filter((r) => !r.exempt);
  return {
    country: 'BR',
    year: opts.year,
    disclaimer: TAX_DISCLAIMER,
    rows,
    totals: {
      rendimentosTributaveis: sum(trib.map((r) => Math.max(0, r.rendimento - r.iof))),
      irrfTributaveis: sum(trib.map((r) => r.irrfReported)),
      rendimentosIsentos: sum(rows.filter((r) => r.exempt).map((r) => Math.max(0, r.rendimento))),
      iof: sum(rows.map((r) => r.iof)),
    },
    positions: snap(),
    positionsPrevYear: prevSnap,
    notes: [
      'Renda fixa: IR retido na fonte pela instituição (tabela regressiva 22,5% até 180 dias, 20% até 360, 17,5% até 720, 15% acima) — sem DARF. Declarar em Tributação Exclusiva (linha 06).',
      'LCI, LCA, CRI, CRA e debêntures incentivadas: isentos para pessoa física (Rendimentos Isentos, linha 12 ou "outros").',
      'IOF regressivo sobre o rendimento em resgates com menos de 30 dias.',
      'Fundos de investimento abertos (come-cotas em maio/novembro) não são calculados aqui.',
    ],
    issues,
  };
}
