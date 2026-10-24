/**
 * W61: every one-click write in the app (Registrar split, Crear aporte, Registrar todos, Aplicar,
 * Rescatar, Registrar pago, Importar…) goes through one guard, so a double click or a second tab
 * cannot record the same event twice:
 * - `once(key, fn)`: while an action with the same key is in flight (and for a moment after it ends),
 *   later calls get the same promise;
 * - `txDedupeKey`: the identity of an event transaction (portfolio, type, instrument, date — plus the
 *   amount for cash movements), checked against the database inside one read-write transaction by
 *   `addTransactionsOnce` (db/repo.ts).
 */
import { useCallback, useRef, useState } from 'react';
import type { Transaction } from '@pm/core';

const inflight = new Map<string, Promise<unknown>>();

/** A click that lands this long after the action finished is still the same double click. */
const SETTLE_MS = 800;

export function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn();
  inflight.set(key, p);
  const release = () => setTimeout(() => inflight.get(key) === p && inflight.delete(key), SETTLE_MS);
  p.then(release, () => inflight.delete(key)); // a failure can be retried at once
  return p;
}

/** Corporate events: one per portfolio, instrument and day whatever the amounts. */
const EVENT_TYPES = new Set<Transaction['type']>(['SPLIT', 'STOCK_DIVIDEND']);

type Keyed = Pick<Transaction, 'portfolioId' | 'type' | 'date'> &
  Partial<Pick<Transaction, 'instrumentId' | 'currency' | 'amount' | 'quantity' | 'toCurrency' | 'toAmount' | 'account' | 'note' | 'subtype'>>;

/**
 * Cash movements are the same only with the same amounts, account, subtype and note: two DARFs paid the
 * same day for the same amount (different code in the note), deposits in two accounts, or a JCP and a
 * dividend of equal value stay distinct.
 */
export function txDedupeKey(t: Keyed): string {
  const base = `${t.portfolioId}|${t.type}|${t.instrumentId ?? ''}|${t.date}`;
  if (EVENT_TYPES.has(t.type)) return base;
  const n = (v: number | undefined) => (v === undefined ? '' : String(Math.round(v * 1e6) / 1e6));
  return `${base}|${t.currency ?? ''}|${n(t.amount)}|${n(t.quantity)}|${t.toCurrency ?? ''}|${n(t.toAmount)}|${t.account ?? ''}|${t.subtype ?? ''}|${t.note ?? ''}`;
}

export const isEventType = (type: Transaction['type']) => EVENT_TYPES.has(type);

/** The same split recorded from the price history and from the provider can be a few days apart. */
export const EVENT_DATE_TOLERANCE_DAYS = 7;

/**
 * Button state for guarded actions: `busy` disables the buttons while `run` is in flight; the lock is
 * also synchronous (a ref), so two clicks dispatched before React re-renders still run the action once.
 */
export function useGuardedAction(): { busy: boolean; run: <T>(key: string, fn: () => Promise<T>) => Promise<T | undefined> } {
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>) => {
    // One action per group at a time: a second click on any button of the group (same frame, before
    // the disabled state renders) is ignored.
    if (active.current) return undefined;
    active.current = true;
    setBusy(true);
    try {
      return await once(key, fn);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
