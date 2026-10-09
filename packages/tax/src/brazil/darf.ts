import type { ISODate, Transaction, YearMonth } from '@pm/core';
import { daysBetween, lastBrazilBusinessDayOfMonth, lastDayOfMonth, monthOf, monthRange, nextMonth } from '../common/dates';
import { round2, sum } from '../common/util';
import type { ParamMeta, TaxIssue } from '../common/types';

export type DarfStatus = 'paga' | 'paga_em_atraso' | 'pendente' | 'vencida';

/** Data to fill the DARF in Sicalc Web (Receita Federal), which issues the payable guide with barcode. */
export interface SicalcData {
  codigoReceita: string;
  /** Período de apuração: last day of the month, DD/MM/AAAA. */
  periodoApuracao: string;
  /** Vencimento, DD/MM/AAAA. */
  vencimento: string;
  valorPrincipal: number;
  /** Payment date used for the computation, DD/MM/AAAA. */
  dataPagamento?: string;
  multa?: number;
  juros?: number;
  valorTotal?: number;
  /** Left blank: the taxpayer's CPF. */
  cpf: string;
  instrucoes: string;
}

export interface DarfLateCharges {
  daysLate: number;
  /** Multa de mora: 0,33% per day, capped at 20% (Lei 9.430/1996 art. 61). */
  multa: number;
  multaRate: number;
  /** Juros de mora: Selic accumulated from the month after the due date to the month before payment + 1% (art. 61 §3º). */
  juros?: number;
  jurosRate?: number;
  /** Months with no Selic rate supplied (juros not computed). */
  missingSelicMonths: YearMonth[];
  total?: number;
}

const br = (d: ISODate) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Late-payment charges of a federal tax (DARF) paid after its due date.
 * `selicMonthly`: Selic rate of each month as a decimal (e.g. 0.0105 for 1.05%), BCB series 4390.
 */
/**
 * Monthly Selic (decimal) used by the Receita Federal for late-payment interest (BCB series 4390).
 * 2026-01 from secondary sources (1.16%); 2026-02..09 derived from the RFB juros table for Oct/2026.
 * Callers can pass newer months in `selicMonthly`; those override this table.
 */
export const SELIC_MONTHLY: Record<YearMonth, number> = {
  '2024-01': 0.0097, '2024-02': 0.008, '2024-03': 0.0083, '2024-04': 0.0089, '2024-05': 0.0083, '2024-06': 0.0079,
  '2024-07': 0.0091, '2024-08': 0.0087, '2024-09': 0.0084, '2024-10': 0.0093, '2024-11': 0.0079, '2024-12': 0.0093,
  '2025-01': 0.0101, '2025-02': 0.0099, '2025-03': 0.0096, '2025-04': 0.0106, '2025-05': 0.0114, '2025-06': 0.011,
  '2025-07': 0.0128, '2025-08': 0.0116, '2025-09': 0.0122, '2025-10': 0.0128, '2025-11': 0.0105, '2025-12': 0.0122,
  '2026-01': 0.0116, '2026-02': 0.01, '2026-03': 0.0121, '2026-04': 0.0109, '2026-05': 0.0107, '2026-06': 0.0112, '2026-07': 0.0122,
  '2026-08': 0.0109, '2026-09': 0.0108,
};

export const SELIC_META: ParamMeta = {
  status: 'needs-verification',
  source: 'Tabela "Taxa de Juros Selic" da Receita Federal (acumulada mensal), conferida em fontes secundárias em 2026-10-06',
  checkedOn: '2026-10-06',
  note: 'Conferir no Sicalc. Atualizar mensalmente (BCB SGS 4390).',
};

export function darfLateCharges(
  principal: number,
  dueDate: ISODate,
  paymentDate: ISODate,
  selicOverride: Record<YearMonth, number> = {},
): DarfLateCharges {
  const selicMonthly = { ...SELIC_MONTHLY, ...selicOverride };
  const daysLate = Math.max(0, daysBetween(dueDate, paymentDate));
  if (daysLate === 0) return { daysLate: 0, multa: 0, multaRate: 0, juros: 0, jurosRate: 0, missingSelicMonths: [], total: principal };
  const multaRate = Math.min(0.2, 0.0033 * daysLate);
  const multa = round2(principal * multaRate);
  const dueMonth = monthOf(dueDate);
  const payMonth = monthOf(paymentDate);
  let jurosRate = 0;
  const missing: YearMonth[] = [];
  if (payMonth > dueMonth) {
    const first = nextMonth(dueMonth);
    if (first < payMonth) {
      const months = monthRange(first, prevMonth(payMonth));
      for (const m of months) {
        const r = selicMonthly[m];
        if (r === undefined) missing.push(m);
        else jurosRate += r;
      }
    }
    jurosRate += 0.01;
  }
  const juros = missing.length ? undefined : round2(principal * jurosRate);
  return {
    daysLate,
    multa,
    multaRate,
    juros,
    jurosRate: missing.length ? undefined : jurosRate,
    missingSelicMonths: missing,
    total: juros === undefined ? undefined : round2(principal + multa + juros),
  };
}

