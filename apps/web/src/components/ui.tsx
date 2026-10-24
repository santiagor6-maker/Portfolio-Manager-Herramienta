import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, Minus, X, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatAmount, formatMoney, formatPct, trend, type MoneyOptions } from '../lib/format';
import { useFmt } from '../store/app';

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function Money({
  value,
  currency,
  className,
  ...opts
}: { value: number | undefined | null; currency?: string; className?: string } & MoneyOptions) {
  const f = useFmt();
  return (
    <span className={clsx('num', className)}>
      {formatMoney(value, currency ?? f.currency, f.locale, { privacy: f.privacy, ...opts })}
    </span>
  );
}

/** W51: an amount without the currency symbol, for tables that state the currency once. */
export function Amount({ value, className, signed }: { value: number | undefined | null; className?: string; signed?: boolean }) {
  const f = useFmt();
  return <span className={clsx('num', className)}>{formatAmount(value, f.currency, f.locale, { signed, privacy: f.privacy })}</span>;
}

export function Pct({
  value,
  signed,
  colored,
  decimals,
  className,
}: {
  value: number | undefined | null;
  signed?: boolean;
  colored?: boolean;
  decimals?: number;
  className?: string;
}) {
  const { locale } = useFmt();
  const dir = trend(value);
  return (
    <span className={clsx('num', colored && dir === 'up' && 'text-pos', colored && dir === 'down' && 'text-neg', className)}>
      {formatPct(value, locale, { signed, decimals })}
    </span>
  );
}

