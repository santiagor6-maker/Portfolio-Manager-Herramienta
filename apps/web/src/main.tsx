import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { setLanguage } from './i18n';
import { App } from './App';
import { useApp } from './store/app';
import { bootstrap } from './services/onboarding';
import { hydrateMarketState, refreshMarketData } from './services/marketData';
import { ensureDefaultAlerts, evaluateAlerts } from './services/alerts';
import { checkIbkrInboxes } from './services/ibkrSync';
import { checkEmailDrafts } from './services/emailInbox';

/** PWA: cache the app shell for offline use (production builds only). */
function registerServiceWorker() {
  if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
}

async function start() {
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // A shared read-only link must not seed or touch the viewer's own data (W10).
  if (location.pathname.startsWith('/compartido')) {
    const nav = navigator.language.slice(0, 2);
    await setLanguage(['es', 'pt', 'en'].includes(nav) ? nav : 'es');
    useApp.getState().setReady(useApp.getState().settings);
    return;
  }
  try {
    const settings = await bootstrap();
    await setLanguage(settings.language);
    document.documentElement.lang = settings.language;
    useApp.getState().setReady(settings);
    await hydrateMarketState();
    await ensureDefaultAlerts();
    void evaluateAlerts();
    void checkIbkrInboxes(); // IBKR daily-sync inbox badge
    void checkEmailDrafts(); // forwarded e-mails waiting for review
    void import('./lib/noteNames').then((m) => m.repairNoteNames()); // W43: names from brokerage notes
    if (settings.autoRefresh) void refreshMarketData();
    registerServiceWorker();
  } catch (e) {
    console.error('Bootstrap failed', e);
    useApp.getState().setReady(useApp.getState().settings);
  }
}

void start();
