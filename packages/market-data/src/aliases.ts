/**
 * Ticker renames and delistings. Old tickers (from broker statements, imports) resolve
 * transparently to the current instrument with `renamedFrom` info, and history is stitched
 * across the change when the provider still has data under the old symbol.
 *
 * Verified 2026-10-05: every old Yahoo symbol below answers 404 and the new one has the full
 * history (Yahoo moved it), so in practice stitching only matters for other providers / caches.
 * Effective dates are left empty unless known with certainty.
 */
import type { ISODate } from '@pm/core';
import type { RenameInfo } from './types';

export interface TickerAlias {
  fromId: string;
  fromYahoo: string;
  toId: string;
  toYahoo: string;
  /** New shares per old share. */
  ratio: number;
  effective?: ISODate;
  note: string;
}

export const TICKER_ALIASES: readonly TickerAlias[] = [
  { fromId: 'XBOG:PFBCOLOM', fromYahoo: 'PFBCOLOM.CL', toId: 'XBOG:PFCIBEST', toYahoo: 'PFCIBEST.CL', ratio: 1, note: 'Bancolombia preferencial -> Grupo Cibest preferencial (reorganización 2025, canje 1:1)' },
  { fromId: 'XBOG:BCOLOMBIA', fromYahoo: 'BCOLOMBIA.CL', toId: 'XBOG:CIBEST', toYahoo: 'CIBEST.CL', ratio: 1, note: 'Bancolombia ordinaria -> Grupo Cibest ordinaria (reorganización 2025, canje 1:1)' },
  { fromId: 'BVMF:ELET3', fromYahoo: 'ELET3.SA', toId: 'BVMF:AXIA3', toYahoo: 'AXIA3.SA', ratio: 1, note: 'Eletrobras ON -> AXIA Energia ON (mudança de nome)' },
  { fromId: 'BVMF:EMBR3', fromYahoo: 'EMBR3.SA', toId: 'BVMF:EMBJ3', toYahoo: 'EMBJ3.SA', ratio: 1, note: 'Embraer: novo código EMBJ3' },
  { fromId: 'BVMF:CCRO3', fromYahoo: 'CCRO3.SA', toId: 'BVMF:MOTV3', toYahoo: 'MOTV3.SA', ratio: 1, note: 'CCR -> Motiva (mudança de nome)' },
  { fromId: 'BVMF:NTCO3', fromYahoo: 'NTCO3.SA', toId: 'BVMF:NATU3', toYahoo: 'NATU3.SA', ratio: 1, note: 'Natura &Co Holding -> Natura Cosméticos (incorporação; verificar relação de troca)' },
  { fromId: 'BVMF:BRFS3', fromYahoo: 'BRFS3.SA', toId: 'BVMF:MBRF3', toYahoo: 'MBRF3.SA', ratio: 1, note: 'BRF -> MBRF (fusão BRF + Marfrig; verificar relação de troca)' },
  { fromId: 'BVMF:MRFG3', fromYahoo: 'MRFG3.SA', toId: 'BVMF:MBRF3', toYahoo: 'MBRF3.SA', ratio: 1, note: 'Marfrig -> MBRF (fusão BRF + Marfrig; verificar relação de troca)' },
  { fromId: 'BVMF:CPLE6', fromYahoo: 'CPLE6.SA', toId: 'BVMF:CPLE3', toYahoo: 'CPLE3.SA', ratio: 1, note: 'Copel PNB -> ON (migração ao Novo Mercado; verificar relação de conversão)' },
];

const byKey = new Map<string, TickerAlias>();
for (const a of TICKER_ALIASES) {
  byKey.set(a.fromId.toUpperCase(), a);
  byKey.set(a.fromYahoo.toUpperCase(), a);
}

/** Alias for an old id or old Yahoo symbol (case-insensitive). */
export function findAlias(key: string): TickerAlias | undefined {
  return byKey.get(key.trim().toUpperCase());
}

/** Aliases whose new instrument is `toId` (to stitch old history in). */
export function aliasesTo(toId: string): TickerAlias[] {
  return TICKER_ALIASES.filter((a) => a.toId.toUpperCase() === toId.toUpperCase());
}

export function renameInfo(a: TickerAlias): RenameInfo {
  return { fromId: a.fromId, toId: a.toId, ratio: a.ratio, ...(a.effective ? { effective: a.effective } : {}), note: a.note };
}
