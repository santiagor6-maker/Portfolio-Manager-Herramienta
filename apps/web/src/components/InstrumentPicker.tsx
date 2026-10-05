import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Search, WifiOff } from 'lucide-react';
import clsx from 'clsx';
import type { Instrument } from '@pm/core';
import { searchInstruments } from '../services/marketData';
import type { SearchResult } from '../services/marketTypes';
import { flagEmoji } from '../lib/labels';

/** Accessible combobox for ticker search (server search with offline catalog fallback). */
export function InstrumentPicker({
  value,
  onChange,
  onCreateManual,
  invalid,
  inputId,
}: {
  value?: Instrument;
  onChange: (i: Instrument) => void;
  onCreateManual: (name: string) => void;
  invalid?: boolean;
  inputId?: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (!query) {
      setResults([]);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void searchInstruments(query).then((r) => {
        if (id !== seq.current) return;
        setResults(r.results);
        setOffline(r.offline);
        setLoading(false);
        setActive(0);
      });
    }, 220);
    return () => clearTimeout(timer);
  }, [q, open]);

  const pick = (i: Instrument) => {
    const { origin: _o, providerType: _p, exchangeLabel: _e, ...inst } = i as SearchResult;
    onChange(inst);
    setQ('');
    setOpen(false);
  };

  const options = results.length + (q.trim() ? 1 : 0);

  return (
    <div className="relative">
      {value && !open ? (
        <button
          type="button"
          id={inputId}
          className={clsx('input flex items-center gap-2 text-left', invalid && '!border-neg')}
          onClick={() => setOpen(true)}
        >
          <span aria-hidden>{flagEmoji(value.country)}</span>
          <span className="font-semibold">{value.symbol}</span>
          <span className="text-muted truncate text-xs flex-1">{value.name}</span>
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
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(options - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && open && options) {
                e.preventDefault();
                if (active < results.length) pick(results[active]!);
                else onCreateManual(q.trim());
              } else if (e.key === 'Escape') setOpen(false);
            }}
          />
          {loading && <Loader2 size={15} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted" aria-hidden />}
        </div>
      )}
      {open && q.trim() && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 w-full card !rounded-lg max-h-72 overflow-auto py-1 shadow-lg"
        >
          {offline && (
            <li className="px-3 py-1.5 text-[11px] text-muted flex items-center gap-1.5" aria-hidden>
              <WifiOff size={12} /> {t('picker.offline')}
            </li>
          )}
          {results.map((r, i) => (
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
              <span className="text-[11px] text-muted">{r.exchange}</span>
              <span className="chip">{r.currency}</span>
            </li>
          ))}
          {!loading && results.length === 0 && <li className="px-3 py-2 text-xs text-muted">{t('picker.noResults')}</li>}
          <li
            id={`${listId}-${results.length}`}
            role="option"
            aria-selected={active === results.length}
            className={clsx(
              'px-3 py-2 cursor-pointer flex items-center gap-2 text-[13px] border-t border-line text-accent',
              active === results.length && 'bg-surface-2',
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              onCreateManual(q.trim());
              setOpen(false);
            }}
          >
            <Plus size={14} /> {t('picker.createManual', { name: q.trim() })}
          </li>
        </ul>
      )}
    </div>
  );
}
