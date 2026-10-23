import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Inbox, X } from 'lucide-react';
import { Card } from './ui';
import { useAnalysis, useInstrumentLabel } from '../hooks/useAnalysis';
import { useFmt } from '../store/app';
import { formatDate, formatMoney, formatQuantity } from '../lib/format';
import { bulkAddTransactions, getMeta, setMeta } from '../db/repo';
import type { Suggestion } from '../services/analysis';
import { TxTypeBadge } from '../pages/Transactions';
import { corporateNote, formatRatio, formatTxRatio } from '../lib/corporateText';

async function dismiss(keys: string[]) {
  const prev = (await getMeta<string[]>('dismissedSuggestions')) ?? [];
  await setMeta('dismissedSuggestions', [...new Set([...prev, ...keys])]);
}

/**
 * Corporate-action inbox: dividends, splits and bonificações announced by the data provider for
 * positions held at the ex-date but not yet recorded. Nothing is applied without confirmation.
 */
export function SuggestionsInbox() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis } = useAnalysis();
  const label = useInstrumentLabel();
  const [busy, setBusy] = useState(false);
  const list = analysis?.suggestions ?? [];
  const review = analysis?.reviewActions ?? [];
  if (!list.length && !review.length) return null;
  const accept = async (items: Suggestion[]) => {
    setBusy(true);
    try {
      // W53: the saved note is the localized description, not the provider's English text.
      await bulkAddTransactions(items.map((s) => ({ ...s.transaction, note: corporateNote(s.transaction, t, f.locale) })));
      await dismiss(items.map((s) => s.key));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      className="mb-3"
      title={
        <span className="flex items-center gap-2">
          <Inbox size={15} className="text-accent" /> {t('ca.title', { count: list.length })}
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
        <table className="table">
          <tbody>
            {list.map((s) => {
              const x = s.transaction;
              return (
                <tr key={s.key}>
                  <td className="num">{formatDate(x.date, f.locale, 'short')}</td>
                  <td>
                    <TxTypeBadge type={x.type} />
                  </td>
                  <td>
                    <span className="font-semibold">{label(x.instrumentId).symbol}</span> <span className="text-xs text-muted">{corporateNote(x, t, f.locale) ?? ''}</span>
                  </td>
                  <td className="r num">
                    {x.type === 'DIVIDEND'
                      ? formatMoney(x.amount, x.currency, f.locale, { privacy: f.privacy })
                      : x.ratio
                        ? formatTxRatio(x, f.locale)
                        : formatQuantity(x.quantity, f.locale, f.privacy)}
                  </td>
                  <td className="r">
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
                <td colSpan={3}>
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
