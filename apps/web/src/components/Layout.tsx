import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  ArrowLeftRight,
  BarChart3,
  CalendarRange,
  Coins,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Gauge,
  Landmark,
  LayoutDashboard,
  Layers,
  Menu,
  Moon,
  Receipt,
  RefreshCw,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import { useApp } from '../store/app';
import { CURRENCIES } from '../lib/currencies';
import { usePortfolios } from '../hooks/useData';
import { useTheme } from '../hooks/useTheme';
import { refreshMarketData } from '../services/marketData';
import { formatRelative } from '../lib/format';
import { useFmt } from '../store/app';
import { GlobalBanners } from './GlobalBanners';
import { DemoBadge } from './ui';

interface NavItem {
  to: string;
  key: string;
  icon: ReactNode;
}

const NAV: NavItem[] = [
  { to: '/', key: 'nav.dashboard', icon: <LayoutDashboard size={17} /> },
  { to: '/posiciones', key: 'nav.positions', icon: <Layers size={17} /> },
  { to: '/mensual', key: 'nav.monthly', icon: <CalendarRange size={17} /> },
  { to: '/movimientos', key: 'nav.transactions', icon: <ArrowLeftRight size={17} /> },
  { to: '/importar', key: 'nav.import', icon: <FileSpreadsheet size={17} /> },
  { to: '/divisas', key: 'nav.currencies', icon: <Coins size={17} /> },
  { to: '/dividendos', key: 'nav.dividends', icon: <Landmark size={17} /> },
  { to: '/rendimiento', key: 'nav.performance', icon: <Gauge size={17} /> },
  { to: '/impuestos', key: 'nav.taxes', icon: <Receipt size={17} /> },
  { to: '/ajustes', key: 'nav.settings', icon: <Settings size={17} /> },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <div className="size-8 rounded-lg bg-accent grid place-items-center text-white dark:text-[#04201d] shadow-sm">
        <BarChart3 size={17} strokeWidth={2.4} aria-hidden />
      </div>
      <div className="leading-tight">
        <div className="font-semibold text-[14.5px] tracking-tight">Portafolio Pro</div>
        <div className="text-[11px] text-muted">Local-first · multi-divisa</div>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('nav.main')} className="flex flex-col gap-0.5 px-2">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            clsx(
              'flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[13.5px] font-medium transition-colors',
              isActive ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
            )
          }
        >
          <span aria-hidden>{n.icon}</span>
          {t(n.key)}
        </NavLink>
      ))}
    </nav>
  );
}

function PortfolioSelect() {
  const { t } = useTranslation();
  const portfolios = usePortfolios();
  const selected = useApp((s) => s.settings.selectedPortfolioId);
  const setSetting = useApp((s) => s.setSetting);
  const navigate = useNavigate();
  const current = portfolios.find((p) => p.id === selected);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <label htmlFor="pf-select" className="sr-only">
        {t('top.portfolio')}
      </label>
      <select
        id="pf-select"
        className="select !h-9 !w-auto max-w-[220px] font-medium"
        value={portfolios.some((p) => p.id === selected) ? selected : 'all'}
        onChange={(e) => {
          if (e.target.value === '__new') navigate('/ajustes#portafolios');
          else setSetting('selectedPortfolioId', e.target.value);
        }}
      >
        <option value="all">{t('top.allPortfolios', { count: portfolios.length })}</option>
        {portfolios.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.isDemo ? ` · ${t('demo.badge')}` : ''}
          </option>
        ))}
        <option value="__new">+ {t('top.newPortfolio')}</option>
      </select>
      {(current?.isDemo || (selected === 'all' && portfolios.some((p) => p.isDemo))) && (
        <span className="hidden md:inline-flex">
          <DemoBadge />
        </span>
      )}
    </div>
  );
}

