import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useApp } from '../store/app';
import { usePortfolios } from '../hooks/useData';
import { Banner } from './ui';
import { FxBanner } from './FxNotice';

export function GlobalBanners() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const portfolios = usePortfolios();
  const market = useApp((s) => s.market);
  const analysis = useApp((s) => s.analysis);
  const selected = useApp((s) => s.settings.selectedPortfolioId);
  const [hideOffline, setHideOffline] = useState(false);
  const setOnboardingOpen = useApp((s) => s.setOnboardingOpen);
  const demo = portfolios.find((p) => p.isDemo);
  const showDemo = !!demo && (selected === 'all' || selected === demo.id);

  const engineDown = analysis && analysis.engineErrors.createMarketData;

  return (
    <div className="flex flex-col gap-2 mb-4 empty:hidden print:hidden">
      {showDemo && (
        <div data-testid="demo-banner">
          <Banner
            tone="warn"
            action={
              <div className="flex gap-2 flex-wrap sm:justify-end">
                <button className="btn btn-sm btn-primary" onClick={() => setOnboardingOpen(true)} data-testid="start-portfolio">
                  {t('demo.startEmpty')}
                </button>
                <button className="btn btn-sm" onClick={() => navigate('/importar')}>
                  {t('demo.import')}
                </button>
              </div>
            }
          >
            <strong className="font-semibold">{t('demo.title')}</strong>{' '}
            <span className="text-ink-2">{t('demo.body')}</span>
          </Banner>
        </div>
      )}
      {market.status === 'offline' && !hideOffline && (
        <Banner tone="info" onClose={() => setHideOffline(true)}>
          {(() => {
            // W28: say what the server answered instead of "start the server".
            const e = market.error;
            const kind =
              e?.code === 'FORBIDDEN_ORIGIN' || (e?.status === 403 && e.code !== 'FORBIDDEN')
                ? 'origin'
                : e?.status === 429 || e?.code === 'RATE_LIMITED'
                  ? 'rateLimited'
                  : e?.status === 401 || e?.code === 'UNAUTHORIZED'
                    ? 'unauthorized'
                    : e?.status
                      ? 'http'
                      : undefined;
            return kind ? (
              <span data-testid="server-error">
                <strong className="font-semibold">{t(`market.err.${kind}Title`)}</strong>{' '}
                <span className="text-ink-2">{t(`market.err.${kind}Body`, { origin: location.origin, status: e?.status })}</span>{' '}
                {e?.code && <code className="text-xs opacity-70">{e.code}</code>}
              </span>
            ) : (
              <>
                <strong className="font-semibold">{t('market.offlineTitle')}</strong>{' '}
                <span className="text-ink-2">{t('market.offlineBody')}</span>
              </>
            );
          })()}
        </Banner>
      )}
      <FxBanner />
      {engineDown && (
        <Banner tone="error">
          <strong className="font-semibold">{t('engine.downTitle')}</strong>{' '}
          <span className="text-ink-2">{t('engine.downBody')}</span>{' '}
          <code className="text-xs opacity-70">{analysis.engineErrors.createMarketData}</code>
        </Banner>
      )}
    </div>
  );
}
