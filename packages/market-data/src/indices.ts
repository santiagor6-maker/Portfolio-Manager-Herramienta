/**
 * Rate and inflation indices (`/api/index`), output in core's IndexSeries shape.
 *
 * Brazil (BCB SGS): CDI (12), SELIC (11), CDI_ANUAL (4389), SELIC_META (432), IPCA (433),
 *   IGPM (189), INPC (188). Not reachable from the build container; fixtures follow the SGS format.
 * Colombia (BanRep SDMX, live-verified): UVR, IBR overnight/1M/3M/6M (nominal and E.A.), DTF,
 *   TPM_CO (policy rate), COLCAP_AVG (monthly average of the real COLCAP index).
 * IPC_CO: DANE is not reachable and datos.gov.co has no IPC dataset, so the monthly CPI variation
 *   is DERIVED EXACTLY from the UVR (Ley 546/1999; BanRep Res. Ext. 13/2000): between the 16th of
 *   month m+1 and the 15th of month m+2 the UVR grows by the CPI variation of month m, so
 *   IPC_m = UVR(15 of m+2) / UVR(15 of m+1) - 1. Live check: Dec-2024 0.46 %, Jan-2025 0.94 %,
 *   Feb-2025 1.14 %, Mar-2025 0.52 % — identical to DANE's published figures.
 * US: CPI_US = FRED CPIAUCSL (index level, monthly). Euro area: HICP_EA = ECB ICP (index level).
 */
import type { IndexId, IndexPoint, IndexSeries, ISODate } from '@pm/core';
import { HOUR, MINUTE, TieredCache, TTL } from './cache';
import { addDays, endOfMonth, startOfMonth, todayISO } from './dates';
import { MarketDataError } from './errors';
import type { HttpClient } from './http';
import { BanrepSdmx } from './providers/banrep-sdmx';
import { fetchSgs } from './providers/bcb';
import { parseCsv } from './providers/ecb';
import { sliceRange } from './series';
import type { IndexInfo, IndexResponse } from './types';

type Shape = Omit<IndexSeries, 'points' | 'source' | 'id'>;

interface IndexDef {
  info: Omit<IndexInfo, 'id'>;
  shape: Shape;
  source: string;
  load: (ctx: IndexContext, from: ISODate, to: ISODate) => Promise<IndexPoint[]>;
}

interface IndexContext {
  http: HttpClient;
  sdmx: BanrepSdmx;
  sgsBaseUrl?: string;
  fredBaseUrl?: string;
  ecbBaseUrl?: string;
}

const sgs = (code: number) => async (ctx: IndexContext, from: ISODate, to: ISODate) =>
  (await fetchSgs(ctx.http, code, from, to, ctx.sgsBaseUrl)).map((p) => ({ date: p.date, value: p.rate }));

const sdmx = (df: string, select: Record<string, string>) => async (ctx: IndexContext, from: ISODate, to: ISODate) =>
  ctx.sdmx.series(df, select, from, to);

const ibr = (subject: string, unit: 'NR' | 'ER') => sdmx('DF_IBR_DAILY_HIST', { SUBJECT: subject, UNIT_MEASURE: unit });

/** Monthly CPI variation (percent) of each month in [from, to] derived from daily UVR values. */
export function ipcFromUvr(uvr: readonly IndexPoint[], from: ISODate, to: ISODate): IndexPoint[] {
  const byDate = new Map(uvr.map((p) => [p.date, p.value]));
  const out: IndexPoint[] = [];
  for (let m = startOfMonth(from); m <= to; m = addDays(endOfMonth(m), 1)) {
    const m1 = addDays(endOfMonth(m), 1); // first day of m+1
    const m2 = addDays(endOfMonth(m1), 1); // first day of m+2
    const a = byDate.get(`${m1.slice(0, 7)}-15`);
    const b = byDate.get(`${m2.slice(0, 7)}-15`);
    if (a === undefined || b === undefined) continue;
    // DANE publishes the monthly variation with 2 decimals; UVR rounding (4 decimals) adds ~1e-5 noise.
    out.push({ date: m, value: Math.round((b / a - 1) * 10_000) / 100 });
  }
  return out;
}

