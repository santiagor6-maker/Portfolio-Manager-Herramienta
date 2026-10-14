/**
 * Ticker renames, mergers and share-class conversions: the ONE table shared by @pm/importers,
 * @pm/market-data and @pm/tax (review I36). Pure data plus a few lookups, no dependencies.
 *
 * Kinds:
 *  - 'rename': the SAME security under a new code (CCR → Motiva, Eletrobras → AXIA, ISA CTEEP → ISA
 *    Energia). History continues; holdings of the old id are holdings of the new one.
 *  - 'merger' / 'conversion': the old security ceased to exist and holders received `ratio` shares of
 *    another security (plus `cashPerShare`). BRFS3 → 0.8521 MBRF3; CPLE5 → CPLE3 + R$0.7749. The new
 *    code's prices are never the old one's.
 *
 * Codes can be REUSED: BVMF:NATU3 was Natura Cosméticos until 2019-12-17, became NTCO3 (Natura &Co
 * Holding) on 2019-12-18, and NTCO3 became NATU3 again on 2025-07-02. Use `tickerIdOn(startId, date)`
 * to follow the events of one listing chain in chronological order (each event at most once).
 *
 * Sources: B3 / company releases (see @pm/market-data README); rows without a verified date carry none.
 */
import type { ISODate } from './types';

export type TickerEventKind = 'rename' | 'merger' | 'conversion';

export interface TickerEvent {
  kind: TickerEventKind;
  fromId: string;
  toId: string;
  /** New shares per old share. */
  ratio: number;
  /** First day under the new code / holding the new shares. */
  effective?: ISODate;
  /** Last trading day of the old code. */
  lastTradingDay?: ISODate;
  cashPerShare?: number;
  cashPayDate?: ISODate;
  /** Yahoo symbols (market-data history stitching). */
  fromYahoo?: string;
  toYahoo?: string;
  /** ISINs of the old security (statements with ISINs still resolve). */
  isins?: string[];
  /** Units split into several securities (CPLE11 = 1 CPLE3 + 4 CPLE6); `toId`/`ratio` repeat the main one. */
  components?: { toId: string; ratio: number }[];
  note: string;
}

