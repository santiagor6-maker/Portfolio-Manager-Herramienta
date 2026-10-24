import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Inbox, X } from 'lucide-react';
import { Card } from './ui';
import { useAnalysis, useInstrumentLabel } from '../hooks/useAnalysis';
import { useFmt } from '../store/app';
import { formatDate, formatMoney, formatQuantity } from '../lib/format';
import type { Suggestion } from '../services/analysis';
import { acceptSuggestions, dismiss } from '../services/suggestions';
import { TxTypeBadge } from '../pages/Transactions';
import { corporateNote, formatRatio, formatTxRatio } from '../lib/corporateText';

/**
 * Corporate-action inbox: dividends, splits and bonificações announced by the data provider for
 * positions held at the ex-date but not yet recorded. Nothing is applied without confirmation.
 */
export function SuggestionsInbox({ kind = 'all' }: { kind?: 'all' | 'income' }) {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis } = useAnalysis();
  const label = useInstrumentLabel();
  const [busy, setBusy] = useState(false);
  // W55: Proventos shows only the announced cash events.
  const income = (s: Suggestion) => ['DIVIDEND', 'INTEREST', 'RETURN_OF_CAPITAL'].includes(s.transaction.type);
  const list = (analysis?.suggestions ?? []).filter((s) => kind === 'all' || income(s));
  const review = kind === 'all' ? (analysis?.reviewActions ?? []) : [];
  if (!list.length && !review.length) return null;
  const accept = async (items: Suggestion[]) => {
    setBusy(true);
    try {
      await acceptSuggestions(items, t, f.locale);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      className="mb-3"
      title={
        <span className="flex items-center gap-2">
          <Inbox size={15} className="text-accent" /> {kind === 'income' ? t('pending.income', { count: list.length }) : t('ca.title', { count: list.length })}
        </span>
      }
      subtitle={t('ca.subtitle')}
      actions={
        list.length > 1 ? (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void accept(list)}>
            <Check size={14} /> {t('ca.acceptAll')}
          </button>
        ) : undefined
      }
      bodyClassName="!p-0"
    >
      <div className="max-h-[300px] overflow-auto" data-testid="suggestions">
        <table className="table w-full">
          <tbody>
            {list.map((s) => {
              const x = s.transaction;
              return (
                <tr key={s.key}>
                  <td className="num">{formatDate(x.date, f.locale, 'short')}</td>
                  <td>
                    <TxTypeBadge type={x.type} />
                  </td>
                  <td className="!whitespace-normal min-w-[10rem]">
                    <span className="font-semibold">{label(x.instrumentId).symbol}</span>
                    {/* W59: the long bonificação note wraps on its own line so the actions stay inside the card. */}
                    <span className="block text-xs text-muted">{corporateNote(x, t, f.locale) ?? ''}</span>
                  </td>
                  <td className="r num">
                    {x.type === 'DIVIDEND'
                      ? formatMoney(x.amount, x.currency, f.locale, { privacy: f.privacy })
                      : x.ratio
                        ? formatTxRatio(x, f.locale)
                        : formatQuantity(x.quantity, f.locale, f.privacy)}
                  </td>
                  <td className="r w-px">
                    <div className="flex gap-1 justify-end">
                      <button className="btn btn-sm" disabled={busy} onClick={() => void accept([s])} aria-label={t('ca.accept')}>
                        <Check size={14} /> {t('ca.accept')}
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => void dismiss([s.key])} aria-label={t('ca.dismiss')}>
                        <X size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {review.map((a, i) => (
              <tr key={`r${i}`} className="text-ink-2">
                <td className="num">{formatDate(a.date, f.locale, 'short')}</td>
                <td>
                  <span className="chip">{t('ca.review')}</span>
                </td>
                <td colSpan={3} className="!whitespace-normal">
                  <span className="font-semibold">{label(a.instrumentId).symbol}</span> · {a.type}
                  {a.subtype ? ` (${a.subtype})` : ''} {a.ratio ? formatRatio(a.ratio, f.locale) : ''} — <span className="text-xs">{t('ca.reviewHint')}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
