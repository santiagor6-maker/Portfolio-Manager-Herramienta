import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Layout } from './components/Layout';
import { useApp } from './store/app';
import { useAnalysisDriver } from './hooks/useData';
import { Skeleton } from './components/ui';
const DashboardPage = lazy(() => import('./pages/Dashboard'));
const ReportPage = lazy(() => import('./pages/Report'));
const GoalsPage = lazy(() => import('./pages/Goals'));
const WatchlistPage = lazy(() => import('./pages/Watchlist'));
const AlertsPage = lazy(() => import('./pages/Alerts'));

const PositionsPage = lazy(() => import('./pages/Positions'));
const InstrumentPage = lazy(() => import('./pages/Instrument'));
const MonthlyPage = lazy(() => import('./pages/Monthly'));
const MonthClosePage = lazy(() => import('./pages/MonthClose'));
const TransactionsPage = lazy(() => import('./pages/Transactions'));
const ImportPage = lazy(() => import('./pages/Import'));
const CurrenciesPage = lazy(() => import('./pages/Currencies'));
const DividendsPage = lazy(() => import('./pages/Dividends'));
const PerformancePage = lazy(() => import('./pages/Performance'));
const TaxesPage = lazy(() => import('./pages/Taxes'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const NotFoundPage = lazy(() => import('./pages/NotFound'));

function PageFallback() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-8 w-64" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

function Effects() {
  const { i18n } = useTranslation();
  const language = useApp((s) => s.settings.language);
  useAnalysisDriver();
  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language);
    document.documentElement.lang = language;
  }, [language, i18n]);
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <Effects />
      <Suspense fallback={null}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Lazy el={<DashboardPage />} />} />
            <Route path="informe" element={<Lazy el={<ReportPage />} />} />
            <Route path="metas" element={<Lazy el={<GoalsPage />} />} />
            <Route path="lista" element={<Lazy el={<WatchlistPage />} />} />
            <Route path="alertas" element={<Lazy el={<AlertsPage />} />} />
            <Route path="posiciones" element={<Lazy el={<PositionsPage />} />} />
            <Route path="posiciones/:id" element={<Lazy el={<InstrumentPage />} />} />
            <Route path="mensual" element={<Lazy el={<MonthlyPage />} />} />
            <Route path="mensual/cierre" element={<Lazy el={<MonthClosePage />} />} />
            <Route path="movimientos" element={<Lazy el={<TransactionsPage />} />} />
            <Route path="importar" element={<Lazy el={<ImportPage />} />} />
            <Route path="divisas" element={<Lazy el={<CurrenciesPage />} />} />
            <Route path="dividendos" element={<Lazy el={<DividendsPage />} />} />
            <Route path="rendimiento" element={<Lazy el={<PerformancePage />} />} />
            <Route path="impuestos" element={<Lazy el={<TaxesPage />} />} />
            <Route path="ajustes" element={<Lazy el={<SettingsPage />} />} />
            <Route path="*" element={<Lazy el={<NotFoundPage />} />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

function Lazy({ el }: { el: React.ReactNode }) {
  return <Suspense fallback={<PageFallback />}>{el}</Suspense>;
}
