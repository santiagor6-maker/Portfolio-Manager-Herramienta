import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info, Plus, Stethoscope, XCircle } from 'lucide-react';
import type { Diagnostic } from '@pm/core';
import { useAnalysis } from '../hooks/useAnalysis';
import { useFmt } from '../store/app';
import { formatDate, formatMoney } from '../lib/format';
import { db } from '../db/schema';
import { saveTransaction } from '../db/repo';
import type { ImplicitFunding } from '../services/analysis';
import { useLiveQuery } from 'dexie-react-hooks';
import { useInstrumentMap } from '../hooks/useData';
import { describeDiagnostic } from '../lib/diagnosticText';

/** W22: books the deposit the engine had to assume, on the purchase date, in its portfolio. */
export async function createDepositFor(f: ImplicitFunding, note: string): Promise<void> {
  const tx = f.transactionId ? await db.transactions.get(f.transactionId) : undefined;
  if (!tx) return;
  await saveTransaction({ portfolioId: tx.portfolioId, date: f.date, type: 'DEPOSIT', currency: f.currency, amount: Math.round(f.amount * 100) / 100, account: tx.account, note });
}

/**
 * Engine diagnostics (core `ledgerDiagnostics`): negative cash, oversells, unknown instruments,
 * missing FX, implicit FX conversions, maturity redemptions... Each row opens its transaction.
 */
export function DiagnosticsPanel({ onOpen }: { onOpen: (transactionId: string) => void }) {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis } = useAnalysis();
  const list = analysis?.diagnostics ?? [];
  const implicit = analysis?.implicitFunding ?? [];
  const instruments = useInstrumentMap();
  const txIds = list.map((d) => d.transactionId).filter((x): x is string => !!x);
  const txs = useLiveQuery(async () => new Map((await db.transactions.bulkGet(txIds)).filter((x) => !!x).map((x) => [x!.id, x!])), [txIds.join('|')]);
  if (!list.length && !implicit.length) return null;
  const errors = list.filter((d) => d.severity === 'error').length;
  const warnings = list.filter((d) => d.severity === 'warning').length + implicit.length;
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || (a.date < b.date ? 1 : -1));
  return (
    <details className="card mb-3 group" open={errors > 0 || implicit.length > 0} data-testid="diagnostics">
      <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer list-none">
        <Stethoscope size={15} className="text-accent" aria-hidden />
        <span className="font-semibold text-[13.5px] flex-1">{t('diag.title')}</span>
        {errors > 0 && <span className="chip !text-neg !border-neg/30">{t('diag.errors', { count: errors })}</span>}
        {warnings > 0 && <span className="chip !text-warn !border-warn/30">{t('diag.warnings', { count: warnings })}</span>}
        <span className="chip">{t('diag.total', { count: list.length + implicit.length })}</span>
      </summary>
      <p className="px-4 -mt-1 pb-2 text-xs text-muted">{t('diag.subtitle')}</p>
      <ul className="max-h-[280px] overflow-auto border-t border-line divide-y divide-line text-[13px]">
        {implicit.map((x, i) => (
          <li key={`imp-${i}`} className="flex items-start gap-2 px-4 py-2" data-testid="implicit-funding">
            <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-label={t('diag.warning')} />
            <span className="num text-xs text-muted w-24 shrink-0">{formatDate(x.date, f.locale, 'short')}</span>
            <span className="flex-1">
              <span className="font-medium">{t('diag.code.IMPLICIT_DEPOSIT')}</span>{' '}
              <span className="text-ink-2 text-xs">{t('diag.implicitText', { amount: formatMoney(x.amount, x.currency, f.locale) })}</span>
            </span>
            {x.transactionId && (
              <button className="btn btn-sm btn-ghost" onClick={() => onOpen(x.transactionId!)}>
                {t('diag.open')}
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void createDepositFor(x, t('diag.implicitNote'))} data-testid="create-deposit">
              <Plus size={13} /> {t('diag.createDeposit')}
            </button>
          </li>
        ))}
        {sorted.slice(0, 200).map((d, i) => (
          <li key={i} className="flex items-start gap-2 px-4 py-2">
            {d.severity === 'error' ? <XCircle size={14} className="text-neg mt-0.5 shrink-0" aria-label={t('diag.error')} /> : d.severity === 'warning' ? <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-label={t('diag.warning')} /> : <Info size={14} className="text-info mt-0.5 shrink-0" aria-label={t('diag.info')} />}
            <span className="num text-xs text-muted w-24 shrink-0">{formatDate(d.date, f.locale, 'short')}</span>
            <span className="flex-1">
              <span className="font-medium">{t(`diag.code.${d.code}`, { defaultValue: d.code })}</span>{' '}
              <span className="text-ink-2 text-xs" title={`${t('diag.details')}: ${d.message}`} data-testid="diag-text">
                {describeDiagnostic(d, { tx: d.transactionId ? txs?.get(d.transactionId) : undefined, instruments, locale: f.locale, t })}
              </span>
            </span>
            {d.transactionId && (
              <button className="btn btn-sm btn-ghost" onClick={() => onOpen(d.transactionId!)}>
                {t('diag.open')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function rank(d: Diagnostic): number {
  return d.severity === 'error' ? 0 : d.severity === 'warning' ? 1 : 2;
}
