/**
 * Importer round-2 review panels: format confirmation, possible duplicates, unknown securities
 * (securityMap), corporate events (incorporação/cisão...) and instrument updates.
 * Each panel collects answers; the Import page re-runs the import with them.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { AlertTriangle, Copy, FileWarning, GitMerge, HelpCircle, RefreshCw } from 'lucide-react';
import type { Instrument } from '@pm/core';
import { Card } from './ui';
import { InstrumentPicker } from './InstrumentPicker';
import { useFmt } from '../store/app';
import { formatDate, formatPct } from '../lib/format';
import { parseDecimal } from '../lib/parse';
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
            <div className="flex flex-col gap-1.5 min-w-0">
            {it.suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('impr.suggestionsFor', { key: it.key })} data-testid="security-suggestions">
                {it.suggestions.map((sug) => (
                  <button
                    key={sug}
                    type="button"
                    className={clsx('chip cursor-pointer', map[it.key] === sug && '!bg-accent !text-white !border-accent')}
                    aria-pressed={map[it.key] === sug}
                    onClick={() => setMap((m) => ({ ...m, [it.key]: sug }))}
                  >
                    {/^X[A-Z]{3}$|^BVMF$/.test(sug) ? exchangeLabel(sug) : sug}
                  </button>
                ))}
              </div>
            )}
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
            </div>
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
  onAccept,
  busy,
}: {
  result: ImportResult;
  choices: Record<number, CaChoice>;
  onChange: (c: Record<number, CaChoice>) => void;
  updates: Set<string>;
  onUpdates: (s: Set<string>) => void;
  /** Importers R4: accept a ready-made proposal (re-runs the import). Undefined when re-running is impossible. */
  onAccept?: (line: number, answer: { costFraction?: number }) => void;
  busy?: boolean;
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
            const pr = c.proposal;
            if (pr) {
              const tx = pr.transaction;
              const needsCost = pr.missing.includes('costFraction');
              const blocked = pr.missing.some((m) => m !== 'costFraction');
              const cost = parseDecimal(ch.costFraction, f.locale);
              return (
                <li key={c.line} className="rounded-lg border border-line p-3 text-[13px]" data-testid="ca-proposal">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="chip">{t(`impr.caKind.${c.kind}`)}</span>
                    <span className="num text-xs text-muted">{formatDate(c.date, f.locale, 'short')}</span>
                    {pr.applied && <span className="chip !text-pos !border-pos/30">{t('impr.caAccepted')}</span>}
                    {pr.alreadyImported && <span className="chip">{t('impr.caAlready')}</span>}
                  </div>
                  <div className="mt-1">{c.description}</div>
                  {tx && (
                    <div className="text-xs text-ink-2 mt-1">
                      {t('impr.caProposal', {
                        from: tx.instrumentId?.split(':').pop(),
                        to: tx.targetInstrumentId?.split(':').pop(),
                        ratio: new Intl.NumberFormat(f.locale, { maximumFractionDigits: 6 }).format(tx.ratio ?? 1),
                      })}
                      {tx.costFraction !== undefined && (
                        <>
                          {' · '}
                          {t('impr.caCost', { pct: formatPct(tx.costFraction, f.locale) })}{' '}
                          <span className="text-muted">({t(`impr.caCostSource.${pr.costFractionSource ?? 'market'}`)})</span>
                        </>
                      )}
                    </div>
                  )}
                  {blocked && <div className="text-xs text-warn mt-1">{t('impr.caMissing', { fields: pr.missing.map((m) => t(`impr.caField.${m}`)).join(', ') })}</div>}
                  {!pr.applied && !pr.alreadyImported && !blocked && onAccept && (
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      {needsCost && (
                        <label className="flex items-center gap-2 text-xs">
                          {t('impr.costFraction')}
                          <input className="input num !w-24 !h-8" inputMode="decimal" value={ch.costFraction} onChange={(e) => onChange({ ...choices, [c.line]: { ...ch, costFraction: e.target.value } })} placeholder="10" />%
                        </label>
                      )}
                      <button
                        className="btn btn-sm btn-primary"
                        data-testid="ca-accept"
                        disabled={busy || (needsCost && cost === undefined)}
                        onClick={() => onAccept(c.line, needsCost && cost !== undefined ? { costFraction: cost / 100 } : {})}
                      >
                        {t('impr.caAccept')}
                      </button>
                    </div>
                  )}
                </li>
              );
            }
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

