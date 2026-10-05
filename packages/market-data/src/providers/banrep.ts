/**
 * Colombia: TRM (Tasa Representativa del Mercado) certified by the Superintendencia Financiera,
 * published as open data on datos.gov.co (Socrata dataset `32sa-8pi3`).
 *
 * Record shape: `{ valor: "4409.15", unidad: "COP", vigenciadesde: "2024-12-31T00:00:00.000",
 * vigenciahasta: "2025-01-02T00:00:00.000" }`. A TRM is valid for every calendar day in
 * [vigenciadesde, vigenciahasta]: the rate certified on Friday applies Saturday, Sunday and a
 * Monday holiday. We expand records to one point per calendar day, which is exactly the
 * legally applicable rate for any date (e.g. 31-Dec for the patrimonio declaration).
 */
import type { FxPoint, ISODate, ProviderId } from '@pm/core';
import { addDays, eachDay } from '../dates';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { round } from '../series';
import type { FxProvider } from './types';

export interface TrmRecord {
  valor: string;
  unidad?: string;
  vigenciadesde: string;
  vigenciahasta: string;
}

export interface BanrepTrmOptions {
  http: HttpClient;
  baseUrl?: string;
  /** Optional Socrata app token (raises rate limits). */
  appToken?: string;
}

export class BanrepTrmProvider implements FxProvider {
  readonly id: ProviderId = 'banrep-trm';
  readonly official = true;
  private readonly base: string;

  constructor(private readonly opts: BanrepTrmOptions) {
    this.base = opts.baseUrl ?? 'https://www.datos.gov.co/resource/32sa-8pi3.json';
  }

  supports(base: string, quote: string): boolean {
    return (base === 'USD' && quote === 'COP') || (base === 'COP' && quote === 'USD');
  }

  async records(from: ISODate, to: ISODate): Promise<TrmRecord[]> {
    const qs = new URLSearchParams({
      $select: 'valor,vigenciadesde,vigenciahasta',
      $where: `vigenciahasta >= '${from}T00:00:00' AND vigenciadesde <= '${to}T00:00:00'`,
      $order: 'vigenciadesde ASC',
      $limit: '50000',
    });
    const headers: Record<string, string> = this.opts.appToken ? { 'X-App-Token': this.opts.appToken } : {};
    return this.opts.http.getJson<TrmRecord[]>(`${this.base}?${qs.toString()}`, headers);
  }

  async daily(base: string, quote: string, from: ISODate, to: ISODate): Promise<FxPoint[]> {
    if (!this.supports(base, quote)) throw new MarketDataError('UNSUPPORTED', `TRM only covers USD/COP (${base}/${quote})`);
    const usdCop = expandTrm(await this.records(from, to), from, to);
    if (!usdCop.length) throw new MarketDataError('NOT_FOUND', `No TRM published for ${from}..${to}`);
    return base === 'USD' ? usdCop : usdCop.map((p) => ({ date: p.date, rate: 1 / p.rate }));
  }
}

/** Expand TRM validity ranges into one point per calendar day within [from, to]. */
export function expandTrm(records: readonly TrmRecord[], from: ISODate, to: ISODate): FxPoint[] {
  const byDate = new Map<ISODate, number>();
  for (const r of records) {
    const rate = Number(r.valor);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const start = r.vigenciadesde.slice(0, 10);
    // Defensive: a missing/invalid end means a single day.
    let end = (r.vigenciahasta ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) end = start;
    const a = start < from ? from : start;
    const b = end > to ? to : end;
    if (a > b) continue;
    for (const d of eachDay(a, b)) byDate.set(d, round(rate, 2));
  }
  const out = [...byDate.entries()].map(([date, rate]) => ({ date, rate })).sort((x, y) => (x.date < y.date ? -1 : 1));
  // Fill rare gaps in the published data (carry the previous TRM forward).
  const filled: FxPoint[] = [];
  for (const p of out) {
    const prev = filled[filled.length - 1];
    if (prev) for (let d = addDays(prev.date, 1); d < p.date; d = addDays(d, 1)) filled.push({ date: d, rate: prev.rate });
    filled.push(p);
  }
  return filled;
}
