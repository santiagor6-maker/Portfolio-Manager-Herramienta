/**
 * Goal / contribution projection (C21). Deterministic contributions, return scenarios from an
 * expected annual return and volatility: the annualized return over t years is modeled as
 * Normal(mu, sigma / sqrt(t)), so the pessimistic / optimistic curves (10th / 90th percentile by
 * default) narrow in annualized terms as the horizon grows. Contributions are made at the end of
 * each month. Probability of success = P(annualized return >= rate needed to reach the target).
 */
import type { GoalProjectionPoint, ISODate } from './types';
import { addMonths } from './dates';

export interface GoalProjectionOptions {
  startValue: number;
  startDate: ISODate;
  monthlyContribution: number;
  /** Expected annual return (decimal). */
  expectedReturn: number;
  /** Annual volatility (decimal), default 0.15. */
  volatility?: number;
  /** Horizon in years (default 10, or until targetDate). */
  years?: number;
  target?: number;
  targetDate?: ISODate;
  /** z-score of the scenario band (default 1.2816 = 10th/90th percentile). */
  z?: number;
}

export interface GoalProjectionResult {
  points: GoalProjectionPoint[];
  /** Expected value at the target date (or horizon). */
  expectedFinalValue: number;
  /** Months until the expected scenario reaches the target (undefined if not within 100 years). */
  monthsToTarget?: number;
  /** Monthly contribution needed to reach the target at targetDate in the expected scenario. */
  requiredMonthlyContribution?: number;
  /** Probability of reaching the target at targetDate (0..1). */
  probabilityOfSuccess?: number;
}

function fv(start: number, contrib: number, annual: number, months: number): number {
  const i = Math.pow(1 + annual, 1 / 12) - 1;
  if (Math.abs(i) < 1e-12) return start + contrib * months;
  const g = Math.pow(1 + i, months);
  return start * g + (contrib * (g - 1)) / i;
}

function normCdf(x: number): number {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

function monthsBetween(a: ISODate, b: ISODate): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
}

export function goalProjection(o: GoalProjectionOptions): GoalProjectionResult {
  const sigma = o.volatility ?? 0.15;
  const z = o.z ?? 1.2816;
  const months = o.targetDate ? Math.max(0, monthsBetween(o.startDate, o.targetDate)) : Math.round((o.years ?? 10) * 12);
  const points: GoalProjectionPoint[] = [];
  for (let m = 0; m <= months; m++) {
    const t = m / 12;
    const band = t > 0 ? (z * sigma) / Math.sqrt(t) : 0;
    points.push({
      date: addMonths(o.startDate, m),
      contributed: o.startValue + o.monthlyContribution * m,
      pessimistic: fv(o.startValue, o.monthlyContribution, Math.max(-0.99, o.expectedReturn - band), m),
      expected: fv(o.startValue, o.monthlyContribution, o.expectedReturn, m),
      optimistic: fv(o.startValue, o.monthlyContribution, o.expectedReturn + band, m),
    });
  }
  const res: GoalProjectionResult = { points, expectedFinalValue: points[points.length - 1]!.expected };
  if (o.target !== undefined) {
    for (let m = 0; m <= 1200; m++) {
      if (fv(o.startValue, o.monthlyContribution, o.expectedReturn, m) >= o.target) {
        res.monthsToTarget = m;
        break;
      }
    }
    if (months > 0) {
      const i = Math.pow(1 + o.expectedReturn, 1 / 12) - 1;
      const g = Math.pow(1 + i, months);
      const annuity = Math.abs(i) < 1e-12 ? months : (g - 1) / i;
      res.requiredMonthlyContribution = Math.max(0, (o.target - o.startValue * g) / annuity);
      // Annualized return needed, then P(R >= needed) with R ~ N(mu, sigma / sqrt(T)).
      let lo = -0.99;
      let hi = 10;
      if (fv(o.startValue, o.monthlyContribution, lo, months) >= o.target) res.probabilityOfSuccess = 1;
      else if (fv(o.startValue, o.monthlyContribution, hi, months) < o.target) res.probabilityOfSuccess = 0;
      else {
        for (let k = 0; k < 200; k++) {
          const mid = (lo + hi) / 2;
          if (fv(o.startValue, o.monthlyContribution, mid, months) >= o.target) hi = mid;
          else lo = mid;
        }
        const T = months / 12;
        res.probabilityOfSuccess = sigma > 0 ? 1 - normCdf((hi - o.expectedReturn) / (sigma / Math.sqrt(T))) : hi <= o.expectedReturn ? 1 : 0;
      }
    }
  }
  return res;
}
