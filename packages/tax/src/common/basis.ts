import type { Instrument, ISODate, Transaction } from '@pm/core';

/**
 * Original acquisition data of securities moved in from another broker (TRANSFER_IN). A transfer
 * between accounts of the same owner is not an acquisition: holding period and fiscal cost must
 * keep the original purchase date and cost.
 */
export interface TransferBasis {
  /** Original purchase date. */
  openDate: ISODate;
  /** Original cost per unit in the transaction currency (fees included). */
  unitCost?: number;
  /** Original total cost in the transaction currency (alternative to unitCost). */
  totalCost?: number;
  /** Exchange rate (tax currency per unit) actually used at the original purchase, if known. */
  fxRate?: number;
  /** Parsed from free text with only a year: date approximated as 31-Dec. */
  approximate?: boolean;
  /** Parsed from free text: a proposal that must be confirmed before use. */
  proposal?: boolean;
}

/** Map transaction id -> original basis, supplied by the UI/importer. */
export type TransferBasisMap = Record<string, TransferBasis>;

/**
 * Structured note token accepted until the core contract has a field for it, e.g.
 * `[costo: 2019-03-15 @ 50]`, `[cost: 2019-03-15 @ 50.25 fx 3200]`, `[custo: 2019-03-15 @ 50,25]`.
 */
const NOTE_RE = /\[(?:costo|cost|custo)\s*:\s*(\d{4}-\d{2}-\d{2})\s*@\s*([\d.,]+)(?:\s*(?:fx|trm|ptax)\s*([\d.,]+))?\s*\]/i;

/**
 * Locale-aware number parsing: the LAST separator followed by 1-2 digits (or any count when the
 * other separator also appears) is the decimal mark; a separator followed by exactly 3 digits in a
 * group pattern is a thousands separator. '1,000.50' -> 1000.5; '1.000,50' -> 1000.5;
 * '50,25' -> 50.25; '1,000' -> 1000; '1.000' -> 1000; '1234.5' -> 1234.5.
 * Returns undefined for malformed input.
 */
export function parseLocaleNumber(raw: string): number | undefined {
  const s = raw.trim().replace(/\s/g, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return undefined;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimal: '.' | ',' | undefined;
  if (lastDot >= 0 && lastComma >= 0) decimal = lastDot > lastComma ? '.' : ',';
  else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const groups = s.split(sep);
    const thousandsPattern = groups.length > 1 && groups[0]!.length >= 1 && groups[0]!.length <= 3 && groups.slice(1).every((g) => g.length === 3);
    decimal = thousandsPattern ? undefined : sep;
    if (!thousandsPattern && groups.length > 2) return undefined;
  }
  const thousands = decimal === '.' ? ',' : decimal === ',' ? '.' : s.includes('.') ? '.' : ',';
  const normalized = s.split(thousands).join('').replace(decimal ?? '#', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Loose free-text hint, e.g. "bought 2019 at 50", "comprado em 2019-03-15 a 50", "comprada el 2019 por 50".
 * Never applied automatically: returned as a proposal for the user to confirm.
 */
const LOOSE_RE = /(?:bought|purchased|comprad[oa]s?|adquirid[oa]s?|compra)\s*(?:on|in|en|em|el|no|na)?\s*(\d{4}(?:-\d{2}-\d{2})?)\s*(?:at|a|@|por|for)\s*(?:US\$|R\$|\$|COP|USD|BRL)?\s*([\d.,]+)(?!\s*(?:%|por\s*ciento|por\s*cento|percent))/i;

export function transferBasisOf(tx: Transaction, map?: TransferBasisMap): TransferBasis | undefined {
  const fromMap = map?.[tx.id];
  if (fromMap) return fromMap;
  const m = tx.note ? NOTE_RE.exec(tx.note) : null;
  if (m) {
    const unit = parseLocaleNumber(m[2]!);
    if (unit === undefined) return undefined;
    return { openDate: m[1]!, unitCost: unit, fxRate: m[3] ? parseLocaleNumber(m[3]) : undefined };
  }
  const l = tx.note ? LOOSE_RE.exec(tx.note) : null;
  if (l) {
    const d = l[1]!;
    const unit = parseLocaleNumber(l[2]!);
    if (unit === undefined) return undefined;
    return { openDate: d.length === 4 ? `${d}-12-31` : d, unitCost: unit, approximate: d.length === 4, proposal: true };
  }
  return undefined;
}

export interface ResolvedBasis {
  /** Basis to apply (explicit map, structured note, or a confirmed proposal). */
  basis?: TransferBasis;
  /** Free-text proposal not applied (needs user confirmation). */
  proposal?: TransferBasis;
}

/** Applies explicit/structured bases; free-text proposals only when `acceptProposals`. */
export function resolveTransferBasis(tx: Transaction, map?: TransferBasisMap, acceptProposals = false): ResolvedBasis {
  const b = transferBasisOf(tx, map);
  if (!b) return {};
  if (b.proposal && !acceptProposals) return { proposal: b };
  return { basis: b };
}

/** Total original cost for `quantity` units, or undefined when unknown. */
export function basisTotalCost(b: TransferBasis, quantity: number): number | undefined {
  if (b.totalCost !== undefined) return b.totalCost;
  if (b.unitCost !== undefined) return b.unitCost * quantity;
  return undefined;
}

/** Colombian listed companies with several share classes (ordinary/preferred) on the BVC. */
const BVC_ISSUERS: Record<string, string> = {
  BCOLOMBIA: 'BANCOLOMBIA',
  PFBCOLOM: 'BANCOLOMBIA',
  CIBEST: 'GRUPO CIBEST',
  PFCIBEST: 'GRUPO CIBEST',
  GRUPOAVAL: 'GRUPO AVAL',
  PFAVAL: 'GRUPO AVAL',
  GRUPOSURA: 'GRUPO SURA',
  PFGRUPSURA: 'GRUPO SURA',
  GRUPOARGOS: 'GRUPO ARGOS',
  PFGRUPOARG: 'GRUPO ARGOS',
  CORFICOLCF: 'CORFICOLOMBIANA',
  PFCORFICOL: 'CORFICOLOMBIANA',
  DAVIVIENDA: 'DAVIVIENDA',
  PFDAVVNDA: 'DAVIVIENDA',
};

/** B3 root ticker: PETR3/PETR4 -> PETR, TAEE11 -> TAEE, ITSA4F -> ITSA. */
export function b3Root(symbol: string): string {
  const m = /^([A-Z]{4})\d{1,2}F?$/.exec(symbol.toUpperCase());
  return m ? m[1]! : symbol.toUpperCase();
}

/**
 * Issuer (company) key used where the law looks at the company, not the share class:
 * Lei 15.270/2025 (dividends from the same legal entity) and Art. 36-1 ET (% of the company's
 * outstanding shares). Override per instrument id when the default is wrong (e.g. CNPJ).
 */
export function issuerKey(inst: Instrument | undefined, id: string, overrides?: Record<string, string>): string {
  const o = overrides?.[id];
  if (o) return o;
  if (!inst) return id;
  if (inst.exchange === 'BVMF') return `BVMF:${b3Root(inst.symbol)}`;
  if (inst.exchange === 'XBOG') return `XBOG:${BVC_ISSUERS[inst.symbol.toUpperCase()] ?? inst.symbol.toUpperCase()}`;
  return inst.id;
}
