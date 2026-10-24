/**
 * W61: every one-click write in the app (Registrar split, Crear aporte, Registrar todos, Aplicar,
 * Rescatar, Registrar pago, Importar…) goes through one guard, so a double click or a second tab
 * cannot record the same event twice:
 * - `once(key, fn)`: while an action with the same key is in flight, later calls get the same promise;
 * - `txDedupeKey`: the identity of an event transaction (portfolio, type, instrument, date — plus the
 *   amount for cash movements), checked against the database inside one read-write transaction by
 *   `addTransactionsOnce` (db/repo.ts).
 */
import { useCallback, useRef, useState } from 'react';
import type { Transaction } from '@pm/core';

const inflight = new Map<string, Promise<unknown>>();

export function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Corporate events: one per portfolio, instrument and day whatever the amounts. */
const EVENT_TYPES = new Set<Transaction['type']>(['SPLIT', 'STOCK_DIVIDEND']);

type Keyed = Pick<Transaction, 'portfolioId' | 'type' | 'date'> & Partial<Pick<Transaction, 'instrumentId' | 'currency' | 'amount' | 'quantity' | 'toCurrency' | 'toAmount'>>;

export function txDedupeKey(t: Keyed): string {
  const base = `${t.portfolioId}|${t.type}|${t.instrumentId ?? ''}|${t.date}`;
  if (EVENT_TYPES.has(t.type)) return base;
  const n = (v: number | undefined) => (v === undefined ? '' : String(Math.round(v * 1e6) / 1e6));
  return `${base}|${t.currency ?? ''}|${n(t.amount)}|${n(t.quantity)}|${t.toCurrency ?? ''}|${n(t.toAmount)}`;
}

/**
 * Button state for guarded actions: `busy` disables the buttons while `run` is in flight; the lock is
 * also synchronous (a ref), so two clicks dispatched before React re-renders still run the action once.
 */
export function useGuardedAction(): { busy: boolean; run: <T>(key: string, fn: () => Promise<T>) => Promise<T | undefined> } {
  const [busy, setBusy] = useState(false);
  const active = useRef(0);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>) => {
    active.current++;
    setBusy(true);
    try {
      return await once(key, fn);
    } finally {
      if (--active.current === 0) setBusy(false);
    }
  }, []);
  return { busy, run };
}