export const TICKER_EVENTS: readonly TickerEvent[] = [
  // Colombia
  {
    kind: 'rename', fromId: 'XBOG:PFBCOLOM', fromYahoo: 'PFBCOLOM.CL', toId: 'XBOG:PFCIBEST', toYahoo: 'PFCIBEST.CL', ratio: 1, isins: ['COB07PA00078'],
    note: 'Bancolombia preferencial -> Grupo Cibest preferencial (reorganización 2025, canje 1:1; misma serie de precios)',
  },
  {
    kind: 'rename', fromId: 'XBOG:BCOLOMBIA', fromYahoo: 'BCOLOMBIA.CL', toId: 'XBOG:CIBEST', toYahoo: 'CIBEST.CL', ratio: 1,
    note: 'Bancolombia ordinaria -> Grupo Cibest ordinaria (reorganización 2025, canje 1:1; misma serie de precios)',
  },
  // Brazil — same security, new code
  { kind: 'rename', fromId: 'BVMF:ELET3', fromYahoo: 'ELET3.SA', toId: 'BVMF:AXIA3', toYahoo: 'AXIA3.SA', ratio: 1, note: 'Eletrobras -> AXIA Energia (mudança de nome e código), ON' },
  { kind: 'rename', fromId: 'BVMF:ELET5', fromYahoo: 'ELET5.SA', toId: 'BVMF:AXIA5', toYahoo: 'AXIA5.SA', ratio: 1, note: 'Eletrobras -> AXIA Energia (mudança de nome e código), PNA' },
  { kind: 'rename', fromId: 'BVMF:ELET6', fromYahoo: 'ELET6.SA', toId: 'BVMF:AXIA6', toYahoo: 'AXIA6.SA', ratio: 1, note: 'Eletrobras -> AXIA Energia (mudança de nome e código), PNB' },
  // AXIA migration to the Novo Mercado (AGE 2026-04-01): every PNA1 (AXIA5) and PNB1 (AXIA6) became
  // 1.1 ON (AXIA3); last trading day 2026-06-05, classes extinct on 2026-06-08; fractions auctioned and
  // paid in cash. Sources: B3 Ofício Circular 035/2026-VNC (index treatment, factor 1.1 on AXIA6);
  // Investidor10 "Tchau, AXIA5 e AXIA6" and Seu Dinheiro (2026-06-08). AXIA7 (PNC) is NOT a successor of
  // AXIA6: it was a bonus of 0.2628378881074 PNC per AXIA3/AXIA5/AXIA6 held on 2025-12-19 (ex
  // 2025-12-22, credited 2025-12-26, unit cost R$ 49,44; InfoMoney / Investidor10), outside this table.
  {
    kind: 'conversion', fromId: 'BVMF:AXIA5', fromYahoo: 'AXIA5.SA', toId: 'BVMF:AXIA3', toYahoo: 'AXIA3.SA', ratio: 1.1, effective: '2026-06-08', lastTradingDay: '2026-06-05',
    note: 'AXIA (Novo Mercado): cada PNA1 (AXIA5) virou 1,1 ON (AXIA3); frações leiloadas e pagas em dinheiro (B3 OC 035/2026-VNC)',
  },
  {
    kind: 'conversion', fromId: 'BVMF:AXIA6', fromYahoo: 'AXIA6.SA', toId: 'BVMF:AXIA3', toYahoo: 'AXIA3.SA', ratio: 1.1, effective: '2026-06-08', lastTradingDay: '2026-06-05',
    note: 'AXIA (Novo Mercado): cada PNB1 (AXIA6) virou 1,1 ON (AXIA3); frações leiloadas e pagas em dinheiro (B3 OC 035/2026-VNC)',
  },
  { kind: 'rename', fromId: 'BVMF:EMBR3', fromYahoo: 'EMBR3.SA', toId: 'BVMF:EMBJ3', toYahoo: 'EMBJ3.SA', ratio: 1, note: 'Embraer: novo código EMBJ3' },
  { kind: 'rename', fromId: 'BVMF:CCRO3', fromYahoo: 'CCRO3.SA', toId: 'BVMF:MOTV3', toYahoo: 'MOTV3.SA', ratio: 1, note: 'CCR -> Motiva (mudança de nome e código)' },
  { kind: 'rename', fromId: 'BVMF:TRPL3', fromYahoo: 'TRPL3.SA', toId: 'BVMF:ISAE3', toYahoo: 'ISAE3.SA', ratio: 1, note: 'ISA CTEEP -> ISA Energia Brasil (mudança de nome e código), ON' },
  { kind: 'rename', fromId: 'BVMF:TRPL4', fromYahoo: 'TRPL4.SA', toId: 'BVMF:ISAE4', toYahoo: 'ISAE4.SA', ratio: 1, note: 'ISA CTEEP -> ISA Energia Brasil (mudança de nome e código), PN' },
  {
    kind: 'rename', fromId: 'BVMF:MRFG3', fromYahoo: 'MRFG3.SA', toId: 'BVMF:MBRF3', toYahoo: 'MBRF3.SA', ratio: 1, effective: '2025-09-23', lastTradingDay: '2025-09-22',
    note: 'Marfrig é a companhia sobrevivente da fusão com a BRF e passou a se chamar MBRF (MRFG3 -> MBRF3, 1:1)',
  },
  // Brazil — the old security ended
  {
    kind: 'merger', fromId: 'BVMF:BRFS3', fromYahoo: 'BRFS3.SA', toId: 'BVMF:MBRF3', toYahoo: 'MBRF3.SA', ratio: 0.8521, effective: '2025-09-23', lastTradingDay: '2025-09-22',
    note: 'BRF incorporada pela Marfrig (MBRF): 0,8521 MBRF3 por BRFS3. O histórico de MBRF3 é o da Marfrig, não o da BRF',
  },
  {
    kind: 'conversion', fromId: 'BVMF:NATU3', fromYahoo: 'NATU3.SA', toId: 'BVMF:NTCO3', toYahoo: 'NTCO3.SA', ratio: 1, effective: '2019-12-18', lastTradingDay: '2019-12-17',
    note: 'Reorganização Natura &Co: cada NATU3 (Natura Cosméticos) virou 1 NTCO3 (Natura &Co Holding), que negocia desde 2019-12-18',
  },
  {
    // Yahoo has no NTCO3 history (2020-2025); NTCO3 becomes NATU3 1:1 on 2025-07-02 (the code NATU3 is reused).
    kind: 'conversion', fromId: 'BVMF:NTCO3', fromYahoo: 'NTCO3.SA', toId: 'BVMF:NATU3', toYahoo: 'NATU3.SA', ratio: 1, effective: '2025-07-02', lastTradingDay: '2025-07-01',
    note: 'Natura &Co Holding incorporada por Natura Cosméticos: 1 NATU3 por NTCO3, sem diluição; NATU3 negocia desde 2025-07-02 (o provedor não tem o histórico de NTCO3)',
  },
  {
    kind: 'conversion', fromId: 'BVMF:CPLE6', fromYahoo: 'CPLE6.SA', toId: 'BVMF:CPLE5', toYahoo: 'CPLE5.SA', ratio: 1, effective: '2025-11-10', lastTradingDay: '2025-11-07',
    note: 'Copel PNB (CPLE6) convertida em PNA (CPLE5) 1:1 em 2025-11-10; depois CPLE5 -> CPLE3 + R$ 0,7749 em 2025-12-22',
  },
  {
    kind: 'conversion', fromId: 'BVMF:CPLE5', fromYahoo: 'CPLE5.SA', toId: 'BVMF:CPLE3', toYahoo: 'CPLE3.SA', ratio: 1, effective: '2025-12-22', lastTradingDay: '2025-12-19', cashPerShare: 0.7749, cashPayDate: '2025-12-30',
    note: 'Copel (migração ao Novo Mercado): cada PNA virou 1 ON (CPLE3) + 1 PNC resgatada compulsoriamente por R$ 0,7749 (pago em 2025-12-30)',
  },
  {
    kind: 'conversion', fromId: 'BVMF:CPLE11', fromYahoo: 'CPLE11.SA', toId: 'BVMF:CPLE3', toYahoo: 'CPLE3.SA', ratio: 1, effective: '2023-12-26', lastTradingDay: '2023-12-22',
    components: [
      { toId: 'BVMF:CPLE3', ratio: 1 },
      { toId: 'BVMF:CPLE6', ratio: 4 },
    ],
    note: 'Units Copel (CPLE11 = 1 CPLE3 + 4 CPLE6) desfeitas em 2023-12-26 (último pregão 2023-12-22); confirme o rateio do custo entre ON e PNB',
  },
];