const monthEndLevels = (pts: IndexPoint[]) => pts.map((p) => ({ date: endOfMonth(p.date), value: p.value }));

export const INDEX_DEFS: Readonly<Record<string, IndexDef>> = {
  CDI: {
    info: { name: 'CDI (taxa DI)', country: 'BR', description: '% ao dia por dia útil', sourceDetail: 'BCB SGS 12', frequency: 'daily' },
    shape: { kind: 'periodRate', period: 'day', unit: 'percent', dayCount: 'BUS/252', currency: 'BRL' },
    source: 'bcb-sgs',
    load: sgs(12),
  },
  SELIC: {
    info: { name: 'Taxa Selic (diária)', country: 'BR', description: '% ao dia por dia útil', sourceDetail: 'BCB SGS 11', frequency: 'daily' },
    shape: { kind: 'periodRate', period: 'day', unit: 'percent', dayCount: 'BUS/252', currency: 'BRL' },
    source: 'bcb-sgs',
    load: sgs(11),
  },
  CDI_ANUAL: {
    info: { name: 'CDI anualizado', country: 'BR', description: '% a.a. base 252', sourceDetail: 'BCB SGS 4389', frequency: 'daily' },
    shape: { kind: 'annualRate', unit: 'percent', dayCount: 'BUS/252', currency: 'BRL' },
    source: 'bcb-sgs',
    load: sgs(4389),
  },
  SELIC_META: {
    info: { name: 'Meta Selic (Copom)', country: 'BR', description: '% a.a.', sourceDetail: 'BCB SGS 432', frequency: 'daily' },
    shape: { kind: 'annualRate', unit: 'percent', dayCount: 'BUS/252', currency: 'BRL' },
    source: 'bcb-sgs',
    load: sgs(432),
  },
  IPCA: {
    info: { name: 'IPCA', country: 'BR', description: 'variação mensal %', sourceDetail: 'BCB SGS 433 (IBGE)', frequency: 'monthly' },
    shape: { kind: 'periodRate', period: 'month', unit: 'percent', currency: 'BRL' },
    source: 'bcb-sgs',
    load: sgs(433),
  },
  IGPM: {
    info: { name: 'IGP-M', country: 'BR', description: 'variação mensal %', sourceDetail: 'BCB SGS 189 (FGV)', frequency: 'monthly' },
    shape: { kind: 'periodRate', period: 'month', unit: 'percent', currency: 'BRL' },
    source: 'bcb-sgs',
    load: sgs(189),
  },
  INPC: {
    info: { name: 'INPC', country: 'BR', description: 'variação mensal %', sourceDetail: 'BCB SGS 188 (IBGE)', frequency: 'monthly' },
    shape: { kind: 'periodRate', period: 'month', unit: 'percent', currency: 'BRL' },
    source: 'bcb-sgs',
    load: sgs(188),
  },
  IPC_CO: {
    info: {
      name: 'IPC Colombia (variación mensual)',
      country: 'CO',
      description: 'variación mensual % del IPC (DANE), derivada exactamente de la UVR',
      sourceDetail: 'BanRep SDMX DF_UVR_DAILY_HIST (UVR día 15)',
      frequency: 'monthly',
    },
    shape: { kind: 'periodRate', period: 'month', unit: 'percent', currency: 'COP' },
    source: 'banrep-uvr',
    load: async (ctx, from, to) => {
      const uvr = await ctx.sdmx.series('DF_UVR_DAILY_HIST', { SUBJECT: 'RVU', UNIT_MEASURE: 'CRVU' }, startOfMonth(from), addDays(endOfMonth(addDays(endOfMonth(to), 40)), 0));
      return ipcFromUvr(uvr, from, to);
    },
  },
  UVR: {
    info: { name: 'UVR', country: 'CO', description: 'Unidad de Valor Real, valor diario en COP', sourceDetail: 'BanRep SDMX DF_UVR_DAILY_HIST', frequency: 'daily' },
    shape: { kind: 'level', currency: 'COP' },
    source: 'banrep-sdmx',
    load: sdmx('DF_UVR_DAILY_HIST', { SUBJECT: 'RVU', UNIT_MEASURE: 'CRVU' }),
  },
  IBR: {
    info: { name: 'IBR overnight (nominal)', country: 'CO', description: '% nominal anual base 360', sourceDetail: 'BanRep SDMX DF_IBR_DAILY_HIST IRIBRM00/NR', frequency: 'daily' },
    shape: { kind: 'annualRate', unit: 'percent', dayCount: 'ACT/360', currency: 'COP' },
    source: 'banrep-sdmx',
    load: ibr('IRIBRM00', 'NR'),
  },
  IBR_EA: {
    info: { name: 'IBR overnight (E.A.)', country: 'CO', description: '% efectivo anual', sourceDetail: 'BanRep SDMX DF_IBR_DAILY_HIST IRIBRM00/ER', frequency: 'daily' },
    shape: { kind: 'annualRate', unit: 'percent', dayCount: 'ACT/365', currency: 'COP' },
    source: 'banrep-sdmx',
    load: ibr('IRIBRM00', 'ER'),
  },
  IBR_1M: {
    info: { name: 'IBR 1 mes (nominal)', country: 'CO', description: '% nominal anual base 360', sourceDetail: 'BanRep SDMX IRIBRM01/NR', frequency: 'daily' },
    shape: { kind: 'annualRate', unit: 'percent', dayCount: 'ACT/360', currency: 'COP' },
    source: 'banrep-sdmx',
    load: ibr('IRIBRM01', 'NR'),
  },
  IBR_3M: {
    info: { name: 'IBR 3 meses (nominal)', country: 'CO', description: '% nominal anual base 360', sourceDetail: 'BanRep SDMX IRIBRM03/NR', frequency: 'daily' },
    shape: { kind: 'annualRate', unit: 'percent', dayCount: 'ACT/360', currency: 'COP' },
    source: 'banrep-sdmx',
    load: ibr('IRIBRM03', 'NR'),
  },
  IBR_6M: {
    info: { name: 'IBR 6 meses (nominal)', country: 'CO', description: '% nominal anual base 360', sourceDetail: 'BanRep SDMX IRIBRM06/NR', frequency: 'daily' },
    shape: { kind: 'annualRate', unit: 'percent', dayCount: 'ACT/360', currency: 'COP' },
    source: 'banrep-sdmx',
    load: ibr('IRIBRM06', 'NR'),
  },
  DTF: {
    info: { name: 'DTF 90 días', country: 'CO', description: '% efectivo anual (semanal, vigente cada día)', sourceDetail: 'BanRep SDMX DF_DTF_DAILY_HIST', frequency: 'daily' },
    shape: { kind: 'annualRate', unit: 'percent', dayCount: 'ACT/365', currency: 'COP' },
    source: 'banrep-sdmx',
    load: sdmx('DF_DTF_DAILY_HIST', { SUBJECT: 'IRGBRM03' }),
  },
  TPM_CO: {
    info: { name: 'Tasa de política monetaria (BanRep)', country: 'CO', description: '% anual', sourceDetail: 'BanRep SDMX DF_CBR_DAILY_HIST', frequency: 'daily' },
    shape: { kind: 'annualRate', unit: 'percent', dayCount: 'ACT/365', currency: 'COP' },
    source: 'banrep-sdmx',
    load: sdmx('DF_CBR_DAILY_HIST', { SUBJECT: 'IRCBRM01' }),
  },
  COLCAP_AVG: {
    info: {
      name: 'COLCAP (promedio mensual)',
      country: 'CO',
      description: 'Índice COLCAP real, PROMEDIO del mes (no cierre); fechado el último día del mes',
      sourceDetail: 'BanRep SDMX DF_COLCAP_MONTHLY_HIST',
      frequency: 'monthly',
    },
    shape: { kind: 'level', currency: 'COP' },
    source: 'banrep-sdmx',
    load: sdmx('DF_COLCAP_MONTHLY_HIST', { SUBJECT: 'SP' }),
  },
  CPI_US: {
    info: { name: 'US CPI-U (SA)', country: 'US', description: 'index level 1982-84=100, dated month end', sourceDetail: 'FRED CPIAUCSL', frequency: 'monthly' },
    shape: { kind: 'level', currency: 'USD' },
    source: 'fred',
    load: async (ctx, from, to) => {
      const text = await ctx.http.getText(`${ctx.fredBaseUrl ?? 'https://fred.stlouisfed.org/graph'}/fredgraph.csv?id=CPIAUCSL&cosd=${startOfMonth(from)}&coed=${to}`, { Accept: 'text/csv' });
      const rows = parseCsv(text).slice(1);
      return sliceRange(monthEndLevels(rows.map((r) => ({ date: r[0] ?? '', value: Number(r[1]) })).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.value))), from, to);
    },
  },
  HICP_EA: {
    info: { name: 'HICP euro area', country: 'EU', description: 'index level 2015=100, dated month end', sourceDetail: 'ECB ICP M.U2.N.000000.4.INX', frequency: 'monthly' },
    shape: { kind: 'level', currency: 'EUR' },
    source: 'ecb',
    load: async (ctx, from, to) => {
      const text = await ctx.http.getText(`${ctx.ecbBaseUrl ?? 'https://data-api.ecb.europa.eu/service/data'}/ICP/M.U2.N.000000.4.INX?startPeriod=${from.slice(0, 7)}&endPeriod=${to.slice(0, 7)}&format=csvdata`, { Accept: 'text/csv' });
      const rows = parseCsv(text);
      const h = rows[0] ?? [];
      const iD = h.indexOf('TIME_PERIOD');
      const iV = h.indexOf('OBS_VALUE');
      return sliceRange(rows.slice(1).map((r) => ({ date: endOfMonth(`${r[iD]}-01`), value: Number(r[iV]) })).filter((p) => Number.isFinite(p.value)), from, to);
    },
  },
};

