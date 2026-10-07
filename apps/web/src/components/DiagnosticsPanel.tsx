import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info, Stethoscope, XCircle } from 'lucide-react';
import type { Diagnostic } from '@pm/core';
import { useAnalysis } from '../hooks/useAnalysis';
import { useFmt } from '../store/app';
import { formatDate } from '../lib/format';

/**
 * Engine diagnostics (core `ledgerDiagnostics`): negative cash, oversells, unknown instruments,
 * missing FX, implicit FX conversions, maturity redemptions... Each row opens its transaction.
 */
export function DiagnosticsPanel({ onOpen }: { onOpen: (transactionId: string) => void }) {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis } = useAnalysis();
  const list = analysis?.diagnostics ?? [];
  if (!list.length) return null;
  const errors = list.filter((d) => d.severity === 'error').length;
  const warnings = list.filter((d) => d.severity === 'warning').length;
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || (a.date < b.date ? 1 : -1));
  return (
    <details className="card mb-3 group" open={errors > 0} data-testid="diagnostics">
      <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer list-none">
        <Stethoscope size={15} className="text-accent" aria-hidden />
        <span className="font-semibold text-[13.5px] flex-1">{t('diag.title')}</span>
        {errors > 0 && <span className="chip !text-neg !border-neg/30">{t('diag.errors', { count: errors })}</span>}
        {warnings > 0 && <span className="chip !text-warn !border-warn/30">{t('diag.warnings', { count: warnings })}</span>}
        <span className="chip">{t('diag.total', { count: list.length })}</span>
      </summary>
      <p className="px-4 -mt-1 pb-2 text-xs text-muted">{t('diag.subtitle')}</p>
      <ul className="max-h-[280px] overflow-auto border-t border-line divide-y divide-line text-[13px]">
        {sorted.slice(0, 200).map((d, i) => (
          <li key={i} className="flex items-start gap-2 px-4 py-2">
            {d.severity === 'error' ? <XCircle size={14} className="text-neg mt-0.5 shrink-0" aria-label={t('diag.error')} /> : d.severity === 'warning' ? <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-label={t('diag.warning')} /> : <Info size={14} className="text-info mt-0.5 shrink-0" aria-label={t('diag.info')} />}
            <span className="num text-xs text-muted w-24 shrink-0">{formatDate(d.date, f.locale, 'short')}</span>
            <span className="flex-1">{t(`diag.code.${d.code}`, { defaultValue: d.message })}</span>
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
