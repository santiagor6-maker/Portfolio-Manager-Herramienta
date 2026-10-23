/**
 * W40: what the user sees while the reporting currency cannot be converted. Pending → a status line
 * with a spinner (the figures themselves are skeletons); missing rate → "—" figures plus this warning
 * with a retry, worded the same on the page banner, inside charts and in the report.
 */
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Banner } from './ui';
import { useApp } from '../store/app';
import { useConversion } from '../hooks/useConversion';
import { refreshMarketData } from '../services/marketData';

export function fxPairs(missing: string[], target: string): string {
  return missing.map((c) => `${c}/${target}`).join(', ');
}

/** Page-level banner (rendered by GlobalBanners above every page). */
export function FxBanner() {
  const { t } = useTranslation();
  const conv = useConversion();
  const offline = useApp((s) => s.market.status === 'offline');
  const fetching = useApp((s) => s.market.fxPending.length > 0);
  if (conv.pending)
    return (
      <div data-testid="fx-converting">
        <Banner tone="info">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <Loader2 size={14} className="animate-spin" aria-hidden /> {t('fxGuard.converting', { currency: conv.target })}
          </span>{' '}
          <span className="text-ink-2">{t('fxGuard.convertingBody')}</span>
        </Banner>
      </div>
    );
  if (!conv.missing.length) return null;
  return (
    <div data-testid="fx-missing">
      <Banner
        tone="warn"
        action={
          <button className="btn btn-sm" disabled={fetching} onClick={() => void refreshMarketData({ force: true, fx: [...conv.missing, conv.target] })} data-testid="fx-retry">
            {t('fxGuard.retry')}
          </button>
        }
      >
        <strong className="font-semibold">{t('fxGuard.missingTitle', { currency: conv.target })}</strong>{' '}
        <span className="text-ink-2">
          {t('fxGuard.missingBody', { pairs: fxPairs(conv.missing, conv.target), currency: conv.target })}
          {offline && ` ${t('fxGuard.offline')}`}
        </span>
      </Banner>
    </div>
  );
}

/** Replaces a chart (or table) whose values cannot be converted: never a flat line at 0. */
export function FxUnavailable({ className = 'py-16' }: { className?: string }) {
  const { t } = useTranslation();
  const conv = useConversion();
  return (
    <p className={`text-sm text-muted text-center px-4 ${className}`} data-testid="fx-unavailable">
      {t('fxGuard.chart', { currency: conv.target, pairs: fxPairs(conv.missing, conv.target) })}
    </p>
  );
}