export const INDEX_IDS = Object.keys(INDEX_DEFS);

export class IndexService {
  private readonly ctx: IndexContext;

  constructor(
    private readonly opts: {
      http: HttpClient;
      cache: TieredCache;
      sdmx: BanrepSdmx;
      today?: () => ISODate;
      sgsBaseUrl?: string;
      fredBaseUrl?: string;
      ecbBaseUrl?: string;
    },
  ) {
    this.ctx = { http: opts.http, sdmx: opts.sdmx, sgsBaseUrl: opts.sgsBaseUrl, fredBaseUrl: opts.fredBaseUrl, ecbBaseUrl: opts.ecbBaseUrl };
  }

  list(): IndexInfo[] {
    return Object.entries(INDEX_DEFS).map(([id, d]) => ({ id, ...d.info }));
  }

  async get(idRaw: string, from: ISODate, to: ISODate): Promise<IndexResponse> {
    const id = idRaw.toUpperCase() as IndexId;
    const def = INDEX_DEFS[id];
    if (!def) throw new MarketDataError('BAD_REQUEST', `Unknown index "${idRaw}". Available: ${INDEX_IDS.join(', ')}`);
    const today = this.opts.today?.() ?? todayISO();
    // Monthly figures are published with a lag (IPCA ~10 days, IPC via UVR ~40 days): ranges
    // ending within the last two months stay mutable.
    const twoMonthsAgo = startOfMonth(addDays(startOfMonth(addDays(startOfMonth(today), -1)), -1));
    const ttl = to < twoMonthsAgo ? TTL.IMMUTABLE : def.info.frequency === 'monthly' ? 6 * HOUR : 30 * MINUTE;
    const { value: points } = await this.opts.cache.getOrLoad(`index:${id}:${from}:${to}`, ttl, async () => {
      const pts = await def.load(this.ctx, from, to);
      if (!pts.length) throw new MarketDataError('NOT_FOUND', `${id}: no observations in ${from}..${to}`);
      return pts;
    });
    const series: IndexSeries = { id, ...def.shape, points, source: def.source };
    const notes: string[] = [];
    if (id === 'IPC_CO') notes.push('derivado de la UVR: la variación del mes m se conoce cuando BanRep publica la UVR del 15 de m+2');
    if (id === 'COLCAP_AVG') notes.push('promedio mensual del índice, no cierre de mes; para comparación mensual punto a punto use el benchmark COLCAP_TR (ICOLCAP con dividendos)');
    return { series, info: { id, ...def.info }, lastObservation: points[points.length - 1]?.date, ...(notes.length ? { notes } : {}) };
  }
}
