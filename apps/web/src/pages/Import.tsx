import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Copy, FileSpreadsheet, FileUp, Loader2, RotateCcw, XCircle } from 'lucide-react';
import type { TransactionType } from '@pm/core';
import { Banner, Card, Field, PageHeader, Segmented } from '../components/ui';
import { usePortfolios, useInstrumentMap } from '../hooks/useData';
import { useApp, useFmt } from '../store/app';
import { canonicalTemplateCsv, commitImport, corporateActionToTransaction, listBrokerProfiles, listPresets, runImport, type ColumnMapping, type ImportAnswers, type ImportResult, type MappingField } from '../services/importers';
import { ConfirmFormats, CorporateEvents, PossibleDuplicates, SecurityMapPrompt, type CaChoice } from '../components/ImportReview';
import { db } from '../db/schema';
import { bulkAddTransactions } from '../db/repo';
import { parseDecimal } from '../lib/parse';
import { createPortfolio } from '../db/repo';
import { downloadText } from '../lib/export';
import { CURRENCY_CODES } from '../lib/currencies';
import { formatDate, formatMoney, formatNumber } from '../lib/format';
import { TxTypeBadge } from './Transactions';
import type { Locale } from '@pm/importers';

type Step = 'upload' | 'mapping' | 'preview' | 'done';
const MAP_FIELDS: MappingField[] = ['date', 'type', 'symbol', 'isin', 'name', 'quantity', 'price', 'amount', 'netAmount', 'fees', 'taxes', 'currency', 'exchange', 'account', 'note'];

