/**
 * Tesouro Direto prices and rates (Tesouro Transparente open data, CSV, ';' separated, decimal ','):
 *   https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv
 *   Header: Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha
 * The whole history is one file (~15 MB): parsed once and kept in memory for 12 h (not persisted).
 * Valuation price = "PU Venda Manhã" (what the investor receives on early redemption); falls back
 * to "PU Base". Not reachable from the build container: tested with a fixture in that format.
 */
import type { Instrument, ISODate, PricePoint, ProviderId } from '@pm/core';
import { HOUR, type TieredCache } from '../cache';
import { addDays, fromDMY, todayISO } from '../dates';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { normalizeText } from '../text';
import { mapHttpError, simpleHistory } from './common';
import type { PriceProvider, PriceTarget, ProviderHistory } from './types';

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

  constructor(private readonly opts: { http: HttpClient; cache?: TieredCache; url?: string; now?: () => Date }) {}

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
    return simpleHistory(t, this.id, 'BRL', title.points, from, to, 'as-traded', {
      name: title.instrument.name,
      notes: ['PU de venda (resgate antecipado), Tesouro Transparente'],
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
