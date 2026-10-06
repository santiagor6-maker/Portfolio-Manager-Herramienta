/**
 * Risk metrics from the monthly TWR series.
 * - volatility: sample standard deviation of monthly returns * sqrt(12)
 * - Sharpe: (mean monthly excess return * 12) / volatility, rf converted geometrically to monthly
 * - Sortino: (mean monthly excess * 12) / (downside deviation vs rf * sqrt(12))
 * - max drawdown on the chained month-end index (start = peak month, end = trough month)
 * - beta / correlation vs an aligned benchmark monthly series
 * Partial months (row.partial, cut by asOf) are excluded unless `includePartial`.
 * With `dailySeries` (valueSeries output) the max drawdown uses the daily TWR index instead.
 */
import type { MonthlyRow, RiskMetrics, YearMonth } from './types';
import { addMonthsYm } from './dates';

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

/** Months where the portfolio held something (skip empty months before inception). */
function activeRows(monthly: MonthlyRow[], includePartial: boolean): MonthlyRow[] {
  return monthly.filter(
    (r) =>
      Number.isFinite(r.twr) &&
      (includePartial || !r.partial) &&
      (Math.abs(r.startValueBase) > 1e-9 || Math.abs(r.endValueBase) > 1e-9 || r.twr !== 0),
  );
}

export interface RiskOptions {
  riskFreeAnnual?: number;
  benchmarkMonthly?: number[];
  benchmarkId?: string;
  includePartial?: boolean;
  dailySeries?: { date: string; cumulativeTwr: number }[];
}

export function riskMetricsImpl(monthly: MonthlyRow[], opts: RiskOptions = {}): RiskMetrics {
  const rows = activeRows(monthly ?? [], opts.includePartial ?? false);
  const r = rows.map((x) => x.twr);
  const n = r.length;
  const rfm = Math.pow(1 + (opts.riskFreeAnnual ?? 0), 1 / 12) - 1;
  const sd = sampleStd(r);
  const volatility = sd * Math.sqrt(12);
  const excess = r.map((x) => x - rfm);
  const meanExcess = mean(excess);

  const out: RiskMetrics = {
    volatility,
    maxDrawdown: 0,
    positiveMonthsRatio: n ? r.filter((x) => x > 0).length / n : 0,
    monthsUsed: n,
  };
  if (n >= 2 && sd > 0) out.sharpe = (meanExcess * 12) / volatility;
  if (n >= 2) {
    const dd = Math.sqrt(excess.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / n) * Math.sqrt(12);
    if (dd > 0) out.sortino = (meanExcess * 12) / dd;
  }

  // Max drawdown on the month-end index.
  if (n) {
    let idx = 1;
    let peak = 1;
    let peakMonth: YearMonth = addMonthsYm(rows[0]!.month, -1);
    let worst = 0;
    for (const row of rows) {
      idx *= 1 + row.twr;
      if (idx > peak) {
        peak = idx;
        peakMonth = row.month;
      }
      const dd = idx / peak - 1;
      if (dd < worst) {
        worst = dd;
        out.maxDrawdownStart = peakMonth;
        out.maxDrawdownEnd = row.month;
      }
    }
    out.maxDrawdown = worst;
    if (opts.dailySeries && opts.dailySeries.length > 1) {
      let peakD = 1 + opts.dailySeries[0]!.cumulativeTwr;
      let peakDate = opts.dailySeries[0]!.date;
      let worstD = 0;
      for (const p of opts.dailySeries) {
        const v = 1 + p.cumulativeTwr;
        if (v > peakD) {
          peakD = v;
          peakDate = p.date;
        }
        const dd = peakD > 0 ? v / peakD - 1 : 0;
        if (dd < worstD) {
          worstD = dd;
          out.maxDrawdownStartDate = peakDate;
          out.maxDrawdownEndDate = p.date;
        }
      }
      out.maxDrawdown = worstD;
      if (out.maxDrawdownStartDate) out.maxDrawdownStart = out.maxDrawdownStartDate.slice(0, 7);
      if (out.maxDrawdownEndDate) out.maxDrawdownEnd = out.maxDrawdownEndDate.slice(0, 7);
    }
    let best = rows[0]!;
    let worstRow = rows[0]!;
    for (const row of rows) {
      if (row.twr > best.twr) best = row;
      if (row.twr < worstRow.twr) worstRow = row;
    }
    out.bestMonth = { month: best.month, twr: best.twr };
    out.worstMonth = { month: worstRow.month, twr: worstRow.twr };
  }

  // Benchmark: explicit series aligned with `monthly`, else the rows' benchmarkReturns.
  let pairs: [number, number][] = [];
  if (opts.benchmarkMonthly && opts.benchmarkMonthly.length) {
    const bm = opts.benchmarkMonthly;
    const m = Math.min(monthly.length, bm.length);
    for (let i = 0; i < m; i++) {
      const p = monthly[i]!;
      const b = bm[i]!;
      if (rows.includes(p) && Number.isFinite(b)) pairs.push([p.twr, b]);
    }
  } else {
    const id = opts.benchmarkId ?? rows.find((x) => x.benchmarkReturns && Object.keys(x.benchmarkReturns).length)?.benchmarkReturns;
    const key = typeof id === 'string' ? id : id ? Object.keys(id)[0] : undefined;
    if (key) pairs = rows.filter((x) => x.benchmarkReturns?.[key] !== undefined).map((x) => [x.twr, x.benchmarkReturns![key]!]);
  }
  if (pairs.length >= 2) {
    const ps = pairs.map((p) => p[0]);
    const bs = pairs.map((p) => p[1]);
    const mp = mean(ps);
    const mb = mean(bs);
    let cov = 0;
    let vb = 0;
    let vp = 0;
    for (const [p, b] of pairs) {
      cov += (p - mp) * (b - mb);
      vb += (b - mb) ** 2;
      vp += (p - mp) ** 2;
    }
    if (vb > 0) out.beta = cov / vb;
    if (vb > 0 && vp > 0) out.correlation = cov / Math.sqrt(vb * vp);
  }
  return out;
}
