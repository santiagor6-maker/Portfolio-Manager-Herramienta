/**
 * Corporate actions (I33): turn the broker's description of a spin-off / merger / symbol change into a
 * ready-to-confirm @pm/core transaction (SPLIT + subtype SPINOFF / MERGER / TICKER_CHANGE with
 * targetInstrumentId, ratio and costFraction), so the user confirms with one click instead of
 * rebuilding the event by hand.
 *
 * Spin-off cost fraction: when `options.referencePrice` gives both prices on the ex-date, the
 * market-value split is used (f = r·Pchild / (Pparent + r·Pchild)), the usual default when the issuer
 * publishes nothing else; otherwise it is asked (`missing: ['costFraction']`). The user's answer wins.
 */
import { TICKER_EVENTS, tickerRenameMap, type Instrument, type Transaction } from '@pm/core';
import type { InstrumentResolver } from './instruments';
import type { CorporateActionAnswer, CorporateActionSuggestion, ImportOptions, InstrumentHint } from './types';
import { hashString, round } from './util';

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

export interface IbkrCorporateInfo {
  kind: CorporateActionSuggestion['kind'];
  parent?: { symbol: string; isin?: string };
  target?: { symbol: string; name?: string; isin?: string };
  ratio?: number;
}

/**
 * IBKR corporate-action descriptions:
 *   "MMM(US88579Y1010) SPINOFF  1 FOR 4 (SOLV, SOLVENTUM CORP, US83444M1018)"
 *   "ATVI(US00507V1098) MERGED(ACQUISITION) WITH US5949181045 0.5 FOR 1 (MSFT, MICROSOFT CORP, US5949181045)"
 *   "FB(US30303M1027) CUSIP/ISIN CHANGE TO (US30303M1027) (META, META PLATFORMS INC, US30303M1027)"
 */
export function parseIbkrCorporate(desc: string, code = ''): IbkrCorporateInfo {
  const d = desc.replace(/\s+/g, ' ').trim();
  const c = code.toUpperCase();
  let kind: IbkrCorporateInfo['kind'] = 'other';
  if (c === 'SO' || /\bspin ?off\b/i.test(d)) kind = 'spinoff';
  else if (['TC', 'TO', 'TM'].includes(c) || /\bmerge[dr]|acquisition|tendered/i.test(d)) kind = 'merger';
  else if (c === 'IC' || /isin change|cusip\/isin change|symbol change|name change/i.test(d)) kind = 'symbol_change';
  const out: IbkrCorporateInfo = { kind };
  const p = /^([A-Z0-9.]+)\(([A-Z]{2}[A-Z0-9]{9}\d)\)/.exec(d);
  if (p) out.parent = { symbol: p[1]!, isin: p[2]! };
  const t = /\(([A-Z0-9.]+),\s*([^,()]+?)(?:,\s*([A-Z]{2}[A-Z0-9]{9}\d))?\)\s*$/.exec(d);
  if (t) {
    out.target = { symbol: t[1]! };
    if (t[2]) out.target.name = t[2].trim();
    if (t[3] && ISIN.test(t[3])) out.target.isin = t[3];
  }
  const r = /(\d+(?:\.\d+)?)\s+FOR\s+(\d+(?:\.\d+)?)/i.exec(d);
  if (r && Number(r[2]) > 0) out.ratio = Number(r[1]) / Number(r[2]);
  return out;
}

export interface ProposeContext {
  options: ImportOptions;
  resolver: InstrumentResolver;
  source: string;
  /** Position of an instrument just before a date (existing + imported transactions). */
  positionBefore: (instrumentId: string, date: string) => number;
  existingHashes: Set<string>;
}

const SUBTYPE: Partial<Record<CorporateActionSuggestion['kind'], string>> = {
  spinoff: 'SPINOFF',
  merger: 'MERGER',
  conversion: 'MERGER',
  symbol_change: 'TICKER_CHANGE',
};

function resolveId(pc: ProposeContext, hint: InstrumentHint | undefined, answer: string | undefined): { id?: string; inst?: Instrument; isNew?: boolean } {
  if (answer) {
    const r = pc.resolver.resolve({ id: answer });
    return r && !('error' in r) ? { id: r.instrument.id, inst: r.instrument, isNew: r.isNew } : { id: answer };
  }
  if (!hint) return {};
  const r = pc.resolver.resolve(hint);
  return r && !('error' in r) ? { id: r.instrument.id, inst: r.instrument, isNew: r.isNew } : {};
}

