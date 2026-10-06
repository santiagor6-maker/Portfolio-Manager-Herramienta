import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import i18n from './i18n';
import { App } from './App';
import { useApp } from './store/app';
import { bootstrap } from './services/onboarding';
import { hydrateMarketState, refreshMarketData } from './services/marketData';
import { ensureDefaultAlerts, evaluateAlerts } from './services/alerts';

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
  try {
    const settings = await bootstrap();
    await i18n.changeLanguage(settings.language);
    document.documentElement.lang = settings.language;
    useApp.getState().setReady(settings);
    await hydrateMarketState();
    await ensureDefaultAlerts();
    void evaluateAlerts();
    if (settings.autoRefresh) void refreshMarketData();
    registerServiceWorker();
  } catch (e) {
    console.error('Bootstrap failed', e);
    useApp.getState().setReady(useApp.getState().settings);
  }
}

void start();
