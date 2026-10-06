import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  CalendarRange,
  Coins,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  Gauge,
  Landmark,
  LayoutDashboard,
  Layers,
  Menu,
  Moon,
  Receipt,
  RefreshCw,
  Settings,
  Star,
  Sun,
  Target,
  X,
} from 'lucide-react';
import { useApp, useFmt } from '../store/app';
import { CURRENCIES } from '../lib/currencies';
import { usePortfolios } from '../hooks/useData';
import { useTheme } from '../hooks/useTheme';
import { refreshMarketData } from '../services/marketData';
import { formatRelative } from '../lib/format';
import { db } from '../db/schema';
import { GlobalBanners } from './GlobalBanners';
import { DemoBadge } from './ui';
import { OnboardingWizard } from './Onboarding';

interface NavItem {
  to: string;
  key: string;
  icon: ReactNode;
}

const NAV_GROUPS: { key: string; items: NavItem[] }[] = [
  {
    key: 'nav.group.portfolio',
    items: [
      { to: '/', key: 'nav.dashboard', icon: <LayoutDashboard size={16} /> },
      { to: '/posiciones', key: 'nav.positions', icon: <Layers size={16} /> },
      { to: '/mensual', key: 'nav.monthly', icon: <CalendarRange size={16} /> },
      { to: '/informe', key: 'nav.report', icon: <FileText size={16} /> },
    ],
  },
  {
    key: 'nav.group.data',
    items: [
      { to: '/movimientos', key: 'nav.transactions', icon: <ArrowLeftRight size={16} /> },
      { to: '/importar', key: 'nav.import', icon: <FileSpreadsheet size={16} /> },
    ],
  },
  {
    key: 'nav.group.analysis',
    items: [
      { to: '/rendimiento', key: 'nav.performance', icon: <Gauge size={16} /> },
      { to: '/divisas', key: 'nav.currencies', icon: <Coins size={16} /> },
      { to: '/dividendos', key: 'nav.dividends', icon: <Landmark size={16} /> },
      { to: '/impuestos', key: 'nav.taxes', icon: <Receipt size={16} /> },
    ],
  },
  {
    key: 'nav.group.plan',
    items: [
      { to: '/metas', key: 'nav.goals', icon: <Target size={16} /> },
      { to: '/lista', key: 'nav.watchlist', icon: <Star size={16} /> },
      { to: '/alertas', key: 'nav.alerts', icon: <Bell size={16} /> },
    ],
  },
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
  const link = (n: NavItem) => (
    <NavLink
      key={n.to}
      to={n.to}
      end={n.to === '/'}
      onClick={onNavigate}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13.5px] font-medium transition-colors whitespace-nowrap',
          isActive ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        )
      }
    >
      <span aria-hidden>{n.icon}</span>
      <span className="truncate">{t(n.key)}</span>
    </NavLink>
  );
  return (
    <nav aria-label={t('nav.main')} className="flex flex-col gap-3 px-2 overflow-y-auto">
      {NAV_GROUPS.map((g) => (
        <div key={g.key} className="flex flex-col gap-0.5">
          <div className="px-2.5 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">{t(g.key)}</div>
          {g.items.map(link)}
        </div>
      ))}
      <div className="border-t border-line pt-2">{link({ to: '/ajustes', key: 'nav.settings', icon: <Settings size={16} /> })}</div>
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
    <div className="flex items-center gap-2 min-w-0 flex-1 sm:flex-none">
      <label htmlFor="pf-select" className="sr-only">
        {t('top.portfolio')}
      </label>
      <select
        id="pf-select"
        className="select !h-9 w-full sm:!w-auto sm:max-w-[240px] font-medium min-w-0"
        value={portfolios.some((p) => p.id === selected) ? selected : 'all'}
        onChange={(e) => {
          if (e.target.value === '__new') navigate('/ajustes#portafolios');
          else setSetting('selectedPortfolioId', e.target.value);
        }}
      >
        <option value="all">{t('top.allPortfoliosShort', { count: portfolios.length })}</option>
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
        className="select !h-9 !w-[80px] sm:!w-[92px] font-semibold num shrink-0"
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
    market.status === 'ok' ? 'bg-pos' : market.status === 'partial' ? 'bg-warn' : market.status === 'offline' ? 'bg-neg' : 'bg-muted';
  const label =
    market.status === 'loading'
      ? t('market.updating')
      : market.lastRefresh
        ? t('market.updatedAgo', { when: formatRelative(market.lastRefresh, locale) })
        : t('market.notUpdated');
  return (
    <button
      className="btn !h-9 !px-2 sm:!px-3 shrink-0"
      onClick={() => void refreshMarketData({ force: true })}
      disabled={loading}
      title={label}
      aria-label={`${t('market.refresh')} — ${label}`}
      data-testid="refresh"
    >
      <span className={clsx('size-2 rounded-full', dot)} aria-hidden />
      <RefreshCw size={15} className={clsx(loading && 'animate-spin')} aria-hidden />
      <span className="hidden xl:inline text-ink-2 font-normal">{label}</span>
    </button>
  );
}

function AlertsBell() {
  const { t } = useTranslation();
  const unread = useLiveQuery(() => db.alertEvents.filter((e) => !e.read).count(), [], 0);
  return (
    <Link
      to="/alertas"
      className="btn btn-ghost btn-icon !h-9 !w-9 relative shrink-0"
      aria-label={unread ? t('alerts.unread', { count: unread }) : t('nav.alerts')}
      title={t('nav.alerts')}
    >
      <Bell size={17} />
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-neg text-white text-[10px] font-semibold grid place-items-center num" aria-hidden>
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  );
}

