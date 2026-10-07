/**
 * Ticker renames, mergers and share-class conversions.
 *
 * Two very different cases (review R2, M23):
 *  - 'rename': the SAME security under a new ticker (CCR -> Motiva, Eletrobras -> AXIA, Marfrig ->
 *    MBRF). History continues: the old ticker resolves to the new one, history is stitched.
 *  - 'merger' / 'conversion': the old security ceased to exist; holders received `ratio` shares of
 *    another security (+ cash). BRFS3 -> 0.8521 MBRF3 (MBRF3's past is Marfrig's, not BRF's);
 *    CPLE6 -> 1 CPLE3 + R$0.7749. The new ticker's prices are never served as the old one's:
 *    history is cut at the last trading day and a MERGER action (plus a cash event) is emitted.
 *
 * Every row is verified (sources in the README); unverified relations are not published.
 * Yahoo moved the old history to the new symbol for every rename below (old symbols answer 404).
 */
import type { ISODate } from '@pm/core';
import type { RenameInfo } from './types';

export interface TickerAlias {
  kind: 'rename' | 'merger' | 'conversion';
  fromId: string;
  fromYahoo: string;
  toId: string;
  toYahoo: string;
  /** New shares per old share. */
  ratio: number;
  /** First day under the new ticker / holding the new shares. */
  effective?: ISODate;
  /** Last trading day of the old ticker. */
  lastTradingDay?: ISODate;
  cashPerShare?: number;
  cashPayDate?: ISODate;
  /** ISINs of the old security (so statements with ISINs still resolve). */
  isins?: string[];
  note: string;
}

export const TICKER_ALIASES: readonly TickerAlias[] = [
  {
    kind: 'rename', fromId: 'XBOG:PFBCOLOM', fromYahoo: 'PFBCOLOM.CL', toId: 'XBOG:PFCIBEST', toYahoo: 'PFCIBEST.CL', ratio: 1, isins: ['COB07PA00078'],
    note: 'Bancolombia preferencial -> Grupo Cibest preferencial (reorganización 2025, canje 1:1; misma serie de precios)',
  },
  {
    kind: 'rename', fromId: 'XBOG:BCOLOMBIA', fromYahoo: 'BCOLOMBIA.CL', toId: 'XBOG:CIBEST', toYahoo: 'CIBEST.CL', ratio: 1,
    note: 'Bancolombia ordinaria -> Grupo Cibest ordinaria (reorganización 2025, canje 1:1; misma serie de precios)',
  },
  { kind: 'rename', fromId: 'BVMF:ELET3', fromYahoo: 'ELET3.SA', toId: 'BVMF:AXIA3', toYahoo: 'AXIA3.SA', ratio: 1, note: 'Eletrobras -> AXIA Energia (mudança de nome e código)' },
  { kind: 'rename', fromId: 'BVMF:EMBR3', fromYahoo: 'EMBR3.SA', toId: 'BVMF:EMBJ3', toYahoo: 'EMBJ3.SA', ratio: 1, note: 'Embraer: novo código EMBJ3' },
  { kind: 'rename', fromId: 'BVMF:CCRO3', fromYahoo: 'CCRO3.SA', toId: 'BVMF:MOTV3', toYahoo: 'MOTV3.SA', ratio: 1, note: 'CCR -> Motiva (mudança de nome e código)' },
  {
    kind: 'rename', fromId: 'BVMF:NTCO3', fromYahoo: 'NTCO3.SA', toId: 'BVMF:NATU3', toYahoo: 'NATU3.SA', ratio: 1, effective: '2025-07-02', lastTradingDay: '2025-07-01',
    note: 'Natura &Co Holding incorporada por Natura Cosméticos: 1 NATU3 por NTCO3, sem diluição; NATU3 negocia desde 2025-07-02',
  },
  {
    kind: 'rename', fromId: 'BVMF:MRFG3', fromYahoo: 'MRFG3.SA', toId: 'BVMF:MBRF3', toYahoo: 'MBRF3.SA', ratio: 1, effective: '2025-09-23', lastTradingDay: '2025-09-22',
    note: 'Marfrig é a companhia sobrevivente da fusão com a BRF e passou a se chamar MBRF (MRFG3 -> MBRF3, 1:1)',
  },
  {
    kind: 'merger', fromId: 'BVMF:BRFS3', fromYahoo: 'BRFS3.SA', toId: 'BVMF:MBRF3', toYahoo: 'MBRF3.SA', ratio: 0.8521, effective: '2025-09-23', lastTradingDay: '2025-09-22',
    note: 'BRF incorporada pela Marfrig (MBRF): 0,8521 MBRF3 por BRFS3. O histórico de MBRF3 é o da Marfrig, não o da BRF',
  },
  {
    kind: 'conversion', fromId: 'BVMF:CPLE6', fromYahoo: 'CPLE6.SA', toId: 'BVMF:CPLE3', toYahoo: 'CPLE3.SA', ratio: 1, effective: '2025-12-22', cashPerShare: 0.7749, cashPayDate: '2025-12-30',
    note: 'Copel (migração ao Novo Mercado): cada PNB virou 1 ON (CPLE3) + 1 PNC resgatada compulsoriamente por R$ 0,7749 (pago em 2025-12-30)',
  },
  {
    kind: 'conversion', fromId: 'BVMF:CPLE5', fromYahoo: 'CPLE5.SA', toId: 'BVMF:CPLE3', toYahoo: 'CPLE3.SA', ratio: 1, effective: '2025-12-22', cashPerShare: 0.7749, cashPayDate: '2025-12-30',
    note: 'Copel (migração ao Novo Mercado): cada PNA virou 1 ON (CPLE3) + 1 PNC resgatada compulsoriamente por R$ 0,7749 (pago em 2025-12-30)',
  },
];

const byKey = new Map<string, TickerAlias>();
for (const a of TICKER_ALIASES) {
  byKey.set(a.fromId.toUpperCase(), a);
  byKey.set(a.fromYahoo.toUpperCase(), a);
  // Bare old ticker as typed from a broker statement (PFBCOLOM, ELET3).
  byKey.set(a.fromId.split(':')[1]!.toUpperCase(), a);
  for (const isin of a.isins ?? []) byKey.set(isin.toUpperCase(), a);
}

/** Alias for an old id, old Yahoo symbol, bare ticker or old ISIN (case-insensitive). */
export function findAlias(key: string): TickerAlias | undefined {
  return byKey.get(key.trim().toUpperCase());
}

/** Same-security renames whose new instrument is `toId` (history can be stitched). */
export function aliasesTo(toId: string): TickerAlias[] {
  return TICKER_ALIASES.filter((a) => a.kind === 'rename' && a.toId.toUpperCase() === toId.toUpperCase());
}

export function renameInfo(a: TickerAlias): RenameInfo {
  return {
    kind: a.kind,
    fromId: a.fromId,
    toId: a.toId,
    ratio: a.ratio,
    ...(a.effective ? { effective: a.effective } : {}),
    ...(a.lastTradingDay ? { lastTradingDay: a.lastTradingDay } : {}),
    ...(a.cashPerShare !== undefined ? { cashPerShare: a.cashPerShare } : {}),
    ...(a.cashPayDate ? { cashPayDate: a.cashPayDate } : {}),
    note: a.note,
  };
}