function prevMonth(ym: YearMonth): YearMonth {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function sicalcData(
  code: string,
  periodoApuracao: ISODate,
  dueDate: ISODate,
  principal: number,
  late?: { paymentDate: ISODate; charges: DarfLateCharges },
): SicalcData {
  return {
    codigoReceita: code,
    periodoApuracao: br(periodoApuracao),
    vencimento: br(dueDate),
    valorPrincipal: principal,
    dataPagamento: late ? br(late.paymentDate) : undefined,
    multa: late?.charges.multa,
    juros: late?.charges.juros,
    valorTotal: late?.charges.total,
    cpf: '',
    instrucoes:
      'Sicalc Web (Receita Federal) → "Preenchimento de DARF" → Pessoa Física → informe o CPF, o código de receita ' +
      `${code}, o período de apuração e o valor principal; o Sicalc calcula multa e juros na data de pagamento e emite ` +
      'o DARF com código de barras. Também é possível emitir pelo app/portal da Receita ou pelo e-CAC.',
  };
}

export interface DarfPayment {
  date: ISODate;
  amount: number;
  transactionId?: string;
  /** Período de apuração (YYYY-MM) the payment refers to, when known. */
  month?: YearMonth;
  /** Código de receita of the DARF paid (6015 B3, 4600 GCAP/crypto, 0211 IRPF quota...). */
  code?: string;
}

const DARF_NOTE = /\b(6015|4600|0211|0190|darf)\b/i;
const CODE_IN_NOTE = /\b(6015|4600|0211|0190)\b/;
const MONTH_IN_NOTE = /\b(20\d{2})-(\d{2})\b|\b(\d{2})\/(20\d{2})\b/;

/** DARF payments recorded as TAX transactions in BRL (note mentioning DARF/6015, optionally the month). */
export function darfPaymentsFromTransactions(txs: Transaction[]): DarfPayment[] {
  return txs
    .filter((t) => t.type === 'TAX' && t.currency === 'BRL' && DARF_NOTE.test(`${t.note ?? ''} ${t.source ?? ''}`))
    .map((t) => {
      const m = MONTH_IN_NOTE.exec(t.note ?? '');
      const month = m ? (m[1] ? `${m[1]}-${m[2]}` : `${m[4]}-${m[3]}`) : undefined;
      const code = CODE_IN_NOTE.exec(`${t.note ?? ''} ${t.source ?? ''}`)?.[1];
      return { date: t.date, amount: t.amount ?? 0, transactionId: t.id, month, code };
    });
}

/**
 * Match payments to DARFs: the receita code must match when the payment has one (T26); then by
 * month when given, else the first payment after the period with enough amount.
 */
export function matchDarfPayments<T extends { month: YearMonth; amount: number; periodoApuracao: ISODate; code: string }>(
  darfs: T[],
  payments: DarfPayment[],
): Map<T, DarfPayment> {
  const out = new Map<T, DarfPayment>();
  const used = new Set<DarfPayment>();
  const codeOk = (p: DarfPayment, d: T) => !p.code || p.code === d.code;
  for (const d of darfs) {
    const p = payments.find((x) => !used.has(x) && codeOk(x, d) && x.month === d.month);
    if (p) {
      out.set(d, p);
      used.add(p);
    }
  }
  for (const d of darfs) {
    if (out.has(d)) continue;
    const p = payments
      .filter((x) => !used.has(x) && codeOk(x, d) && !x.month && x.date > d.periodoApuracao && x.amount >= d.amount - 0.05)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (p) {
      out.set(d, p);
      used.add(p);
    }
  }
  return out;
}

export const sumAmounts = (xs: { amount: number }[]) => sum(xs.map((x) => x.amount));

/**
 * A monthly DARF of an individual (6015 B3, 4600 GCAP/crypto, 0190 carnê-leão): same shape and
 * same machinery for every code (T61).
 */
export interface DarfGuide {
  /** Month of apuração (período de apuração). */
  month: YearMonth;
  periodoApuracao: ISODate;
  code: string;
  amount: number;
  dueDate: ISODate;
  /** Months whose sub-R$10 tax was rolled into this DARF. */
  includesMonths: YearMonth[];
  status: DarfStatus;
  payment?: DarfPayment;
  /** Late charges for the recorded payment, or for paying on `asOf` when overdue and unpaid. */
  late?: DarfLateCharges;
  sicalc: SicalcData;
}

/** Minimum DARF value: below it the tax is not paid but added to the next month (Lei 9.430/1996 art. 68). */
export const DARF_MINIMUM = 10;

/** A DARF for `month` (due the last bank business day of the following month). */
export function newDarf(code: string, month: YearMonth, amount: number, includesMonths: YearMonth[] = [month]): DarfGuide {
  const periodoApuracao = lastDayOfMonth(month);
  const dueDate = lastBrazilBusinessDayOfMonth(nextMonth(month));
  const a = round2(amount);
  return { month, periodoApuracao, code, amount: a, dueDate, includesMonths, status: 'pendente', sicalc: sicalcData(code, periodoApuracao, dueDate, a) };
}

/**
 * Applies the R$ 10 minimum to monthly amounts of one receita code: amounts below the minimum are
 * accumulated (not paid) until the running total reaches it; the DARF is then issued in that month
 * with `includesMonths` listing every month it covers.
 */
export function accumulateDarfs(
  code: string,
  items: { month: YearMonth; amount: number }[],
  minimum = DARF_MINIMUM,
): { darfs: DarfGuide[]; byMonth: Map<YearMonth, DarfGuide>; carried: Map<YearMonth, number>; pendingOut: number; pendingMonths: YearMonth[] } {
  const darfs: DarfGuide[] = [];
  const byMonth = new Map<YearMonth, DarfGuide>();
  const carried = new Map<YearMonth, number>();
  let pending = 0;
  let pendingMonths: YearMonth[] = [];
  for (const it of [...items].sort((a, b) => a.month.localeCompare(b.month))) {
    if (it.amount <= 0) continue;
    const total = pending + it.amount;
    if (round2(total) >= minimum) {
      const d = newDarf(code, it.month, total, [...pendingMonths, it.month]);
      darfs.push(d);
      byMonth.set(it.month, d);
      pending = 0;
      pendingMonths = [];
    } else {
      pending = total;
      pendingMonths.push(it.month);
      carried.set(it.month, round2(total));
    }
  }
  return { darfs, byMonth, carried, pendingOut: round2(pending), pendingMonths };
}

/**
 * Payment status and late charges of DARFs (T61: shared by 6015, 4600 and 0190): matches the
 * payments by code and month, marks paga / paga_em_atraso / vencida, computes multa and Selic,
 * refreshes the Sicalc data with the payment date and warns when the payment is short.
 */
export function settleDarfs(
  darfs: DarfGuide[],
  payments: DarfPayment[],
  opts: { asOf?: ISODate; selicMonthly?: Record<YearMonth, number>; label?: string } = {},
): TaxIssue[] {
  const issues: TaxIssue[] = [];
  const label = opts.label ? `${opts.label} ` : '';
  const matched = matchDarfPayments(darfs, payments);
  for (const d of darfs) {
    const p = matched.get(d);
    if (p) {
      d.payment = p;
      if (p.date > d.dueDate) {
        d.status = 'paga_em_atraso';
        d.late = darfLateCharges(d.amount, d.dueDate, p.date, opts.selicMonthly);
        d.sicalc = sicalcData(d.code, d.periodoApuracao, d.dueDate, d.amount, { paymentDate: p.date, charges: d.late });
      } else d.status = 'paga';
      const expected = d.late?.total ?? d.amount;
      if (p.amount + 0.05 < expected) {
        issues.push({
          level: 'warning',
          code: 'DARF_UNDERPAID',
          message: `DARF ${label}de ${d.month}: pago R$ ${p.amount.toFixed(2)} de R$ ${expected.toFixed(2)} devidos (com acréscimos, se houver).`,
        });
      }
    } else if (opts.asOf && opts.asOf > d.dueDate) {
      d.status = 'vencida';
      d.late = darfLateCharges(d.amount, d.dueDate, opts.asOf, opts.selicMonthly);
      d.sicalc = sicalcData(d.code, d.periodoApuracao, d.dueDate, d.amount, { paymentDate: opts.asOf, charges: d.late });
      if (d.late.missingSelicMonths.length) {
        issues.push({
          level: 'info',
          code: 'SELIC_MISSING',
          message: `DARF ${label}vencido de ${d.month}: informe a Selic mensal de ${d.late.missingSelicMonths.join(', ')} para calcular os juros (ou use o Sicalc).`,
        });
      }
    }
  }
  return issues;
}

/** Payments usable for one receita code: explicit code match only (an uncoded payment stays with 6015). */
export function paymentsForCode(code: string, explicit: DarfPayment[] = [], txs: Transaction[] = []): DarfPayment[] {
  return [...explicit, ...darfPaymentsFromTransactions(txs)].filter((p) => p.code === code);
}