/**
 * Importers R5: broker notes held for review (unreadable trade lines or a "Líquido para" that does
 * not match the trades read). Their rows stay pending until the user accepts the note (costs are
 * then allocated), enters the missing trade by hand, or skips the note.
 */
export function PendingNotes({
  result,
  accepted,
  skipped,
  onAccept,
  onSkip,
  busy,
}: {
  result: ImportResult;
  accepted: string[];
  skipped: string[];
  onAccept: (nota: string) => void;
  onSkip: (nota: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const f = useFmt();
  const notes = (result.noteChecks ?? []).filter((n) => !accepted.includes(n.nota) && !skipped.includes(n.nota));
  if (!notes.length) return null;
  const byLine = new Map(result.rows.map((r) => [r.line, r]));
  const money = (v: number | undefined) => (v === undefined ? '—' : new Intl.NumberFormat(f.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v));
  return (
    <Card
      className="mb-3 !border-warn/40"
      title={<span className="flex items-center gap-2"><FileWarning size={15} className="text-warn" /> {t('impr.notesTitle', { count: notes.length })}</span>}
      subtitle={t('impr.notesSub')}
    >
      <ul className="flex flex-col gap-3" data-testid="pending-notes">
        {notes.map((n) => {
          const diff = n.actualNet !== undefined ? n.actualNet - n.expectedNet : undefined;
          return (
            <li key={n.nota} className="rounded-lg border border-line p-3 text-[13px]" data-testid="pending-note">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{t('impr.nota', { nota: n.nota })}</span>
                {n.date && <span className="num text-xs text-muted">{formatDate(n.date, f.locale, 'short')}</span>}
                <span className="chip">{t('impr.notePending', { count: n.lines.length })}</span>
              </div>
              {n.unparsedLines.length > 0 && (
                <div className="mt-2">
                  <div className="text-xs font-medium text-ink-2">{t('impr.unparsed', { count: n.unparsedLines.length })}</div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {n.unparsedLines.map((l) => (
                      <li key={l} className="font-mono text-[11.5px] bg-surface-2 rounded px-2 py-1 overflow-x-auto whitespace-pre" data-testid="unparsed-line">
                        <span className="text-muted mr-2">#{l}</span>
                        {(byLine.get(l)?.raw ?? []).filter(Boolean).join('  ') || '—'}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                <div>
                  <div className="text-muted">{t('impr.netPrinted')}</div>
                  <div className="num font-semibold">{money(n.actualNet)}</div>
                </div>
                <div>
                  <div className="text-muted">{t('impr.netRead')}</div>
                  <div className="num font-semibold">{money(n.expectedNet)}</div>
                </div>
                <div>
                  <div className="text-muted">{t('impr.netDiff')}</div>
                  <div className={clsx('num font-semibold', diff && Math.abs(diff) >= 0.01 ? 'text-warn' : 'text-pos')} data-testid="note-diff">
                    {money(diff)}
                  </div>
                </div>
              </div>
              {diff !== undefined && Math.abs(diff) >= 0.01 && (
                <p className="text-xs text-ink-2 mt-2">{t(diff < 0 ? 'impr.suggestMissingBuy' : 'impr.suggestMissingSell', { amount: money(Math.abs(diff)) })}</p>
              )}
              <div className="flex flex-wrap gap-2 mt-3">
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onAccept(n.nota)} data-testid="note-accept">
                  {t('impr.noteAccept')}
                </button>
                <a className="btn btn-sm" href={`/movimientos?nuevo=1`} target="_blank" rel="noreferrer" data-testid="note-edit">
                  {t('impr.noteEdit')}
                </a>
                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onSkip(n.nota)} data-testid="note-skip">
                  {t('impr.noteSkip')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

