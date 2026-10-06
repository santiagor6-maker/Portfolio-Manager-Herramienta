import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Search, WifiOff } from 'lucide-react';
import clsx from 'clsx';
import type { Instrument } from '@pm/core';
import { searchInstruments } from '../services/marketData';
import type { SearchResult } from '../services/marketClient';
import { flagEmoji } from '../lib/labels';
import { exchangeLabel } from '../lib/exchanges';

export interface ManualRequest {
  name: string;
  /** A quoted instrument whose symbol matches what the user typed (asks for confirmation). */
  conflict?: Instrument;
  /** Fixed-income template (CDT, CDB...) to prefill the manual instrument. */
  template?: Instrument;
}

function strip(r: SearchResult): Instrument {
  const { origin: _o, providerType: _p, exchangeLabel: _e, template: _t, note: _n, renamedFrom: _r, ...inst } = r as SearchResult & {
    template?: boolean;
    note?: string;
    renamedFrom?: unknown;
  };
  return inst;
}

/**
 * Accessible combobox for ticker search (server search with offline catalog fallback).
 * Never creates anything while a search is running: Enter waits for results and picks an exact
 * symbol match (or the highlighted row). Creating a manual instrument is an explicit option that
 * only appears once results are in.
 */
export function InstrumentPicker({
  value,
  onChange,
  onCreateManual,
  invalid,
  inputId,
}: {
  value?: Instrument;
  onChange: (i: Instrument) => void;
  onCreateManual: (req: ManualRequest) => void;
  invalid?: boolean;
  inputId?: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [resultsFor, setResultsFor] = useState('');
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [active, setActive] = useState(0);
  const pendingEnter = useRef(false);
  const listId = useId();
  const seq = useRef(0);

  const query = q.trim();
  const settled = !loading && resultsFor === query && query !== '';

  const pick = (r: SearchResult) => {
    if ((r as SearchResult & { template?: boolean }).template || r.origin === 'template') {
      onCreateManual({ name: r.name, template: strip(r) });
    } else onChange(strip(r));
    setQ('');
    setOpen(false);
  };

  const exactMatch = (list: SearchResult[]) => list.find((r) => r.symbol.toUpperCase() === query.toUpperCase() && r.origin !== 'template');

  useEffect(() => {
    if (!open) return;
    if (!query) {
      setResults([]);
      setResultsFor('');
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void searchInstruments(query).then((r) => {
        if (id !== seq.current) return;
        // Exact symbol matches first.
        const sorted = [...r.results].sort((a, b) => Number(b.symbol.toUpperCase() === query.toUpperCase()) - Number(a.symbol.toUpperCase() === query.toUpperCase()));
        setResults(sorted);
        setResultsFor(query);
        setOffline(r.offline);
        setLoading(false);
        setActive(0);
        if (pendingEnter.current) {
          pendingEnter.current = false;
          const ex = exactMatch(sorted);
          if (ex) pick(ex);
        }
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const showCreate = settled;
  const options = (settled ? results.length : 0) + (showCreate ? 1 : 0);
  const createManual = () => onCreateManual({ name: query, conflict: exactMatch(results) ? strip(exactMatch(results)!) : undefined });

  return (
    <div className="relative">
      {value && !open ? (
        <button type="button" id={inputId} className={clsx('input flex items-center gap-2 text-left', invalid && '!border-neg')} onClick={() => setOpen(true)}>
          <span aria-hidden>{flagEmoji(value.country)}</span>
          <span className="font-semibold">{value.symbol}</span>
          <span className="text-muted truncate text-xs flex-1">{value.name}</span>
          <span className="text-[11px] text-muted">{exchangeLabel(value.exchange)}</span>
          <span className="chip">{value.currency}</span>
        </button>
      ) : (
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input
            id={inputId}
            role="combobox"
            aria-expanded={open && options > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-invalid={invalid}
            aria-busy={loading}
            aria-activedescendant={open && options ? `${listId}-${active}` : undefined}
            className="input !pl-8"
            placeholder={t('picker.placeholder')}
            value={q}
            autoFocus={!!value}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              pendingEnter.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(options - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (!settled) {
                  // Results not in yet: remember the intent, pick an exact match when they arrive.
                  pendingEnter.current = !!query;
                  return;
                }
                if (active < results.length) pick(results[active]!);
                else createManual();
              } else if (e.key === 'Escape') setOpen(false);
            }}
          />
          {loading && <Loader2 size={15} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted" aria-hidden />}
        </div>
      )}
      {open && query && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 w-full card !rounded-lg max-h-72 overflow-auto py-1 shadow-lg">
          {loading && (
            <li className="px-3 py-2 text-xs text-muted flex items-center gap-2" aria-live="polite">
              <Loader2 size={12} className="animate-spin" /> {t('picker.searching')}
            </li>
          )}
          {settled && offline && (
            <li className="px-3 py-1.5 text-[11px] text-muted flex items-center gap-1.5" aria-hidden>
              <WifiOff size={12} /> {t('picker.offline')}
            </li>
          )}
          {settled &&
            results.map((r, i) => (
              <li
                key={r.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={clsx('px-3 py-2 cursor-pointer flex items-center gap-2 text-[13px]', i === active && 'bg-surface-2')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span aria-hidden>{flagEmoji(r.country)}</span>
                <span className="font-semibold w-24 truncate">{r.symbol}</span>
                <span className="flex-1 truncate text-ink-2">{r.name}</span>
                <span className="text-[11px] text-muted whitespace-nowrap">{r.origin === 'template' ? t('picker.template') : exchangeLabel(r.exchange)}</span>
                <span className="chip">{r.currency}</span>
              </li>
            ))}
          {settled && results.length === 0 && <li className="px-3 py-2 text-xs text-muted">{t('picker.noResults')}</li>}
          {showCreate && (
            <li
              id={`${listId}-${results.length}`}
              role="option"
              aria-selected={active === results.length}
              className={clsx('px-3 py-2 cursor-pointer flex items-center gap-2 text-[13px] border-t border-line text-accent', active === results.length && 'bg-surface-2')}
              onMouseDown={(e) => {
                e.preventDefault();
                createManual();
                setOpen(false);
              }}
            >
              <Plus size={14} /> {t('picker.createManual', { name: query })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
