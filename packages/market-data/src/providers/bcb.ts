/**
 * Brazil: Banco Central do Brasil.
 *
 * PTAX (Olinda OData, https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/):
 *  - `CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)` with
 *    dates as 'MM-DD-YYYY'. One row per business day (the closing PTAX):
 *    `{ cotacaoCompra: 6.1910, cotacaoVenda: 6.1916, dataHoraCotacao: "2025-01-02 13:04:28.218" }`.
 *  - `CotacaoMoedaPeriodo(moeda=@moeda,...)` for EUR, GBP, CHF, JPY... Four bulletins per day
 *    (`tipoBoletim`: Abertura, Intermediário x2, Fechamento PTAX); we keep the closing one.
 *  We use `cotacaoVenda` (selling rate), the reference for contracts and Receita Federal.
 *
 * SGS (https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}/dados?formato=json&dataInicial=DD/MM/YYYY&dataFinal=DD/MM/YYYY):
 *  series 1 = USD PTAX venda, 21619 = EUR PTAX venda. `[{ "data": "02/01/2025", "valor": "6.1916" }]`.
 *  Since 2025 daily series accept at most 10 years per request; we chunk by 5 years.
 *
 * Not reachable from the build container; implemented against the documented formats and
 * tested with fixtures in test/fixtures/bcb.
 */
import type { FxPoint, ISODate, ProviderId } from '@pm/core';
import { addDays, fromDMY, toDMY, toMDY } from '../dates';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { dedupeByDate } from '../series';
import type { FxProvider } from './types';

/** Currencies with a PTAX (Banco Central publishes these against BRL). */
export const PTAX_CURRENCIES = ['USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'DKK', 'NOK', 'SEK'] as const;

/** SGS series codes for PTAX venda. */
export const SGS_SERIES: Readonly<Record<string, number>> = { USD: 1, EUR: 21619 };

interface PtaxRow {
  cotacaoCompra: number;
  cotacaoVenda: number;
  dataHoraCotacao: string;
  tipoBoletim?: string;
}

/** Split [from, to] into windows of at most `years` years. */
export function chunkRange(from: ISODate, to: ISODate, years: number): [ISODate, ISODate][] {
  const out: [ISODate, ISODate][] = [];
  let start = from;
  while (start <= to) {
    const y = Number(start.slice(0, 4)) + years;
    let end = addDays(`${y}${start.slice(4)}`, -1);
    if (end > to) end = to;
    out.push([start, end]);
    start = addDays(end, 1);
  }
  return out;
}

function brlPair(base: string, quote: string): { foreign: string; invert: boolean } | undefined {
  if (quote === 'BRL' && base !== 'BRL') return { foreign: base, invert: false };
  if (base === 'BRL' && quote !== 'BRL') return { foreign: quote, invert: true };
  return undefined;
}

export interface BcbOptions {
  http: HttpClient;
  ptaxBaseUrl?: string;
  sgsBaseUrl?: string;
}

export class BcbPtaxProvider implements FxProvider {
  readonly id: ProviderId = 'bcb-ptax';
  readonly official = true;
  private readonly base: string;

  constructor(private readonly opts: BcbOptions) {
    this.base = opts.ptaxBaseUrl ?? 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata';
  }

  supports(base: string, quote: string): boolean {
    const p = brlPair(base, quote);
    return !!p && (PTAX_CURRENCIES as readonly string[]).includes(p.foreign);
  }

  private url(foreign: string, from: ISODate, to: ISODate): string {
    const common = `@dataInicial='${toMDY(from)}'&@dataFinalCotacao='${toMDY(to)}'&$top=10000&$format=json`;
    if (foreign === 'USD') {
      return `${this.base}/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?${common}&$select=cotacaoCompra,cotacaoVenda,dataHoraCotacao`;
    }
    return `${this.base}/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@moeda='${foreign}'&${common}&$select=cotacaoCompra,cotacaoVenda,dataHoraCotacao,tipoBoletim`;
  }

  async daily(base: string, quote: string, from: ISODate, to: ISODate): Promise<FxPoint[]> {
    const p = brlPair(base, quote);
    if (!p || !this.supports(base, quote)) throw new MarketDataError('UNSUPPORTED', `PTAX does not cover ${base}/${quote}`);
    // USD: 1 row/day -> 10000 rows ≈ 40 years. Others: 4 rows/day -> chunk by 5 years.
    const chunks = chunkRange(from, to, p.foreign === 'USD' ? 20 : 5);
    const rows: PtaxRow[] = [];
    for (const [a, b] of chunks) {
      const body = await this.opts.http.getJson<{ value?: PtaxRow[] }>(this.url(p.foreign, a, b));
      rows.push(...(body.value ?? []));
    }
    const points = parsePtaxRows(rows);
    if (!points.length) throw new MarketDataError('NOT_FOUND', `No PTAX for ${p.foreign}/BRL in ${from}..${to}`);
    return p.invert ? points.map((x) => ({ date: x.date, rate: 1 / x.rate })) : points;
  }
}

/** PTAX rows -> BRL per unit of foreign currency (closing bulletin, selling rate). */
export function parsePtaxRows(rows: readonly PtaxRow[]): FxPoint[] {
  const closing = rows.filter((r) => !r.tipoBoletim || /^fechamento/i.test(r.tipoBoletim));
  return dedupeByDate(
    closing
      .filter((r) => Number.isFinite(r.cotacaoVenda) && r.cotacaoVenda > 0)
      .map((r) => ({ date: r.dataHoraCotacao.slice(0, 10), rate: r.cotacaoVenda })),
  );
}

export class BcbSgsProvider implements FxProvider {
  readonly id: ProviderId = 'bcb-sgs';
  readonly official = true;
  private readonly base: string;

  constructor(private readonly opts: BcbOptions) {
    this.base = opts.sgsBaseUrl ?? 'https://api.bcb.gov.br/dados/serie';
  }

  supports(base: string, quote: string): boolean {
    const p = brlPair(base, quote);
    return !!p && SGS_SERIES[p.foreign] !== undefined;
  }

  async daily(base: string, quote: string, from: ISODate, to: ISODate): Promise<FxPoint[]> {
    const p = brlPair(base, quote);
    const code = p ? SGS_SERIES[p.foreign] : undefined;
    if (!p || code === undefined) throw new MarketDataError('UNSUPPORTED', `SGS does not cover ${base}/${quote}`);
    const out: FxPoint[] = [];
    for (const [a, b] of chunkRange(from, to, 5)) {
      const url = `${this.base}/bcdata.sgs.${code}/dados?formato=json&dataInicial=${toDMY(a)}&dataFinal=${toDMY(b)}`;
      const rows = await this.opts.http.getJson<{ data: string; valor: string }[]>(url);
      out.push(...parseSgsRows(rows));
    }
    const points = dedupeByDate(out);
    if (!points.length) throw new MarketDataError('NOT_FOUND', `No SGS ${code} data in ${from}..${to}`);
    return p.invert ? points.map((x) => ({ date: x.date, rate: 1 / x.rate })) : points;
  }
}

export function parseSgsRows(rows: readonly { data: string; valor: string }[]): FxPoint[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => ({ date: fromDMY(r.data), rate: Number(String(r.valor).replace(',', '.')) }))
    .filter((r) => Number.isFinite(r.rate) && r.rate > 0);
}
