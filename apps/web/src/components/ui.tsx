import { useEffect, useId, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, Minus, X, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatMoney, formatPct, trend, type MoneyOptions } from '../lib/format';
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
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  loading?: boolean;
  hint?: string;
}) {
  return (
    <div className="card px-4 py-3.5 min-w-0" title={hint}>
      <div className="text-xs font-medium text-muted truncate">{label}</div>
      {loading ? (
        <>
          <div className="skeleton h-7 w-3/4 mt-2" />
          <div className="skeleton h-4 w-1/2 mt-2" />
        </>
      ) : (
        <>
          <div className="text-[22px] font-semibold tracking-tight mt-1 truncate text-ink">{value}</div>
          {sub && <div className="mt-1 text-[13px] truncate">{sub}</div>}
        </>
      )}
    </div>
  );
}

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
