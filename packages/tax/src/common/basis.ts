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
}

/** Map transaction id -> original basis, supplied by the UI/importer. */
export type TransferBasisMap = Record<string, TransferBasis>;

/**
 * Structured note token accepted until the core contract has a field for it, e.g.
 * `[costo: 2019-03-15 @ 50]`, `[cost: 2019-03-15 @ 50.25 fx 3200]`, `[custo: 2019-03-15 @ 50,25]`.
 */
const NOTE_RE = /\[(?:costo|cost|custo)\s*:\s*(\d{4}-\d{2}-\d{2})\s*@\s*([\d.,]+)(?:\s*(?:fx|trm|ptax)\s*([\d.,]+))?\s*\]/i;

function num(s: string): number {
  // '1.234,56' -> 1234.56 ; '50,5' -> 50.5 ; '1234.5' -> 1234.5
  if (s.includes(',') && s.includes('.')) return Number(s.replace(/\./g, '').replace(',', '.'));
  return Number(s.replace(',', '.'));
}

export function transferBasisOf(tx: Transaction, map?: TransferBasisMap): TransferBasis | undefined {
  const fromMap = map?.[tx.id];
  if (fromMap) return fromMap;
  const m = tx.note ? NOTE_RE.exec(tx.note) : null;
  if (!m) return undefined;
  return { openDate: m[1]!, unitCost: num(m[2]!), fxRate: m[3] ? num(m[3]) : undefined };
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
