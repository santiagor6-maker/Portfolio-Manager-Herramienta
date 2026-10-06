/**
 * Colombian funds from the Superintendencia Financiera open data on datos.gov.co (live-verified 2026-10-05):
 *  - FIC (fondos de inversión colectiva), dataset qhpu-8ixx "Rentabilidades de los FIC": one row
 *    per fund participation per day with `valor_unidad_operaciones` (unit value, COP).
 *    Key: tipo_entidad + codigo_entidad + codigo_negocio + tipo_participacion
 *    -> instrument id `FIC:{tipo_entidad}-{codigo_entidad}-{codigo_negocio}-{tipo_participacion}`.
 *  - Mandatory pension and cesantías funds, dataset uawh-cjvi: `valor_unidad` per fund per day
 *    -> id `AFP:{codigo_entidad}-{codigo_patrimonio}`.
 */
import type { Instrument, ISODate, ProviderId } from '@pm/core';
import { DAY, HOUR, type TieredCache } from '../cache';
import { addDays, todayISO } from '../dates';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { normalizeText } from '../text';
import { mapHttpError, simpleHistory } from './common';
import type { PriceProvider, PriceTarget, ProviderHistory } from './types';

const BASE = 'https://www.datos.gov.co/resource';
const STOP = new Set(['fondo', 'fondos', 'de', 'inversion', 'colectiva', 'fic', 'abierto', 'cerrado', 'el', 'la', 'del', 'y']);

function soql(dataset: string, params: Record<string, string>, base = BASE): string {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [`$${k}`, v]));
  return `${base}/${dataset}.json?${qs.toString()}`;
}