/** Fill `proposal` on every suggestion it can; returns the transactions to apply now (accepted and complete). */
export function proposeCorporateActions(suggestions: CorporateActionSuggestion[], pc: ProposeContext): { line: number; tx: Transaction; instruments: Instrument[] }[] {
  const applied: { line: number; tx: Transaction; instruments: Instrument[] }[] = [];
  const accept = pc.options.acceptCorporateActions;
  for (const ca of suggestions) {
    const subtype = SUBTYPE[ca.kind];
    if (!subtype) continue;
    const ans: CorporateActionAnswer = pc.options.corporateActionAnswers?.[ca.line] ?? {};
    // Legs (B3 Movimentação): 'out' = parent, 'in' = target.
    const outLeg = ca.legs.find((l) => l.direction === 'out');
    const inLeg = ca.legs.find((l) => l.direction === 'in');
    const parentHint = ca.parent ?? (outLeg?.symbol ? { symbol: outLeg.symbol, ...(ca.currency ? { currency: ca.currency } : {}) } : undefined);
    const targetHint = ca.target ?? (inLeg?.symbol ? { symbol: inLeg.symbol, ...(inLeg.name ? { name: inLeg.name } : {}), ...(ca.currency ? { currency: ca.currency } : {}) } : undefined);
    const parent = resolveId(pc, parentHint, ans.parentId);
    const target = resolveId(pc, targetHint, ans.targetId);
    const missing: NonNullable<CorporateActionSuggestion['proposal']>['missing'] = [];
    if (!parent.id) missing.push('parent');
    if (!target.id) missing.push('target');
    let ratio = ans.ratio ?? ca.ratio;
    if (ratio === undefined && parent.id) {
      const received = ca.receivedQuantity ?? inLeg?.quantity;
      // Merger with both legs: new shares per old share straight from the statement.
      if (received !== undefined && subtype !== 'SPINOFF' && outLeg?.quantity) ratio = received / outLeg.quantity;
      else if (received !== undefined) {
        const held = pc.positionBefore(parent.id, ca.date);
        if (held > 0) ratio = received / held;
      }
    }
    if (ratio !== undefined) ratio = round(ratio, 10);
    if (ratio === undefined || !(ratio > 0)) missing.push('ratio');
    let costFraction: number | undefined;
    let costFractionSource: 'answer' | 'market' | undefined;
    if (subtype === 'SPINOFF') {
      if (ans.costFraction !== undefined && ans.costFraction >= 0 && ans.costFraction <= 1) {
        costFraction = ans.costFraction;
        costFractionSource = 'answer';
      } else if (ratio && parentHint && targetHint && pc.options.referencePrice) {
        const pp = pc.options.referencePrice(parentHint, ca.date);
        const pt = pc.options.referencePrice(targetHint, ca.date);
        if (pp && pt && pp > 0 && pt > 0) {
          costFraction = round((ratio * pt) / (pp + ratio * pt), 6);
          costFractionSource = 'market';
        }
      }
      if (costFraction === undefined) missing.push('costFraction');
    }
    if (!parent.id || !target.id) {
      ca.proposal = { instruments: [], missing, applied: false };
      continue;
    }
    const currency = parent.inst?.currency ?? ca.currency ?? target.inst?.currency ?? 'USD';
    // Table events are the same event whatever file revealed them: one hash for all sources.
    const keyBase = [ca.id ? 'event' : pc.source, 'corp', ca.date, subtype, parent.id, target.id, ratio ?? ''].join('|');
    const importHash = hashString(keyBase);
    const tx: Transaction = {
      id: pc.options.idFactory ? pc.options.idFactory(importHash, 0) : `imp-${importHash}`,
      portfolioId: pc.options.portfolioId,
      date: ca.date,
      type: 'SPLIT',
      subtype,
      instrumentId: parent.id,
      targetInstrumentId: target.id,
      currency,
      note: ca.description,
      source: pc.source,
      importHash,
    };
    if (ratio !== undefined) tx.ratio = ratio;
    let cash: { amount: number; payDate?: string } | undefined;
    if (ca.cashPerShare) {
      const held = ca.heldQuantity ?? pc.positionBefore(parent.id, ca.date);
      if (held > 0) {
        cash = { amount: round(ca.cashPerShare * held, 2), ...(ca.cashPayDate ? { payDate: ca.cashPayDate } : {}) };
        tx.amount = cash.amount;
        tx.note = `${tx.note} · R$ ${ca.cashPerShare} por ação${ca.cashPayDate ? `, pago em ${ca.cashPayDate}` : ''}`;
      }
    }
    if (costFraction !== undefined) tx.costFraction = costFraction;
    const account = pc.options.account ?? ca.account;
    if (account) tx.account = account;
    const instruments = [parent, target].filter((x) => x.isNew && x.inst).map((x) => x.inst!);
    const already = pc.existingHashes.has(importHash);
    const wanted = accept === 'all' || (Array.isArray(accept) && ((ca.line > 0 && accept.includes(ca.line)) || (!!ca.id && accept.includes(ca.id))));
    const proposal: NonNullable<CorporateActionSuggestion['proposal']> = { transaction: tx, instruments, missing, applied: false };
    if (costFractionSource) proposal.costFractionSource = costFractionSource;
    if (cash) proposal.cash = cash;
    if (already) proposal.alreadyImported = true;
    if (wanted && !missing.length && !already) {
      proposal.applied = true;
      applied.push({ line: ca.line, tx, instruments });
    }
    ca.proposal = proposal;
  }
  return applied;
}