const upper = (s: string) => s.trim().toUpperCase();

/** Events whose old code is `key` (instrument id, bare code, Yahoo symbol or old ISIN; case-insensitive). */
export function tickerEventsFrom(key: string): TickerEvent[] {
  const k = upper(key);
  return TICKER_EVENTS.filter(
    (e) => upper(e.fromId) === k || upper(e.fromId.split(':')[1]!) === k || (e.fromYahoo && upper(e.fromYahoo) === k) || (e.isins ?? []).some((i) => upper(i) === k),
  );
}

/** Same-security renames only: old id → current id (follows chains such as A → B → C). */
export function renamedTickerId(id: string): string | undefined {
  let cur = id;
  const seen = new Set<string>();
  for (;;) {
    const e = TICKER_EVENTS.find((x) => x.kind === 'rename' && upper(x.fromId) === upper(cur));
    if (!e || seen.has(e.toId)) break;
    seen.add(e.toId);
    cur = e.toId;
  }
  return cur === id ? undefined : cur;
}

/** All rename pairs (old id → new id), for quick maps. */
export function tickerRenameMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of TICKER_EVENTS) if (e.kind === 'rename') out[e.fromId] = renamedTickerId(e.fromId) ?? e.toId;
  return out;
}

/**
 * The code a listing chain has on `date`: start from the listing's FIRST code and apply, in
 * chronological order and at most once each, the dated events (any kind) effective on or before
 * `date`. 'BVMF:NATU3' → 2019-06-10: NATU3; 2024-07-02: NTCO3; 2025-08-05: NATU3.
 * Undated renames are applied too (same security).
 */
export function tickerIdOn(startId: string, date: ISODate): string {
  let cur = startId;
  const dated = TICKER_EVENTS.filter((e) => e.effective).sort((a, b) => a.effective!.localeCompare(b.effective!));
  for (const e of dated) if (e.effective! <= date && upper(e.fromId) === upper(cur)) cur = e.toId;
  return renamedTickerId(cur) ?? cur;
}