export default function ImportPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const portfolios = usePortfolios();
  const selected = useApp((s) => s.settings.selectedPortfolioId);
  const setSetting = useApp((s) => s.setSetting);
  const presets = useMemo(() => listPresets(), []);
  const instruments = useInstrumentMap();
  const fileRef = useRef<HTMLInputElement>(null);

  const writable = portfolios.filter((p) => !p.isDemo);
  const [portfolioId, setPortfolioId] = useState<string>(
    writable.find((p) => p.id === selected)?.id ?? writable[0]?.id ?? '__new',
  );
  const [account, setAccount] = useState('');
  const [presetId, setPresetId] = useState('');
  const [defaultCurrency, setDefaultCurrency] = useState(f.currency);
  const [file, setFile] = useState<File>();
  const [step, setStep] = useState<Step>('upload');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult>();
  const [error, setError] = useState<string>();
  const [mapping, setMapping] = useState<ColumnMapping>();
  const [filter, setFilter] = useState<'all' | 'ok' | 'duplicate' | 'error' | 'possible_duplicate' | 'pending'>('all');
  const [done, setDone] = useState<{ transactions: number; instruments: number }>();
  const [drag, setDrag] = useState(false);
  const profiles = useMemo(() => listBrokerProfiles(), []);
  const [profileId, setProfileId] = useState('');
  const [answers, setAnswers] = useState<ImportAnswers>({});
  const [caChoices, setCaChoices] = useState<Record<number, CaChoice>>({});
  const [updates, setUpdates] = useState<Set<string>>(new Set());
  const profile = profiles.find((p) => p.id === profileId);

  const resolvePortfolio = async (): Promise<string> => {
    if (portfolioId !== '__new') return portfolioId;
    if (writable[0]) return writable[0].id;
    const p = await createPortfolio({ name: t('portfolio.defaultName'), baseCurrency: f.currency, costMethod: 'FIFO' });
    setPortfolioId(p.id);
    return p.id;
  };

  const process = async (fl: File, map?: ColumnMapping, ans: ImportAnswers = answers) => {
    setBusy(true);
    setError(undefined);
    try {
      const pid = await resolvePortfolio();
      const r = await runImport({
        file: fl,
        portfolioId: pid,
        account: account || profile?.defaults.account || '',
        presetId: map ? undefined : presetId,
        mapping: map,
        locale: f.language as Locale,
        defaultCurrency,
        brokerProfile: profileId,
        answers: ans,
      });
      setResult(r);
      setUpdates(new Set((r.instrumentUpdates ?? []).map((u) => u.id)));
      if (r.needsMapping && r.mappingSuggestion) {
        setMapping(r.mappingSuggestion.mapping);
        setStep('mapping');
      } else setStep('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = (fl: File | undefined) => {
    if (!fl) return;
    setFile(fl);
    void process(fl);
  };

  const confirm = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const pid = await resolvePortfolio();
      const r = await commitImport(result, pid, `import:${result.detection.presetId}`);
      // Corporate events and instrument updates the user confirmed in the review.
      const known = await db.instruments.toArray();
      const resolve = (sym?: string) => (sym ? [...known, ...result.instruments].find((i) => i.symbol.toUpperCase() === sym.toUpperCase()) : undefined);
      const caTxs = (result.corporateActions ?? [])
        .filter((c) => caChoices[c.line]?.include ?? true)
        .map((c) => corporateActionToTransaction(c, resolve, pid, (parseDecimal(caChoices[c.line]?.costFraction ?? '', f.locale) ?? 0) / 100))
        .filter((x): x is NonNullable<typeof x> => !!x);
      if (caTxs.length) await bulkAddTransactions(caTxs);
      for (const u of result.instrumentUpdates ?? []) if (updates.has(u.id)) await db.instruments.update(u.id, u.changes);
      setDone({ ...r, transactions: r.transactions + caTxs.length });
      setSetting('selectedPortfolioId', pid);
      setStep('done');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(undefined);
    setResult(undefined);
    setMapping(undefined);
    setStep('upload');
    setDone(undefined);
    setError(undefined);
    setAnswers({});
    setCaChoices({});
  };

  const rerun = (patch: ImportAnswers) => {
    const next = { ...answers, ...patch };
    setAnswers(next);
    if (file) void process(file, mapping && result?.needsMapping ? mapping : undefined, next);
  };

  const rows = (result?.rows ?? []).filter((r) => filter === 'all' || r.status === filter);
  const steps: Step[] = ['upload', 'mapping', 'preview', 'done'];

  return (
    <div>
      <PageHeader
        title={t('imp.title')}
        subtitle={t('imp.subtitle')}
        actions={
          <button className="btn" onClick={() => downloadText('plantilla-portafolio-pro.csv', canonicalTemplateCsv({ bom: true }), 'text/csv')}>
            <FileSpreadsheet size={15} /> {t('imp.template')}
          </button>
        }
      />

      <ol className="flex items-center gap-2 mb-4 text-[12.5px] flex-wrap" aria-label={t('imp.steps')}>
        {steps.map((s, i) => {
          const idx = steps.indexOf(step);
          const state = i < idx ? 'done' : i === idx ? 'current' : 'todo';
          return (
            <li key={s} className="flex items-center gap-2" aria-current={state === 'current' ? 'step' : undefined}>
              <span
                className={clsx(
                  'size-6 rounded-full grid place-items-center text-[11px] font-semibold border',
                  state === 'done' && 'bg-accent text-white dark:text-[#04201d] border-accent',
                  state === 'current' && 'border-accent text-accent',
                  state === 'todo' && 'border-line text-muted',
                )}
              >
                {i + 1}
              </span>
              <span className={clsx(state === 'todo' ? 'text-muted' : 'text-ink font-medium')}>{t(`imp.step.${s}`)}</span>
              {i < steps.length - 1 && <span className="w-6 h-px bg-line" aria-hidden />}
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {step === 'upload' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <Card title={t('imp.options')}>
            <div className="flex flex-col gap-3">
              <Field label={t('imp.portfolio')} htmlFor="i-pf">
                <select id="i-pf" className="select" value={portfolioId} onChange={(e) => setPortfolioId(e.target.value)}>
                  {writable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value="__new">+ {t('imp.newPortfolio')}</option>
                </select>
              </Field>
              <Field label={t('impr.broker')} htmlFor="i-broker" hint={profile?.help}>
                <select
                  id="i-broker"
                  className="select"
                  value={profileId}
                  onChange={(e) => {
                    setProfileId(e.target.value);
                    const p = profiles.find((x) => x.id === e.target.value);
                    if (p && !account) setAccount(p.defaults.account);
                    if (p?.defaults.currency) setDefaultCurrency(p.defaults.currency);
                  }}
                  data-testid="import-broker"
                >
                  <option value="">{t('impr.anyBroker')}</option>
                  {(['CO', 'BR', 'US', 'INTL', 'MX', 'CL', 'PE'] as const).map((c) => {
                    const list = profiles.filter((p) => p.country === c);
                    return list.length ? (
                      <optgroup key={c} label={t(`impr.country.${c}`)}>
                        {list.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </optgroup>
                    ) : null;
                  })}
                </select>
              </Field>
              <Field label={t('imp.format')} htmlFor="i-fmt" hint={presets.find((p) => p.id === presetId)?.exportHelp}>
                <select id="i-fmt" className="select" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                  <option value="">{t('imp.autoDetect')}</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('imp.account')} htmlFor="i-acc" hint={t('imp.accountHint')}>
                <input id="i-acc" className="input" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="XP, Trii, IBKR…" />
              </Field>
              <Field label={t('imp.defaultCurrency')} htmlFor="i-ccy">
                <select id="i-ccy" className="select" value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value)}>
                  {CURRENCY_CODES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>
          </Card>
          <Card className="xl:col-span-2" title={t('imp.file')}>
            <div
              role="button"
              tabIndex={0}
              aria-label={t('imp.drop')}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                onFile(e.dataTransfer.files[0]);
              }}
              className={clsx(
                'rounded-xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors',
                drag ? 'border-accent bg-accent-soft' : 'border-line-strong hover:border-accent hover:bg-surface-2',
              )}
            >
              {busy ? <Loader2 className="mx-auto animate-spin text-accent" size={28} /> : <FileUp className="mx-auto text-muted" size={28} />}
              <div className="font-semibold mt-3">{busy ? t('imp.reading') : t('imp.drop')}</div>
              <p className="text-xs text-muted mt-1">{t('imp.formats')}</p>
              <input ref={fileRef} type="file" className="hidden" accept=".csv,.txt,.xlsx,.xls,.html,.htm,.pdf" onChange={(e) => onFile(e.target.files?.[0])} data-testid="import-file" />
            </div>
            <div className="mt-4">
              <div className="text-xs font-medium text-muted mb-2">{t('imp.supported')}</div>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((p) => (
                  <span key={p.id} className="chip" title={p.description}>
                    {p.broker} · {p.country}
                  </span>
                ))}
              </div>
            </div>
          </Card>
        </div>
      )}

      {step === 'mapping' && result?.mappingSuggestion && mapping && (
        <Card title={t('imp.mappingTitle')} subtitle={t('imp.mappingSub', { file: file?.name })}>
          {result.mappingSuggestion.missing.length > 0 && (
            <div className="mb-3">
              <Banner tone="warn">{t('imp.missingFields', { fields: result.mappingSuggestion.missing.map((m) => t(`imp.field.${m}`)).join(', ') })}</Banner>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {MAP_FIELDS.map((fld) => {
              const cur = mapping.columns[fld];
              const val = Array.isArray(cur) ? cur[0] : cur;
              return (
                <Field key={fld} label={t(`imp.field.${fld}`)} htmlFor={`map-${fld}`}>
                  <select
                    id={`map-${fld}`}
                    className="select"
                    value={val ?? ''}
                    onChange={(e) => {
                      const v = e.target.value === '' ? undefined : Number(e.target.value);
                      const cols = { ...mapping.columns };
                      if (v === undefined) delete cols[fld];
                      else cols[fld] = v;
                      setMapping({ ...mapping, columns: cols });
                    }}
                  >
                    <option value="">—</option>
                    {result.mappingSuggestion!.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `#${i + 1}`}
                      </option>
                    ))}
                  </select>
                </Field>
              );
            })}
            <Field label={t('imp.defaultType')} htmlFor="map-dtype">
              <select
                id="map-dtype"
                className="select"
                value={mapping.defaultType ?? ''}
                onChange={(e) => setMapping({ ...mapping, defaultType: (e.target.value || undefined) as TransactionType | undefined })}
              >
                <option value="">—</option>
                {(['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL'] as TransactionType[]).map((ty) => (
                  <option key={ty} value={ty}>
                    {t(`tx.type.${ty}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="overflow-x-auto mt-4 rounded-lg border border-line">
            <table className="table">
              <thead>
                <tr>
                  {result.mappingSuggestion.headers.map((h, i) => (
                    <th key={i}>{h || `#${i + 1}`}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.mappingSuggestion.sample.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j} className="text-xs">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 justify-end mt-4">
            <button className="btn" onClick={reset}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => file && void process(file, { ...mapping, defaultCurrency })}>
              {busy && <Loader2 size={14} className="animate-spin" />} {t('imp.applyMapping')}
            </button>
          </div>
        </Card>
      )}

      {step === 'preview' && result && (
        <>
          <ConfirmFormats key={`cf-${result.needsConfirmation?.length ?? 0}`} result={result} busy={busy} onApply={(a) => rerun(a)} />
          <SecurityMapPrompt result={result} current={answers.securityMap ?? {}} busy={busy} onApply={(m) => rerun({ securityMap: { ...(answers.securityMap ?? {}), ...m } })} />
          <PossibleDuplicates result={result} accepted={answers.acceptDuplicates ?? []} busy={busy} onApply={(lines) => rerun({ acceptDuplicates: lines })} />
          <CorporateEvents result={result} choices={caChoices} onChange={setCaChoices} updates={updates} onUpdates={setUpdates} />
          <Card
            title={t('imp.previewTitle', { file: file?.name })}
            subtitle={
              <span className="flex flex-wrap gap-1.5 mt-1">
                <span className="chip">{result.detection.presetLabel || result.detection.presetId}</span>
                <span className="chip">{t(`imp.confidence.${result.detection.presetConfidence}`)}</span>
                <span className="chip uppercase">{result.detection.fileKind}</span>
                {result.stats.firstDate && (
                  <span className="chip">
                    {formatDate(result.stats.firstDate, f.locale, 'short')} → {formatDate(result.stats.lastDate, f.locale, 'short')}
                  </span>
                )}
              </span>
            }
          >
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <Stat label={t('imp.stat.toImport')} value={result.stats.imported} tone="pos" />
              <Stat label={t('imp.stat.duplicates')} value={result.stats.duplicates} tone="muted" />
              <Stat label={t('imp.stat.errors')} value={result.stats.errors} tone={result.stats.errors ? 'neg' : 'muted'} />
              <Stat label={t('imp.stat.skipped')} value={result.stats.skipped} tone="muted" />
              <Stat label={t('imp.stat.newInstruments')} value={result.stats.newInstruments} tone="muted" />
            </div>
            {result.errors.length > 0 && (
              <div className="mt-3">
                <Banner tone="error">
                  <ul className="list-disc pl-4">
                    {result.errors.slice(0, 5).map((e, i) => (
                      <li key={i}>{e.message}</li>
                    ))}
                  </ul>
                </Banner>
              </div>
            )}
            {result.instruments.length > 0 && (
              <div className="mt-3 text-xs text-ink-2">
                <span className="font-medium">{t('imp.newInstrumentsList')}:</span>{' '}
                {result.instruments
                  .filter((i) => !instruments.has(i.id))
                  .map((i) => i.symbol)
                  .join(', ')}
              </div>
            )}
          </Card>
          <Card
            className="mt-3"
            title={t('imp.rows')}
            actions={
              <Segmented
                label={t('imp.filter')}
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: `${t('imp.all')} (${result.rows.length})` },
                  { value: 'ok', label: `OK (${result.rows.filter((r) => r.status === 'ok').length})` },
                  { value: 'duplicate', label: `${t('imp.stat.duplicates')} (${result.stats.duplicates})` },
                  { value: 'error', label: `${t('imp.stat.errors')} (${result.stats.errors})` },
                  ...(result.rows.some((r) => r.status === 'possible_duplicate')
                    ? [{ value: 'possible_duplicate' as const, label: `${t('impr.possible')} (${result.rows.filter((r) => r.status === 'possible_duplicate').length})` }]
                    : []),
                  ...(result.rows.some((r) => r.status === 'pending') ? [{ value: 'pending' as const, label: `${t('impr.pending')} (${result.rows.filter((r) => r.status === 'pending').length})` }] : []),
                ]}
              />
            }
            bodyClassName="!p-0"
          >
            <div className="max-h-[520px] overflow-auto" data-testid="import-preview">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('imp.line')}</th>
                    <th>{t('imp.status')}</th>
                    <th>{t('tx.date')}</th>
                    <th>{t('tx.typeLabel')}</th>
                    <th>{t('tx.instrument')}</th>
                    <th className="r">{t('tx.quantity')}</th>
                    <th className="r">{t('tx.price')}</th>
                    <th className="r">{t('tx.amount')}</th>
                    <th className="r">{t('tx.fees')}</th>
                    <th className="r">{t('tx.taxesShort')}</th>
                    <th>{t('imp.issues')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 500).map((r, i) => {
                    const tx = r.transaction;
                    return (
                      <tr key={i} className={clsx(r.status === 'error' && '[&>td]:bg-neg-soft/40', r.status !== 'ok' && 'text-ink-2')}>
                        <td className="num text-muted">{r.line}</td>
                        <td>
                          <StatusIcon status={r.status} />
                        </td>
                        <td className="num">{tx ? formatDate(tx.date, f.locale, 'short') : '—'}</td>
                        <td>{tx ? <TxTypeBadge type={tx.type} /> : '—'}</td>
                        <td className="font-medium">{tx?.instrumentId ? (instruments.get(tx.instrumentId)?.symbol ?? result.instruments.find((x) => x.id === tx.instrumentId)?.symbol ?? tx.instrumentId) : ''}</td>
                        <td className="r num">{tx?.quantity !== undefined ? formatNumber(tx.quantity, f.locale, 4) : ''}</td>
                        <td className="r num">{tx?.price !== undefined ? formatNumber(tx.price, f.locale, 4) : ''}</td>
                        <td className="r num">{tx?.amount !== undefined ? formatMoney(tx.amount, tx.currency, f.locale) : ''}</td>
                        <td className="r num text-muted">{tx?.fees ? formatMoney(tx.fees, tx.currency, f.locale) : ''}</td>
                        <td className="r num text-muted">{tx?.taxes ? formatMoney(tx.taxes, tx.currency, f.locale) : ''}</td>
                        <td className="text-xs whitespace-normal min-w-[200px]">{r.issues.map((x) => x.message).join(' · ')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="flex gap-2 justify-end mt-3 flex-wrap">
            <button className="btn" onClick={reset}>
              <RotateCcw size={15} /> {t('imp.another')}
            </button>
            {result.mappingSuggestion && (
              <button
                className="btn"
                onClick={() => {
                  setMapping(result.mappingSuggestion!.mapping);
                  setStep('mapping');
                }}
              >
                {t('imp.editMapping')}
              </button>
            )}
            <button className="btn btn-primary" disabled={busy || result.transactions.length === 0} onClick={() => void confirm()} data-testid="import-confirm">
              {busy && <Loader2 size={14} className="animate-spin" />}
              {t('imp.confirm', { count: result.transactions.length })}
            </button>
          </div>
        </>
      )}

      {step === 'done' && done && (
        <Card>
          <div className="text-center py-8">
            <CheckCircle2 className="mx-auto text-pos" size={36} />
            <div className="font-semibold text-lg mt-3">{t('imp.doneTitle', { count: done.transactions })}</div>
            <p className="text-sm text-ink-2 mt-1">{t('imp.doneBody', { instruments: done.instruments })}</p>
            <div className="flex gap-2 justify-center mt-5 flex-wrap">
              <Link className="btn btn-primary" to="/mensual">
                {t('nav.monthly')}
              </Link>
              <Link className="btn" to="/movimientos">
                {t('nav.transactions')}
              </Link>
              <button className="btn" onClick={reset}>
                {t('imp.another')}
              </button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'pos' | 'neg' | 'muted' }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('text-lg font-semibold num', tone === 'pos' && 'text-pos', tone === 'neg' && 'text-neg')}>{value}</div>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  const { t } = useTranslation();
  const label = t(`imp.rowStatus.${status}`);
  if (status === 'ok') return <CheckCircle2 size={15} className="text-pos" aria-label={label} />;
  if (status === 'duplicate') return <Copy size={15} className="text-muted" aria-label={label} />;
  if (status === 'error') return <XCircle size={15} className="text-neg" aria-label={label} />;
  return <AlertTriangle size={15} className="text-muted" aria-label={label} />;
}