/**
 * Conversions and mergers of the shared @pm/core table (I44) that affect a holding: NATU3 → NTCO3 (2019),
 * NTCO3 → NATU3 (2025), BRFS3 → 0,8521 MBRF3, CPLE6 → CPLE5 → CPLE3 + R$ 0,7749, AXIA5/AXIA6 → 1,1 AXIA3…
 * For each event effective after a position in the parent (existing + imported, renames included),
 * a suggestion like the broker's own corporate actions: one click applies it. Events are followed in
 * chronological order, so a chain (CPLE6 → CPLE5 → CPLE3) is proposed step by step with the shares the
 * previous step delivers. Pure renames are not proposed (same security; @pm/core canonicalizes ids).
 */
export function tableEventSuggestions(
  base: Transaction[],
  imported: Transaction[],
  balanceOn: (ids: string[], date: string) => number,
): CorporateActionSuggestion[] {
  const out: CorporateActionSuggestion[] = [];
  const renames = tickerRenameMap();
  const family = (id: string) => [id, ...Object.keys(renames).filter((k) => renames[k] === id)];
  const lastImported = imported.reduce((a, t) => (t.date > a ? t.date : a), '');
  const touched = new Set(imported.map((t) => t.instrumentId).filter(Boolean) as string[]);
  const virtual = new Map<string, number>();
  const events = TICKER_EVENTS.filter((e) => e.kind !== 'rename' && e.effective && !e.components).sort((a, b) => a.effective!.localeCompare(b.effective!));
  for (const e of events) {
    const fam = family(e.fromId);
    const done = base.some((t) => t.type === 'SPLIT' && t.instrumentId && fam.includes(t.instrumentId) && t.targetInstrumentId && family(e.toId).includes(t.targetInstrumentId));
    if (done) continue;
    const before = e.lastTradingDay ?? new Date(Date.parse(`${e.effective}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const held = balanceOn(fam, before) + (virtual.get(e.fromId) ?? 0);
    if (held <= 1e-9) continue;
    const relevant = fam.some((id) => touched.has(id)) || virtual.has(e.fromId) || lastImported >= e.effective!;
    if (!relevant) continue;
    const heldId = fam.find((id) => base.some((t) => t.instrumentId === id)) ?? e.fromId;
    const sym = (id: string) => id.split(':')[1]!;
    const s: CorporateActionSuggestion = {
      line: 0,
      id: `event:${e.fromId}>${e.toId}@${e.effective}`,
      date: e.effective!,
      kind: e.kind === 'merger' ? 'merger' : 'conversion',
      description: e.note,
      legs: [
        { direction: 'out', symbol: sym(heldId), quantity: held },
        { direction: 'in', symbol: sym(e.toId), quantity: round(held * e.ratio, 8) },
      ],
      parent: { id: heldId },
      target: { id: e.toId },
      ratio: e.ratio,
      heldQuantity: held,
    };
    if (e.cashPerShare) s.cashPerShare = e.cashPerShare;
    if (e.cashPayDate) s.cashPayDate = e.cashPayDate;
    out.push(s);
    virtual.set(e.fromId, (virtual.get(e.fromId) ?? 0) - held);
    virtual.set(e.toId, (virtual.get(e.toId) ?? 0) + held * e.ratio);
  }
  return out;
}