function CurrencySwitch() {
  const { t } = useTranslation();
  const ccy = useApp((s) => s.settings.reportingCurrency);
  const setSetting = useApp((s) => s.setSetting);
  return (
    <>
      <label htmlFor="ccy-select" className="sr-only">
        {t('top.currency')}
      </label>
      <select
        id="ccy-select"
        data-testid="currency-switch"
        className="select !h-9 !w-[92px] font-semibold num"
        value={ccy}
        title={t('top.currencyHint')}
        onChange={(e) => setSetting('reportingCurrency', e.target.value)}
      >
        {CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code}
          </option>
        ))}
      </select>
    </>
  );
}

function RefreshButton() {
  const { t } = useTranslation();
  const market = useApp((s) => s.market);
  const { locale } = useFmt();
  const loading = market.status === 'loading';
  const dot =
    market.status === 'ok'
      ? 'bg-pos'
      : market.status === 'partial'
        ? 'bg-warn'
        : market.status === 'offline'
          ? 'bg-neg'
          : 'bg-muted';
  const label =
    market.status === 'loading'
      ? t('market.updating')
      : market.lastRefresh
        ? t('market.updatedAgo', { when: formatRelative(market.lastRefresh, locale) })
        : t('market.notUpdated');
  return (
    <button
      className="btn !h-9"
      onClick={() => void refreshMarketData({ force: true })}
      disabled={loading}
      title={label}
      aria-label={`${t('market.refresh')} — ${label}`}
    >
      <span className={clsx('size-2 rounded-full', dot)} aria-hidden />
      <RefreshCw size={15} className={clsx(loading && 'animate-spin')} aria-hidden />
      <span className="hidden xl:inline text-ink-2 font-normal">{label}</span>
    </button>
  );
}

function IconToggles() {
  const { t } = useTranslation();
  const privacy = useApp((s) => s.settings.privacy);
  const setSetting = useApp((s) => s.setSetting);
  const { resolved } = useTheme();
  return (
    <>
      <button
        className="btn btn-ghost btn-icon !h-9 !w-9"
        aria-pressed={privacy}
        aria-label={privacy ? t('top.showAmounts') : t('top.hideAmounts')}
        title={privacy ? t('top.showAmounts') : t('top.hideAmounts')}
        onClick={() => setSetting('privacy', !privacy)}
      >
        {privacy ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
      <button
        className="btn btn-ghost btn-icon !h-9 !w-9"
        aria-label={resolved === 'dark' ? t('top.lightTheme') : t('top.darkTheme')}
        title={resolved === 'dark' ? t('top.lightTheme') : t('top.darkTheme')}
        onClick={() => setSetting('theme', resolved === 'dark' ? 'light' : 'dark')}
      >
        {resolved === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
    </>
  );
}

export function Layout() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useTheme();
  useEffect(() => {
    setOpen(false);
    document.getElementById('main')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [loc.pathname]);

  return (
    <div className="min-h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 btn btn-primary"
      >
        {t('nav.skip')}
      </a>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-[232px] flex-col gap-5 border-r border-line bg-surface py-4">
        <Brand />
        <Sidebar />
        <div className="mt-auto px-4 text-[11px] text-muted leading-relaxed">{t('nav.localNote')}</div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-[260px] bg-surface border-r border-line py-4 flex flex-col gap-5 shadow-xl">
            <div className="flex items-center justify-between pr-3">
              <Brand />
              <button className="btn btn-ghost btn-icon" onClick={() => setOpen(false)} aria-label={t('common.close')}>
                <X size={18} />
              </button>
            </div>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-[232px] min-w-0">
        <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_85%,transparent)] backdrop-blur-md">
          <div className="flex items-center gap-2 px-4 lg:px-8 h-14">
            <button
              className="btn btn-ghost btn-icon lg:hidden -ml-1"
              onClick={() => setOpen(true)}
              aria-label={t('nav.open')}
              aria-expanded={open}
            >
              <Menu size={19} />
            </button>
            <PortfolioSelect />
            <div className="ml-auto flex items-center gap-1.5">
              <CurrencySwitch />
              <RefreshButton />
              <IconToggles />
            </div>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="px-4 lg:px-8 py-6 max-w-[1440px] mx-auto outline-none">
          <GlobalBanners />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
