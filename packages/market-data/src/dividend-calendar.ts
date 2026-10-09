/**
 * Declared-dividend calendar (review R4, M8). The BVC publishes payment dates and installments
 * ("cuotas") only on its website and in company filings (no accessible API), and Yahoo carries ex-dates
 * and amounts but no payment date. A calendar file, kept by the user or the team from the issuers'
 * assembly decisions, fills that gap:
 *
 *   [{ "instrumentId": "XBOG:ECOPETROL", "exDate": "2025-04-07", "payDate": "2025-04-21",
 *      "amount": 214, "note": "cuota 1 de 3" }, ...]
 *
 * Merge rules: Yahoo stays authoritative for ex-dates and amounts. A declared entry within 3 days of a
 * provider dividend adds its payment date (and note). A declared entry with no provider match is added
 * as its own dividend, so an installment the provider missed is not lost.
 */
import type { CurrencyCode, ISODate } from '@pm/core';
import { daysBetween } from './dates';
import { MarketDataError } from './errors';
import type { DividendEvent } from './providers/types';

export interface DeclaredDividend {
  instrumentId: string;
  /** Ex-dividend date. */
  exDate: ISODate;
  payDate?: ISODate;
  /** Per share, in `currency` or the instrument currency. */
  amount: number;
  currency?: CurrencyCode;
  kind?: 'ORDINARY' | 'JCP';
  note?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function validateDeclaredDividends(x: unknown): DeclaredDividend[] {
  if (!Array.isArray(x)) throw new MarketDataError('BAD_REQUEST', 'Dividend calendar must be a JSON array');
  return x.map((d, i) => {
    const e = d as DeclaredDividend;
    const ok =
      e &&
      typeof e.instrumentId === 'string' &&
      /^[A-Z]{2,8}:[A-Z0-9.-]{1,32}$/i.test(e.instrumentId) &&
      ISO.test(String(e.exDate)) &&
      (e.payDate === undefined || ISO.test(String(e.payDate))) &&
      Number.isFinite(e.amount) &&
      e.amount > 0 &&
      (e.payDate === undefined || e.payDate >= e.exDate);
    if (!ok) throw new MarketDataError('BAD_REQUEST', `Dividend calendar entry ${i} is invalid (instrumentId, exDate, amount > 0, payDate >= exDate)`);
    const out: DeclaredDividend = { instrumentId: e.instrumentId.toUpperCase(), exDate: e.exDate, amount: Number(e.amount) };
    if (e.payDate) out.payDate = e.payDate;
    if (e.currency) out.currency = String(e.currency).toUpperCase();
    if (e.kind === 'JCP' || e.kind === 'ORDINARY') out.kind = e.kind;
    if (e.note) out.note = String(e.note).slice(0, 200);
    return out;
  });
}

/** Merge declared dividends of one instrument into the provider's, for ex-dates in [from, to]. */
export function mergeDeclaredDividends(provider: readonly DividendEvent[], declared: readonly DeclaredDividend[], from: ISODate, to: ISODate): DividendEvent[] {
  const pending = declared.filter((d) => d.exDate >= from && d.exDate <= to);
  const used = new Set<DeclaredDividend>();
  const out: DividendEvent[] = provider.map((p) => {
    const m = pending
      .filter((d) => !used.has(d) && Math.abs(daysBetween(p.date, d.exDate)) <= 3)
      .sort((a, b) => Math.abs(daysBetween(p.date, a.exDate)) - Math.abs(daysBetween(p.date, b.exDate)))[0];
    if (!m) return p;
    used.add(m);
    const e: DividendEvent = { ...p };
    if (m.payDate && !e.payDate) e.payDate = m.payDate;
    if (m.kind && !e.kind) e.kind = m.kind;
    const notes = [p.note, m.note, Math.abs(m.amount - p.amount) > 0.005 * p.amount ? `declared amount ${m.amount} differs from provider ${p.amount}` : undefined].filter(Boolean);
    if (notes.length) e.note = notes.join('; ');
    return e;
  });
  for (const d of pending) {
    if (used.has(d)) continue;
    const e: DividendEvent = { date: d.exDate, amount: d.amount, note: [d.note, 'declared (dividend calendar), not reported by the price provider'].filter(Boolean).join('; ') };
    if (d.payDate) e.payDate = d.payDate;
    if (d.kind) e.kind = d.kind;
    if (d.currency) e.currency = d.currency;
    out.push(e);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
