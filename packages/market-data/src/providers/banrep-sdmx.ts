/**
 * Banco de la República (Colombia) SDMX 2.1 web service, reachable and verified 2026-10-05:
 *   GET https://totoro.banrep.gov.co/nsi-jax-ws/rest/data/ESTAT,{DATAFLOW},1.0/all/all?startPeriod=YYYY-MM-DD
 *   -> SDMX GenericData XML. Notes from live probing:
 *      - the key must be `all/all`; `endPeriod` is rejected (404/400), so we slice locally;
 *      - `startPeriod` is honoured at year granularity (data comes from Jan 1 of that year);
 *      - daily ObsDimension values are `YYYYMMDD`, monthly ones `YYYY-MM`.
 * Dataflows used (SUBJECT / UNIT_MEASURE in the series key):
 *   DF_UVR_DAILY_HIST  RVU/CRVU = UVR value (COP), RVU/APC = annual variation
 *   DF_IBR_DAILY_HIST  IRIBRM00|01|03|06 (overnight, 1, 3, 6 months) x NR (nominal) | ER (effective)
 *   DF_DTF_DAILY_HIST  IRGBRM03/PA = DTF 90 days, % E.A.
 *   DF_CBR_DAILY_HIST  IRCBRM01/PA = monetary policy rate
 *   DF_TRM_DAILY_HIST  CCSP/COP    = TRM (every calendar day)
 *   DF_COLCAP_MONTHLY_HIST SP/IX   = COLCAP, MONTHLY AVERAGE (checked against ICOLCAP: the ratio to
 *                                    the ETF's monthly average is stable at ~0.101, to month-end closes it is not)
 */
import type { FxPoint, ISODate, ProviderId } from '@pm/core';
import { HOUR, type TieredCache } from '../cache';
import { endOfMonth } from '../dates';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { sliceRange } from '../series';
import { fromCompact, mapHttpError } from './common';
import type { FxProvider } from './types';

export interface SdmxSeries {
  key: Record<string, string>;
  obs: { period: string; value: number }[];
}

/** Parse SDMX-ML 2.1 GenericData (regex based: the format is regular and we avoid a DOM dependency). */
export function parseSdmxGeneric(xml: string): SdmxSeries[] {
  const out: SdmxSeries[] = [];
  for (const m of xml.matchAll(/<generic:Series>([\s\S]*?)<\/generic:Series>/g)) {
    const body = m[1]!;
    const keyPart = /<generic:SeriesKey>([\s\S]*?)<\/generic:SeriesKey>/.exec(body)?.[1] ?? '';
    const key: Record<string, string> = {};
    for (const k of keyPart.matchAll(/<generic:Value id="([^"]+)" value="([^"]*)"\s*\/>/g)) key[k[1]!] = k[2]!;
    const obs: SdmxSeries['obs'] = [];
    for (const o of body.matchAll(/<generic:ObsDimension value="([^"]+)"\s*\/>\s*<generic:ObsValue value="([^"]+)"/g)) {
      const value = Number(o[2]);
      if (Number.isFinite(value)) obs.push({ period: o[1]!, value });
    }
    out.push({ key, obs });
  }
  return out;
}

/** SDMX period -> ISO date (monthly periods map to the LAST day of the month). */
export function sdmxPeriodToDate(p: string): ISODate {
  if (/^\d{8}$/.test(p)) return fromCompact(p);
  if (/^\d{4}-\d{2}$/.test(p)) return endOfMonth(`${p}-01`);
  return p.slice(0, 10);
}

export class BanrepSdmx {
  constructor(private readonly opts: { http: HttpClient; cache?: TieredCache; baseUrl?: string }) {}

  /** All series of a dataflow from Jan 1 of `from`'s year (cached 6 h). */
  async dataflow(df: string, from: ISODate): Promise<SdmxSeries[]> {
    const start = `${from.slice(0, 4)}-01-01`;
    const load = async () => {
      const url = `${this.opts.baseUrl ?? 'https://totoro.banrep.gov.co/nsi-jax-ws/rest/data'}/ESTAT,${df},1.0/all/all?startPeriod=${start}`;
      let xml: string;
      try {
        xml = await this.opts.http.getText(url, { Accept: 'application/xml' });
      } catch (e) {
        mapHttpError(`banrep-sdmx ${df}`, e);
      }
      const series = parseSdmxGeneric(xml);
      if (!series.length) throw new MarketDataError('NOT_FOUND', `banrep-sdmx: ${df} returned no series`);
      return series;
    };
    if (!this.opts.cache) return load();
    return (await this.opts.cache.getOrLoad(`banrep-sdmx:${df}:${start}`, 6 * HOUR, load)).value;
  }

  /** One series (selected by key values) as dated points within [from, to]. */
  async series(df: string, select: Record<string, string>, from: ISODate, to: ISODate): Promise<{ date: ISODate; value: number }[]> {
    const all = await this.dataflow(df, from);
    const s = all.find((x) => Object.entries(select).every(([k, v]) => x.key[k] === v));
    if (!s) throw new MarketDataError('NOT_FOUND', `banrep-sdmx: no series ${JSON.stringify(select)} in ${df}`);
    const pts = s.obs.map((o) => ({ date: sdmxPeriodToDate(o.period), value: o.value })).sort((a, b) => (a.date < b.date ? -1 : 1));
    return sliceRange(pts, from, to);
  }
}

/** Second official TRM source (BanRep's own SDMX), used if datos.gov.co fails. */
export class BanrepSdmxTrmProvider implements FxProvider {
  readonly id: ProviderId = 'banrep-sdmx';
  readonly official = true;
  constructor(private readonly sdmx: BanrepSdmx) {}

  supports(base: string, quote: string): boolean {
    return (base === 'USD' && quote === 'COP') || (base === 'COP' && quote === 'USD');
  }

  async daily(base: string, quote: string, from: ISODate, to: ISODate): Promise<FxPoint[]> {
    const pts = await this.sdmx.series('DF_TRM_DAILY_HIST', { SUBJECT: 'CCSP' }, from, to);
    return pts.map((p) => ({ date: p.date, rate: base === 'USD' ? p.value : 1 / p.value }));
  }
}