function IconToggles({ inDrawer }: { inDrawer?: boolean }) {
  const { t } = useTranslation();
  const privacy = useApp((s) => s.settings.privacy);
  const setSetting = useApp((s) => s.setSetting);
  const { resolved } = useTheme();
  return (
    <>
      <button
        className="btn btn-ghost btn-icon !h-9 !w-9 shrink-0"
        aria-pressed={privacy}
        aria-label={privacy ? t('top.showAmounts') : t('top.hideAmounts')}
        title={privacy ? t('top.showAmounts') : t('top.hideAmounts')}
        onClick={() => setSetting('privacy', !privacy)}
      >
        {privacy ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
      <button
        className={clsx('btn btn-ghost btn-icon !h-9 !w-9 shrink-0', !inDrawer && 'hidden sm:inline-flex')}
        aria-label={resolved === 'dark' ? t('top.lightTheme') : t('top.darkTheme')}
        title={resolved === 'dark' ? t('top.lightTheme') : t('top.darkTheme')}
        onClick={() => setSetting('theme', resolved === 'dark' ? 'light' : 'dark')}
      >
        {resolved === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>
    </>
  );
}

/** Mobile navigation drawer: a modal dialog with focus trap, Escape to close, focus restored. */
function Drawer({ onClose, returnTo }: { onClose: () => void; returnTo: React.RefObject<HTMLButtonElement> }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select, input') ?? []);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && (document.activeElement === first || !el?.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !el?.contains(document.activeElement))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    const btn = returnTo.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      btn?.focus();
    };
  }, [onClose, returnTo]);
  return (
    <div className="lg:hidden fixed inset-0 z-40 print:hidden">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.main')}
        data-testid="drawer"
        className="absolute inset-y-0 left-0 w-[272px] bg-surface border-r border-line py-4 flex flex-col gap-4 shadow-xl"
      >
        <div className="flex items-center justify-between pr-3">
          <Brand />
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>
        <Sidebar onNavigate={onClose} />
        <div className="mt-auto px-3 flex gap-1">
          <IconToggles inDrawer />
        </div>
      </div>
    </div>
  );
}

export function Layout() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const loc = useLocation();
  const navigate = useNavigate();
  const portfolios = usePortfolios();
  const ready = useApp((s) => s.ready);
  const setOnboardingOpen = useApp((s) => s.setOnboardingOpen);
  const stale = useApp(
    (s) =>
      !!s.analysis &&
      (s.analysis.baseCurrency !== s.settings.reportingCurrency || s.analysis.portfolioId !== s.settings.selectedPortfolioId),
  );
  useTheme();
  const first = useRef(true);
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
    if (first.current) {
      first.current = false;
      return;
    }
    // Move focus to the new page's heading (screen readers announce it; Shift+Tab reaches the header).
    const h = document.querySelector<HTMLElement>('main h1');
    if (h) {
      h.tabIndex = -1;
      h.focus({ preventScroll: true });
    }
  }, [loc.pathname]);

  // Empty database (e.g. after "delete all"): start the onboarding wizard.
  const portfolioCount = useLiveQuery(() => db.portfolios.count(), []);
  useEffect(() => {
    if (ready && portfolioCount === 0) setOnboardingOpen(true);
  }, [ready, portfolioCount, setOnboardingOpen]);

  // Keyboard shortcut: N = new transaction (outside inputs/dialogs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el.closest('input, textarea, select, [contenteditable], [role=dialog]')) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        navigate('/movimientos?nuevo=1');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);
  void portfolios;

  return (
    <div className="min-h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 btn btn-primary">
        {t('nav.skip')}
      </a>
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-[244px] flex-col gap-4 border-r border-line bg-surface py-4 print:hidden">
        <Brand />
        <Sidebar />
        <div className="mt-auto px-4 text-[11px] text-muted leading-relaxed">{t('nav.localNote')}</div>
      </aside>

      {open && <Drawer onClose={() => setOpen(false)} returnTo={menuBtn} />}

      <div className="lg:pl-[244px] min-w-0 print:pl-0">
        <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_85%,transparent)] backdrop-blur-md print:hidden">
          <div className="flex items-center gap-1.5 px-3 sm:px-4 lg:px-8 h-14">
            <button
              ref={menuBtn}
              className="btn btn-ghost btn-icon lg:hidden -ml-1 shrink-0"
              onClick={() => setOpen(true)}
              aria-label={t('nav.open')}
              aria-expanded={open}
              aria-haspopup="dialog"
              data-testid="menu-button"
            >
              <Menu size={19} />
            </button>
            <PortfolioSelect />
            <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
              <CurrencySwitch />
              <RefreshButton />
              <AlertsBell />
              <IconToggles />
            </div>
          </div>
        </header>
        <main
          id="main"
          tabIndex={-1}
          aria-busy={stale}
          className={clsx('px-4 lg:px-8 py-6 max-w-[1520px] mx-auto outline-none transition-opacity print:p-0 print:max-w-none', stale && 'opacity-60')}
        >
          <GlobalBanners />
          <Outlet />
        </main>
      </div>
      <OnboardingWizard />
    </div>
  );
}
