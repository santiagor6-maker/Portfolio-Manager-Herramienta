/**
 * Importer round-2 review panels: format confirmation, possible duplicates, unknown securities
 * (securityMap), corporate events (incorporação/cisão...) and instrument updates.
 * Each panel collects answers; the Import page re-runs the import with them.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { AlertTriangle, Copy, GitMerge, HelpCircle, RefreshCw } from 'lucide-react';
import type { Instrument } from '@pm/core';
import { Card } from './ui';
import { InstrumentPicker } from './InstrumentPicker';
import { useFmt } from '../store/app';
import { formatDate } from '../lib/format';
import type { DateFormat, ImportAnswers, ImportResult, NumberFormat } from '../services/importers';
import { unresolvedSecurities } from '../services/importers';
import { MANUAL_EXCHANGES, exchangeLabel } from '../lib/exchanges';

export function ConfirmFormats({ result, onApply, busy }: { result: ImportResult; onApply: (a: Pick<ImportAnswers, 'dateFormat' | 'numberFormat'>) => void; busy: boolean }) {
  const { t } = useTranslation();
  const reqs = result.needsConfirmation ?? [];
  const [choice, setChoice] = useState<Record<string, string>>(() => Object.fromEntries(reqs.map((r) => [r.kind, String(r.suggested)])));
  if (!reqs.length) return null;
  return (
    <Card className="mb-3 !border-warn/40" title={<span className="flex items-center gap-2"><HelpCircle size={15} className="text-warn" /> {t('impr.confirmTitle')}</span>} subtitle={t('impr.confirmSub')}>
      <div className="flex flex-col gap-4" data-testid="import-confirm-formats">
        {reqs.map((r) => (
          <fieldset key={r.kind}>
            <legend className="font-semibold text-[13px] mb-1">{t(`impr.kind.${r.kind}`)}</legend>
            <p className="text-xs text-muted mb-2">{r.reason}</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {r.candidates.map((c) => (
                <label key={String(c)} className={clsx('btn btn-sm', choice[r.kind] === c && '!border-accent !text-accent !bg-accent-soft')}>
                  <input type="radio" className="sr-only" name={r.kind} checked={choice[r.kind] === c} onChange={() => setChoice((x) => ({ ...x, [r.kind]: String(c) }))} />
                  {t(`impr.fmt.${c}`, { defaultValue: String(c) })}
                  {c === r.suggested && <span className="text-[10px] text-muted">({t('impr.suggested')})</span>}
                </label>
              ))}
            </div>
            <div className="overflow-x-auto rounded border border-line">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t('imp.line')}</th>
                    <th>{t('impr.inFile')}</th>
                    {r.candidates.map((c) => (
                      <th key={String(c)} className={clsx(choice[r.kind] === c && '!text-accent')}>
                        {t(`impr.fmt.${c}`, { defaultValue: String(c) })}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.samples.slice(0, 6).map((s, i) => (
                    <tr key={i}>
                      <td className="num text-muted">{s.line}</td>
                      <td className="num">{s.value}</td>
                      {r.candidates.map((c) => (
                        <td key={String(c)} className={clsx('num', choice[r.kind] === c && 'font-semibold')}>
                          {s.readings[String(c)] ?? '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted mt-1">{t('impr.affected', { count: r.affectedLines.length })}</p>
          </fieldset>
        ))}
        <div className="flex justify-end">
          <button
            className="btn btn-primary"
            disabled={busy}
            data-testid="import-apply-formats"
            onClick={() => onApply({ dateFormat: choice.dateFormat as DateFormat | undefined, numberFormat: choice.numberFormat as NumberFormat | undefined })}
          >
            <RefreshCw size={14} /> {t('impr.apply')}
          </button>
        </div>
      </div>
    </Card>
  );
}

export function PossibleDuplicates({ result, accepted, onApply, busy }: { result: ImportResult; accepted: number[]; onApply: (lines: number[]) => void; busy: boolean }) {
  const { t } = useTranslation();
  const f = useFmt();
  const rows = result.rows.filter((r) => r.status === 'possible_duplicate');
  const [sel, setSel] = useState<Set<number>>(new Set(accepted));
  if (!rows.length) return null;
  return (
    <Card className="mb-3" title={<span className="flex items-center gap-2"><Copy size={15} className="text-warn" /> {t('impr.dupTitle', { count: rows.length })}</span>} subtitle={t('impr.dupSub')} bodyClassName="!p-0">
      <div className="max-h-[260px] overflow-auto" data-testid="import-possible-dups">
        <table className="table table-compact">
          <thead>
            <tr>
              <th className="w-8">
                <input type="checkbox" aria-label={t('tx.selectAll')} checked={sel.size === rows.length} onChange={(e) => setSel(new Set(e.target.checked ? rows.map((r) => r.line) : []))} />
              </th>
              <th>{t('imp.line')}</th>
              <th>{t('tx.date')}</th>
              <th>{t('tx.typeLabel')}</th>
              <th>{t('tx.instrument')}</th>
              <th>{t('impr.similarTo')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = (r as typeof r & { duplicateOf?: { source?: string; date: string; line?: number; inFile: boolean } }).duplicateOf;
              return (
                <tr key={r.line}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t('impr.include', { line: r.line })}
                      checked={sel.has(r.line)}
                      onChange={(e) => {
                        const n = new Set(sel);
                        if (e.target.checked) n.add(r.line);
                        else n.delete(r.line);
                        setSel(n);
                      }}
                    />
                  </td>
                  <td className="num text-muted">{r.line}</td>
                  <td className="num">{r.transaction ? formatDate(r.transaction.date, f.locale, 'short') : '—'}</td>
                  <td>{r.transaction ? t(`tx.type.${r.transaction.type}`) : '—'}</td>
                  <td className="font-medium">{r.transaction?.instrumentId?.split(':').pop() ?? ''}</td>
                  <td className="text-xs text-ink-2">
                    {d ? (d.inFile ? t('impr.dupInFile', { line: d.line }) : t('impr.dupExisting', { source: d.source ?? '—', date: formatDate(d.date, f.locale, 'short') })) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end p-3 border-t border-line">
        <button className="btn btn-sm" disabled={busy} onClick={() => onApply([...sel])} data-testid="import-accept-dups">
          {t('impr.includeSelected', { count: sel.size })}
        </button>
      </div>
    </Card>
  );
}

export function SecurityMapPrompt({ result, current, onApply, busy }: { result: ImportResult; current: Record<string, string>; onApply: (map: Record<string, string>) => void; busy: boolean }) {
  const { t } = useTranslation();
  const items = unresolvedSecurities(result);
  const [map, setMap] = useState<Record<string, string>>(current);
  const [picked, setPicked] = useState<Record<string, Instrument>>({});
  if (!items.length) return null;
  return (
    <Card className="mb-3 !border-warn/40" title={<span className="flex items-center gap-2"><AlertTriangle size={15} className="text-warn" /> {t('impr.secTitle', { count: items.length })}</span>} subtitle={t('impr.secSub')}>
      <ul className="flex flex-col gap-3" data-testid="import-security-map">
        {items.map((it) => (
          <li key={it.key} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2 items-center">
            <div className="text-[13px]">
              <span className="font-mono font-semibold">{it.key}</span>
              <div className="text-xs text-muted">{t(`impr.sec.${it.code}`)}</div>
            </div>
            {it.code === 'EXCHANGE_REQUIRED' ? (
              <select className="select" aria-label={t('impr.exchangeFor', { key: it.key })} value={map[it.key] ?? ''} onChange={(e) => setMap((m) => ({ ...m, [it.key]: e.target.value }))}>
                <option value="">—</option>
                {MANUAL_EXCHANGES.filter((x) => x !== 'MANUAL').map((x) => (
                  <option key={x} value={x}>
                    {exchangeLabel(x)} ({x})
                  </option>
                ))}
              </select>
            ) : (
              <InstrumentPicker
                inputId={`sec-${it.key}`}
                value={picked[it.key]}
                onChange={(i) => {
                  setPicked((p) => ({ ...p, [it.key]: i }));
                  setMap((m) => ({ ...m, [it.key]: i.id }));
                }}
                onCreateManual={() => undefined}
              />
            )}
          </li>
        ))}
      </ul>
      <div className="flex justify-end mt-3">
        <button className="btn btn-primary" disabled={busy || !Object.values(map).some(Boolean)} onClick={() => onApply(Object.fromEntries(Object.entries(map).filter(([, v]) => v)))}>
          <RefreshCw size={14} /> {t('impr.apply')}
        </button>
      </div>
    </Card>
  );
}

export interface CaChoice {
  include: boolean;
  costFraction: string;
}

export function CorporateEvents({
  result,
  choices,
  onChange,
  updates,
  onUpdates,
}: {
  result: ImportResult;
  choices: Record<number, CaChoice>;
  onChange: (c: Record<number, CaChoice>) => void;
  updates: Set<string>;
  onUpdates: (s: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const f = useFmt();
  const cas = result.corporateActions ?? [];
  const ups = result.instrumentUpdates ?? [];
  if (!cas.length && !ups.length) return null;
  return (
    <Card className="mb-3" title={<span className="flex items-center gap-2"><GitMerge size={15} className="text-accent" /> {t('impr.caTitle')}</span>} subtitle={t('impr.caSub')}>
      {cas.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="import-corporate-actions">
          {cas.map((c) => {
            const ch = choices[c.line] ?? { include: true, costFraction: '' };
            return (
              <li key={c.line} className="rounded-lg border border-line p-3 text-[13px]">
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={ch.include} onChange={(e) => onChange({ ...choices, [c.line]: { ...ch, include: e.target.checked } })} className="mt-1" />
                  <span className="flex-1">
                    <span className="chip mr-2">{t(`impr.caKind.${c.kind}`)}</span>
                    <span className="num text-xs text-muted">{formatDate(c.date, f.locale, 'short')}</span>
                    <div className="mt-1">{c.description}</div>
                    <div className="text-xs text-ink-2 mt-1">
                      {c.legs.map((l, i) => (
                        <span key={i} className="mr-3">
                          {l.direction === 'out' ? '−' : '+'} {l.quantity ?? ''} {l.symbol ?? l.name}
                        </span>
                      ))}
                    </div>
                  </span>
                </label>
                {c.kind === 'spinoff' && ch.include && (
                  <label className="flex items-center gap-2 mt-2 ml-6 text-xs">
                    {t('impr.costFraction')}
                    <input className="input num !w-24 !h-8" inputMode="decimal" value={ch.costFraction} onChange={(e) => onChange({ ...choices, [c.line]: { ...ch, costFraction: e.target.value } })} placeholder="10" />%
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {ups.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-ink-2 mb-1">{t('impr.updatesTitle')}</div>
          <ul className="flex flex-col gap-1 text-[13px]" data-testid="import-instrument-updates">
            {ups.map((u) => (
              <li key={u.id}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={updates.has(u.id)}
                    onChange={(e) => {
                      const n = new Set(updates);
                      if (e.target.checked) n.add(u.id);
                      else n.delete(u.id);
                      onUpdates(n);
                    }}
                  />
                  <span>
                    <span className="font-mono">{u.id}</span>: {Object.entries(u.changes).map(([k, v]) => `${k} → ${String(v)}`).join(', ')} <span className="text-xs text-muted">({u.reason})</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted mt-2">{t('impr.caHint')}</p>
    </Card>
  );
}
