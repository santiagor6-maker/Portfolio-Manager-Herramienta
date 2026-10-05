import type { ISODate, Transaction, YearMonth } from '@pm/core';
import { daysBetween, monthOf, monthRange, nextMonth } from '../common/dates';
import { round2, sum } from '../common/util';

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
export function darfLateCharges(
  principal: number,
  dueDate: ISODate,
  paymentDate: ISODate,
  selicMonthly: Record<YearMonth, number> = {},
): DarfLateCharges {
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
}

const DARF_NOTE = /\b(6015|4600|darf)\b/i;
const MONTH_IN_NOTE = /\b(20\d{2})-(\d{2})\b|\b(\d{2})\/(20\d{2})\b/;

/** DARF payments recorded as TAX transactions in BRL (note mentioning DARF/6015, optionally the month). */
export function darfPaymentsFromTransactions(txs: Transaction[]): DarfPayment[] {
  return txs
    .filter((t) => t.type === 'TAX' && t.currency === 'BRL' && DARF_NOTE.test(`${t.note ?? ''} ${t.source ?? ''}`))
    .map((t) => {
      const m = MONTH_IN_NOTE.exec(t.note ?? '');
      const month = m ? (m[1] ? `${m[1]}-${m[2]}` : `${m[4]}-${m[3]}`) : undefined;
      return { date: t.date, amount: t.amount ?? 0, transactionId: t.id, month };
    });
}

/** Match payments to DARFs: by month when given, else first payment after the period with enough amount. */
export function matchDarfPayments<T extends { month: YearMonth; amount: number; periodoApuracao: ISODate }>(
  darfs: T[],
  payments: DarfPayment[],
): Map<T, DarfPayment> {
  const out = new Map<T, DarfPayment>();
  const used = new Set<DarfPayment>();
  for (const d of darfs) {
    const p = payments.find((x) => !used.has(x) && x.month === d.month);
    if (p) {
      out.set(d, p);
      used.add(p);
    }
  }
  for (const d of darfs) {
    if (out.has(d)) continue;
    const p = payments
      .filter((x) => !used.has(x) && !x.month && x.date > d.periodoApuracao && x.amount >= d.amount - 0.05)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (p) {
      out.set(d, p);
      used.add(p);
    }
  }
  return out;
}

export const sumAmounts = (xs: { amount: number }[]) => sum(xs.map((x) => x.amount));