/** Coloured change with arrow + sign (colour is never the only cue). */
export function Delta({
  pct,
  amount,
  currency,
  size = 'md',
  className,
}: {
  pct?: number | null;
  amount?: number | null;
  currency?: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const f = useFmt();
  const dir = trend(amount ?? pct ?? 0);
  const Icon = dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus;
  return (
    <span
      className={clsx(
        'num inline-flex items-center gap-1 font-medium',
        dir === 'up' && 'text-pos',
        dir === 'down' && 'text-neg',
        dir === 'flat' && 'text-muted',
        size === 'sm' ? 'text-xs' : 'text-[13px]',
        className,
      )}
    >
      <Icon aria-hidden size={size === 'sm' ? 13 : 15} strokeWidth={2.4} />
      {amount !== undefined && amount !== null && (
        <span>{formatMoney(amount, currency ?? f.currency, f.locale, { signed: true, privacy: f.privacy })}</span>
      )}
      {pct !== undefined && pct !== null && (
        <span className={clsx(amount !== undefined && amount !== null && 'opacity-80')}>
          {amount !== undefined && amount !== null ? '(' : ''}
          {formatPct(pct, f.locale, { signed: true })}
          {amount !== undefined && amount !== null ? ')' : ''}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const hid = useId();
  return (
    <section className={clsx('card min-w-0', className)} aria-labelledby={title ? hid : undefined} id={id}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3.5 pb-1">
          <div className="min-w-0">
            {title && (
              <h2 id={hid} className="text-[13.5px] font-semibold text-ink">
                {title}
              </h2>
            )}
            {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
        </header>
      )}
      <div className={clsx('px-4 pb-4 pt-2', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="text-[13px] text-ink-2 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Kpi({
  label,
  value,
  sub,
  loading,
  hint,
  primary,
  className,
  valueCompact,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  loading?: boolean;
  hint?: string;
  /** D13: the page's headline figure (two columns wide, larger number). */
  primary?: boolean;
  /** Grid placement override (e.g. the primary card's span). */
  className?: string;
  /** D1/W57: the same figure in compact notation, used only when the full one cannot fit at the floor size (Money values derive it automatically). */
  valueCompact?: ReactNode;
}) {
  return (
    <div
      className={clsx(
        'card px-3 sm:px-4 py-2.5 sm:py-3.5 min-w-0',
        // W54: on the phone a secondary card is one row (label and sub-line left, figure right), so the
        // first chart's trace starts within the first screen.
        !primary && 'max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] max-sm:gap-x-3 max-sm:items-center',
        primary && 'kpi-primary',
        primary && !className && 'col-span-2',
        className,
      )}
      title={hint}
    >
      <div className="text-xs font-medium text-muted line-clamp-2 max-sm:col-start-1">{label}</div>
      {loading ? (
        <>
          <div className="skeleton h-7 w-3/4 mt-2" />
          <div className="skeleton h-4 w-1/2 mt-2" />
        </>
      ) : (
        <>
          <FitValue compact={valueCompact} primary={primary} className={primary ? undefined : 'max-sm:col-start-2 max-sm:row-start-1 max-sm:row-span-2 max-sm:text-right'}>
            {value}
          </FitValue>
          {sub && <div className="mt-1 text-[13px] max-sm:col-start-1 max-sm:mt-0.5">{sub}</div>}
        </>
      )}
    </div>
  );
}

/**
 * D1/W57/W58: a headline figure is never cut nor broken inside the number ("+COP 21.081.⏎632").
 * - It stays on one line and its font shrinks to the card, but never below a floor clearly larger than
 *   the label (16 px, 20 px for the headline card); below that it switches to compact notation
 *   ("+$ 8.568 M"), with the full figure always in the tooltip.
 * - Cards of one row share the smallest size, so a row never mixes 16 / 17 / 14 px figures.
 * - The decision is re-made on every fit from a hidden copy of the full figure (no sticky state), and a
 *   zero-width measurement (full-page capture, hidden tab) is ignored.
 */
function FitValue({ children, compact, primary, className }: { children: ReactNode; compact?: ReactNode; primary?: boolean; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const fullProbe = useRef<HTMLSpanElement>(null);
  const compactProbe = useRef<HTMLSpanElement>(null);
  const [useCompact, setUseCompact] = useState(false);
  // Money values get their compact form for free.
  const compactNode = compact ?? (isValidElement(children) && children.type === Money ? cloneElement(children as ReactElement<{ compact?: boolean }>, { compact: true }) : undefined);
  useLayoutEffect(() => {
    const el = box.current;
    const full = fullProbe.current;
    if (!el || !full) return;
    const fit = () => {
      const avail = el.clientWidth;
      if (!avail) return; // W58: hidden / zero-width layout pass: keep the last good fit.
      el.title = full.textContent ?? '';
      const base = parseFloat(getComputedStyle(full).fontSize) || 22;
      const floor = primary ? 20 : 16;
      const needed = full.scrollWidth ? Math.floor(base * (avail / full.scrollWidth) * 10) / 10 - 0.2 : base;
      let size = Math.min(base, needed);
      let compactNow = false;
      if (needed < floor && compactNode && compactProbe.current?.scrollWidth) {
        compactNow = true;
        size = Math.max(floor - 2, Math.min(base, Math.floor(base * (avail / compactProbe.current.scrollWidth) * 10) / 10 - 0.2));
      } else size = Math.max(MIN_FIT, size);
      if (compactNow !== useCompact) setUseCompact(compactNow);
      el.dataset.fit = String(size);
      el.style.fontSize = `${size}px`;
      if (!primary) syncRow(el);
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : undefined;
    ro?.observe(el);
    return () => ro?.disconnect();
  });
  return (
    <div className={clsx('relative overflow-hidden', className)}>
      <div ref={box} className="kpi-value font-semibold tracking-tight mt-1 text-ink whitespace-nowrap overflow-hidden" data-compact={useCompact || undefined}>
        {useCompact ? compactNode : children}
      </div>
      {/* Invisible copies at the natural size, for measuring only (outside .kpi-value so they never count as its text). */}
      <span ref={fullProbe} aria-hidden className="kpi-probe">
        {children}
      </span>
      {compactNode && (
        <span ref={compactProbe} aria-hidden className="kpi-probe">
          {compactNode}
        </span>
      )}
    </div>
  );
}

/** W57: secondary KPI figures on the same grid row share the smallest fitted size. */
function syncRow(el: HTMLElement) {
  const card = el.closest('.card');
  const grid = card?.parentElement;
  if (!card || !grid) return;
  const top = (card as HTMLElement).offsetTop;
  const row = Array.from(grid.querySelectorAll<HTMLElement>(':scope > .card:not(.kpi-primary) .kpi-value')).filter(
    (v) => (v.closest('.card') as HTMLElement).offsetTop === top && v.dataset.fit,
  );
  const min = Math.min(...row.map((v) => Number(v.dataset.fit)));
  for (const v of row) v.style.fontSize = `${min}px`;
}

const MIN_FIT = 12;

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} aria-hidden />;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center justify-center text-center py-10 px-4', className)}>
      {icon && <div className="mb-3 grid place-items-center size-11 rounded-full bg-surface-2 text-muted">{icon}</div>}
      <div className="font-semibold text-ink">{title}</div>
      {body && <p className="text-[13px] text-ink-2 mt-1 max-w-md">{body}</p>}
      {action && <div className="mt-4 flex gap-2 flex-wrap justify-center">{action}</div>}
    </div>
  );
}

export function Banner({
  tone = 'info',
  children,
  action,
  onClose,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  children: ReactNode;
  action?: ReactNode;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={clsx(
        'flex flex-wrap sm:flex-nowrap items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]',
        tone === 'info' && 'bg-info-soft border-info/30 text-ink',
        tone === 'warn' && 'bg-warn-soft border-warn/30 text-ink',
        tone === 'error' && 'bg-neg-soft border-neg/30 text-ink',
        tone === 'success' && 'bg-pos-soft border-pos/30 text-ink',
      )}
    >
      <Icon
        size={16}
        aria-hidden
        className={clsx(
          'mt-0.5 shrink-0',
          tone === 'info' && 'text-info',
          tone === 'warn' && 'text-warn',
          tone === 'error' && 'text-neg',
          tone === 'success' && 'text-pos',
        )}
      />
      <div className="flex-1 min-w-[200px]">{children}</div>
      {action && <div className="w-full sm:w-auto pl-[26px] sm:pl-0">{action}</div>}
      {onClose && (
        <button className="btn btn-ghost btn-sm btn-icon -my-1" onClick={onClose} aria-label={t('common.close')}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={clsx('seg', className)} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal (accessible dialog with focus trap + Escape)
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hid = useId();
  const { t } = useTranslation();
  // Keep the latest onClose without re-running the focus effect (a re-run would steal focus).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      Array.from(
        el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [],
      ).filter((n) => !n.hasAttribute('disabled'));
    setTimeout(() => {
      if (el && el.contains(document.activeElement)) return; // the user is already typing inside
      const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[1] ?? focusables()[0];
      first?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={hid}
        className={clsx(
          'relative card w-full max-h-[92vh] flex flex-col rounded-b-none sm:rounded-b-xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <h2 id={hid} className="font-semibold text-[15px]">
            {title}
          </h2>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-line flex justify-end gap-2 flex-wrap">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({
  label,
  error,
  children,
  hint,
  htmlFor,
  className,
}: {
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-neg mt-1" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted mt-1">{hint}</p>
      ) : null}
    </div>
  );
}

export function DemoBadge() {
  const { t } = useTranslation();
  return (
    <span className="chip !bg-warn-soft !text-warn !border-warn/30" title={t('demo.tooltip')}>
      {t('demo.badge')}
    </span>
  );
}

/**
 * D17: country as a two-letter tag. Regional-indicator flag emoji are not drawn on Windows (most users
 * in Colombia and Brazil), where they showed as loose letters.
 */
export function CountryTag({ code }: { code?: string }) {
  if (!code || !/^[A-Z]{2}$/i.test(code)) return null;
  return (
    <span className="inline-grid place-items-center h-4 min-w-[22px] px-1 rounded-[4px] border border-line-strong text-[9.5px] font-semibold tracking-wide text-ink-2 leading-none shrink-0" aria-hidden>
      {code.toUpperCase()}
    </span>
  );
}
