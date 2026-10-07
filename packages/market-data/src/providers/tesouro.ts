/**
 * Tesouro Direto prices and rates (Tesouro Transparente open data, CSV, ';' separated, decimal ','):
 *   https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv
 *   Header: Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha
 * The whole history is one file (~15 MB): parsed once and kept in memory for 12 h (not persisted).
 * Valuation price = "PU Venda Manhã" (what the investor receives on early redemption); falls back
 * to "PU Base". Not reachable from the build container: tested with a fixture in that format.
 */
import type { IndexPoint, Instrument, ISODate, PricePoint, ProviderId } from '@pm/core';
import { HOUR, type TieredCache } from '../cache';
import { addDays, fromDMY, todayISO } from '../dates';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { normalizeText } from '../text';
import { mapHttpError, simpleHistory } from './common';
import type { DividendEvent, PriceProvider, PriceTarget, ProviderHistory } from './types';

export const TESOURO_CSV_URL =
  'https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv';

const TYPE_CODES: [RegExp, string][] = [
  [/^Tesouro IPCA\+ com Juros Semestrais/i, 'NTNB'],
  [/^Tesouro IPCA\+/i, 'NTNBP'],
  [/^Tesouro Prefixado com Juros Semestrais/i, 'NTNF'],
  [/^Tesouro Prefixado/i, 'LTN'],
  [/^Tesouro Selic/i, 'LFT'],
  [/^Tesouro IGPM\+ com Juros Semestrais/i, 'NTNC'],
  [/^Tesouro Renda\+/i, 'RENDA'],
  [/^Tesouro Educa\+/i, 'EDUCA'],
];

export function tesouroCode(tipo: string): string {
  return TYPE_CODES.find(([re]) => re.test(tipo.trim()))?.[1] ?? normalizeText(tipo).toUpperCase().replace(/\s+/g, '-');
}

export interface TesouroTitle {
  instrument: Instrument;
  /** LTN, NTNF, LFT, NTNB, NTNBP, NTNC, RENDA, EDUCA. */
  code: string;
  maturity: ISODate;
  points: PricePoint[];
  /** Latest buy/sell rates (% a.a.) for display. */
  lastRates?: { date: ISODate; buy: number; sell: number };
}

const num = (s: string | undefined) => Number(String(s ?? '').replace(/\./g, '').replace(',', '.'));

export function parseTesouroCsv(text: string): Map<string, TesouroTitle> {
  const out = new Map<string, TesouroTitle>();
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').split(';').map((h) => normalizeText(h));
  const col = (name: string) => header.indexOf(normalizeText(name));
  const iTipo = col('Tipo Titulo');
  const iVenc = col('Data Vencimento');
  const iBase = col('Data Base');
  const iTc = col('Taxa Compra Manha');
  const iTv = col('Taxa Venda Manha');
  const iPuV = col('PU Venda Manha');
  const iPuB = col('PU Base Manha');
  if (iTipo < 0 || iVenc < 0 || iBase < 0 || (iPuV < 0 && iPuB < 0)) throw new MarketDataError('UPSTREAM_ERROR', 'Tesouro CSV: unexpected header');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const c = line.split(';');
    const tipo = c[iTipo]!.trim();
    const maturity = fromDMY(c[iVenc]!.trim());
    const date = fromDMY(c[iBase]!.trim());
    const price = num(c[iPuV]) || num(c[iPuB]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(price > 0)) continue;
    const code = tesouroCode(tipo);
    const id = `TD:${code}-${maturity}`;
    let t = out.get(id);
    if (!t) {
      t = {
        code,
        maturity,
        points: [],
        instrument: {
          id,
          symbol: `${code}-${maturity.slice(0, 4)}`,
          name: `${tipo} ${maturity.slice(0, 4)}`,
          exchange: 'TD',
          currency: 'BRL',
          country: 'BR',
          assetClass: 'fixed_income',
          sector: 'Government',
          providerSymbols: { tesouro: `${tipo}|${maturity}` },
          pricing: 'auto',
        },
      };
      out.set(id, t);
    }
    t.points.push({ date, close: price });
    if (!t.lastRates || date >= t.lastRates.date) t.lastRates = { date, buy: num(c[iTc]), sell: num(c[iTv]) };
  }
  for (const t of out.values()) t.points.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

export class TesouroProvider implements PriceProvider {
  readonly id: ProviderId = 'tesouro';

  constructor(
    private readonly opts: {
      http: HttpClient;
      cache?: TieredCache;
      url?: string;
      now?: () => Date;
      /** Monthly IPCA (% change, dated on day 1) for NTN-B coupons. */
      ipca?: (from: ISODate, to: ISODate) => Promise<IndexPoint[]>;
    },
  ) {}

  supports(t: PriceTarget): boolean {
    return t.exchange === 'TD';
  }

  async titles(): Promise<Map<string, TesouroTitle>> {
    const load = async () => {
      let text: string;
      try {
        text = await this.opts.http.getText(this.opts.url ?? TESOURO_CSV_URL, { Accept: 'text/csv' });
      } catch (e) {
        mapHttpError('tesouro', e);
      }
      return parseTesouroCsv(text);
    };
    if (!this.opts.cache) return load();
    return (await this.opts.cache.getOrLoad('tesouro:all', 12 * HOUR, load, { persist: false })).value;
  }

  async dailyHistory(t: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const title = (await this.titles()).get(t.instrumentId.toUpperCase().replace(/^TD:/, 'TD:'));
    if (!title) throw new MarketDataError('NOT_FOUND', `Tesouro Direto: unknown title ${t.instrumentId}`);
    const notes = ['PU de venda (resgate antecipado), Tesouro Transparente'];
    const dividends = await this.coupons(title, from, to, notes);
    return simpleHistory(t, this.id, 'BRL', title.points, from, to, 'as-traded', { name: title.instrument.name, notes, dividends });
  }