const sq = (s: string) => s.replace(/'/g, "''");

interface FicRow {
  tipo_entidad: string;
  codigo_entidad: string;
  nombre_entidad: string;
  codigo_negocio: string;
  nombre_patrimonio: string;
  nombre_subtipo_patrimonio?: string;
  tipo_participacion: string;
}

export function ficInstrument(r: FicRow): Instrument {
  return {
    id: `FIC:${r.tipo_entidad}-${r.codigo_entidad}-${r.codigo_negocio}-${r.tipo_participacion}`,
    symbol: `${r.codigo_negocio}-${r.tipo_participacion}`,
    name: `${r.nombre_patrimonio} (participación ${r.tipo_participacion}) — ${r.nombre_entidad}`,
    exchange: 'FIC',
    currency: 'COP',
    country: 'CO',
    assetClass: 'fund',
    ...(r.nombre_subtipo_patrimonio ? { industry: r.nombre_subtipo_patrimonio } : {}),
    providerSymbols: { superfin: `${r.tipo_entidad}-${r.codigo_entidad}-${r.codigo_negocio}-${r.tipo_participacion}` },
    pricing: 'auto',
  };
}

export class SuperfinProvider implements PriceProvider {
  readonly id: ProviderId = 'superfin';

  constructor(private readonly opts: { http: HttpClient; cache?: TieredCache; baseUrl?: string; appToken?: string; now?: () => Date }) {}

  supports(t: PriceTarget): boolean {
    return t.exchange === 'FIC' || t.exchange === 'AFP';
  }

  private get headers(): Record<string, string> {
    return this.opts.appToken ? { 'X-App-Token': this.opts.appToken } : {};
  }

  private async get<T>(url: string): Promise<T> {
    try {
      return await this.opts.http.getJson<T>(url, this.headers);
    } catch (e) {
      mapHttpError('superfin', e);
    }
  }

  /** FIC participations whose name contains every query word, reported in the last 15 days. */
  async searchFic(query: string, limit = 20): Promise<Instrument[]> {
    const words = normalizeText(query).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
    if (!words.length) return [];
    const since = addDays(todayISO(this.opts.now?.()), -15);
    const where = [...words.map((w) => `upper(nombre_patrimonio) like '%${sq(w.toUpperCase())}%'`), `fecha_corte >= '${since}T00:00:00'`].join(' AND ');
    const fields = 'tipo_entidad,codigo_entidad,nombre_entidad,codigo_negocio,nombre_patrimonio,nombre_subtipo_patrimonio,tipo_participacion';
    const load = () => this.get<FicRow[]>(soql('qhpu-8ixx', { select: `${fields},max(fecha_corte) as last`, where, group: fields, limit: '100' }, this.opts.baseUrl));
    const rows = this.opts.cache ? (await this.opts.cache.getOrLoad(`superfin:fic-search:${words.join('+')}`, DAY, load)).value : await load();
    return rows.slice(0, limit).map(ficInstrument);
  }

  /** Mandatory pension / cesantías funds (cached 1 day), filtered locally. */
  async searchAfp(query: string, limit = 20): Promise<Instrument[]> {
    const load = () =>
      this.get<{ codigo_entidad: string; nombre_entidad: string; codigo_patrimonio: string; nombre_fondo: string }[]>(
        soql('uawh-cjvi', { select: 'codigo_entidad,nombre_entidad,codigo_patrimonio,nombre_fondo,max(fecha) as last', group: 'codigo_entidad,nombre_entidad,codigo_patrimonio,nombre_fondo', limit: '200' }, this.opts.baseUrl),
      );
    const rows = this.opts.cache ? (await this.opts.cache.getOrLoad('superfin:afp-funds', DAY, load)).value : await load();
    const words = normalizeText(query).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
    return rows
      .filter((r) => {
        const hay = normalizeText(`${r.nombre_entidad} ${r.nombre_fondo} pension pensiones cesantias afp`);
        return words.length > 0 && words.every((w) => hay.includes(w));
      })
      .slice(0, limit)
      .map((r) => ({
        id: `AFP:${r.codigo_entidad}-${r.codigo_patrimonio}`,
        symbol: `${r.codigo_entidad}-${r.codigo_patrimonio}`,
        name: `${r.nombre_fondo} — ${r.nombre_entidad.replace(/"/g, '')}`,
        exchange: 'AFP',
        currency: 'COP',
        country: 'CO',
        assetClass: 'fund' as const,
        providerSymbols: { superfin: `${r.codigo_entidad}-${r.codigo_patrimonio}` },
        pricing: 'auto' as const,
      }));
  }

  async dailyHistory(t: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const code = t.instrumentId.split(':')[1] ?? '';
    const range = `'${from}T00:00:00' and '${to}T00:00:00'`;
    let points: { date: ISODate; close: number }[];
    if (t.exchange === 'FIC') {
      const [te, ce, cn, tp] = code.split('-');
      if (!te || !ce || !cn || !tp || !/^[\d-]+$/.test(code)) throw new MarketDataError('BAD_REQUEST', `Invalid FIC id ${t.instrumentId} (FIC:tipoEntidad-codigoEntidad-codigoNegocio-participacion)`);
      const rows = await this.get<{ fecha_corte: string; valor_unidad_operaciones: string }[]>(
        soql('qhpu-8ixx', {
          select: 'fecha_corte,valor_unidad_operaciones',
          where: `tipo_entidad='${te}' AND codigo_entidad='${ce}' AND codigo_negocio='${cn}' AND tipo_participacion='${tp}' AND fecha_corte between ${range}`,
          order: 'fecha_corte',
          limit: '50000',
        }, this.opts.baseUrl),
      );
      points = rows.map((r) => ({ date: r.fecha_corte.slice(0, 10), close: Number(r.valor_unidad_operaciones) }));
    } else {
      const [ce, cp] = code.split('-');
      if (!ce || !cp || !/^[\d-]+$/.test(code)) throw new MarketDataError('BAD_REQUEST', `Invalid AFP id ${t.instrumentId} (AFP:codigoEntidad-codigoPatrimonio)`);
      const rows = await this.get<{ fecha: string; valor_unidad: string }[]>(
        soql('uawh-cjvi', { select: 'fecha,valor_unidad', where: `codigo_entidad='${ce}' AND codigo_patrimonio='${cp}' AND fecha between ${range}`, order: 'fecha', limit: '50000' }, this.opts.baseUrl),
      );
      points = rows.map((r) => ({ date: r.fecha.slice(0, 10), close: Number(r.valor_unidad) }));
    }
    return simpleHistory(t, this.id, 'COP', points, from, to, 'as-traded', { notes: ['valor de unidad reportado a la Superintendencia Financiera'] });
  }
}

export const SUPERFIN_TTL = { HISTORY_RECENT: 6 * HOUR };