  /**
   * Semiannual coupons of the "com Juros Semestrais" titles (review R2, M26), so the PU drop on a
   * coupon date is not read as a loss. Amounts per title:
   *  - NTN-F (Prefixado com Juros Semestrais): R$1000 x (1.10^0.5 - 1) = R$48.80885.
   *  - NTN-B (IPCA+ com Juros Semestrais): VNA x (1.06^0.5 - 1); VNA = R$1000 on 2000-07-15
   *    updated monthly by the IPCA of the previous month (ANBIMA method; centavos may differ).
   *  - NTN-C (IGPM+): date only, amount to be confirmed (reviewRequired).
   */
  async coupons(title: TesouroTitle, from: ISODate, to: ISODate, notes: string[]): Promise<DividendEvent[]> {
    if (!['NTNB', 'NTNF', 'NTNC'].includes(title.code)) return [];
    const first = title.points[0]?.date ?? from;
    const dates = couponDates(title.maturity).filter((d) => d >= from && d <= to && d >= first);
    if (!dates.length) return [];
    if (title.code === 'NTNF') return dates.map((date) => ({ date, payDate: date, amount: NTNF_COUPON, kind: 'COUPON' as const }));
    if (title.code === 'NTNC') {
      return dates.map((date) => ({ date, payDate: date, amount: 0, kind: 'COUPON' as const, reviewRequired: true, note: 'cupom NTN-C (IGP-M): valor não calculado' }));
    }
    let ipca: IndexPoint[] = [];
    try {
      ipca = this.opts.ipca ? await this.opts.ipca('2000-07-01', dates[dates.length - 1]!) : [];
    } catch (e) {
      notes.push(`IPCA unavailable for NTN-B coupon amounts: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
    }
    return dates.map((date) => {
      const vna = ntnbVna(ipca, date);
      return vna
        ? { date, payDate: date, amount: round6(vna * NTNB_COUPON_FACTOR), kind: 'COUPON' as const, note: `VNA ${vna.toFixed(6)} (IPCA)` }
        : { date, payDate: date, amount: 0, kind: 'COUPON' as const, reviewRequired: true, note: 'cupom NTN-B: VNA indisponível (IPCA incompleto)' };
    });
  }

  /** Titles traded in the last 15 days (or all, with `includeMatured`), filtered by text. */
  async searchTitles(query: string, opts: { limit?: number; includeMatured?: boolean } = {}): Promise<Instrument[]> {
    const tokens = normalizeText(query)
      .replace(/\btesouro\b|\bdireto\b|\btd\b/g, ' ')
      .split(' ')
      .filter(Boolean);
    const since = addDays(todayISO(this.opts.now?.()), -15);
    const out: Instrument[] = [];
    for (const t of (await this.titles()).values()) {
      const last = t.points[t.points.length - 1]?.date ?? '';
      if (!opts.includeMatured && last < since) continue;
      const hay = normalizeText(`${t.instrument.name} ${t.instrument.symbol} ${t.maturity}`);
      if (tokens.every((tok) => hay.includes(tok))) out.push(t.instrument);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, opts.limit ?? 20);
  }
}

// ------------------------------------------------------------------------------------ coupons

export const NTNF_COUPON = 48.80885;
export const NTNB_COUPON_FACTOR = 0.02956301;

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function nextWeekday(d: ISODate): ISODate {
  let x = d;
  for (;;) {
    const wd = new Date(`${x}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return x;
    x = addDays(x, 1);
  }
}

/**
 * Coupon dates: the maturity day/month and the date six months apart, every year up to maturity,
 * moved to the next weekday (B3 holidays are not modelled). NTN-B 2035 (15/05): May and November;
 * NTN-B 2030 (15/08): February and August; NTN-F (01/01): January and July.
 */
export function couponDates(maturity: ISODate): ISODate[] {
  const day = maturity.slice(8, 10);
  const m = Number(maturity.slice(5, 7));
  const months = [m, ((m + 5) % 12) + 1].sort((a, b) => a - b);
  const out: ISODate[] = [];
  for (let y = 2000; y <= Number(maturity.slice(0, 4)); y++) {
    for (const mm of months) {
      const d = `${y}-${String(mm).padStart(2, '0')}-${day}`;
      if (d <= maturity) out.push(nextWeekday(d));
    }
  }
  return out;
}

/**
 * NTN-B VNA on a date: R$1000 on 2000-07-15, multiplied each 15th by (1 + IPCA of the previous
 * month). Uses the VNA of the last 15th on/before the date. Undefined if an IPCA month is missing.
 */
export function ntnbVna(ipca: readonly IndexPoint[], date: ISODate): number | undefined {
  const byMonth = new Map(ipca.map((p) => [p.date.slice(0, 7), p.value]));
  let vna = 1000;
  // Months whose IPCA is already incorporated on `date`: Jul-2000 .. (month of the last 15th) - 1.
  let last15 = `${date.slice(0, 7)}-15`;
  if (date < last15) {
    const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    last15 = `${d.toISOString().slice(0, 7)}-15`;
  }
  for (let y = 2000, mo = 7; `${y}-${String(mo).padStart(2, '0')}` < last15.slice(0, 7); ) {
    const v = byMonth.get(`${y}-${String(mo).padStart(2, '0')}`);
    if (v === undefined) return undefined;
    vna = Math.trunc(vna * (1 + v / 100) * 1e6) / 1e6;
    mo++;
    if (mo > 12) {
      mo = 1;
      y++;
    }
  }
  return vna;
}
