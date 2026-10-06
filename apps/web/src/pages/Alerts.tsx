import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import { Bell, BellRing, CheckCheck, Trash2 } from 'lucide-react';
import type { Instrument } from '@pm/core';
import { Banner, Card, EmptyState, Field, PageHeader } from '../components/ui';
import { InstrumentPicker } from '../components/InstrumentPicker';
import { db, type AlertKind } from '../db/schema';
import { upsertInstruments } from '../db/repo';
import { useInstrumentMap } from '../hooks/useData';
import { useApp, useFmt } from '../store/app';
import { formatDateTime, formatPct, formatPrice } from '../lib/format';
import { parseDecimal } from '../lib/parse';
import { addAlert, evaluateAlerts, requestNotificationPermission } from '../services/alerts';

const KINDS: AlertKind[] = ['priceAbove', 'priceBelow', 'dayMove', 'monthClose', 'dividend'];

/** Local alert rules + inbox of fired alerts (W11). Evaluated after every price refresh. */
export default function AlertsPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const [params] = useSearchParams();
  const map = useInstrumentMap();
  const rules = useLiveQuery(() => db.alerts.toArray(), []);
  const events = useLiveQuery(() => db.alertEvents.orderBy('createdAt').reverse().limit(100).toArray(), []);
  const notifications = useApp((s) => s.settings.notifications);
  const setSetting = useApp((s) => s.setSetting);
  const [kind, setKind] = useState<AlertKind>('priceBelow');
  const [inst, setInst] = useState<Instrument>();
  const [threshold, setThreshold] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    const id = params.get('instrumento');
    if (id && map.get(id)) setInst(map.get(id));
  }, [params, map]);

  const needsInstrument = kind === 'priceAbove' || kind === 'priceBelow' || kind === 'dayMove';
  const create = async () => {
    setError(undefined);
    let th: number | undefined;
    if (needsInstrument) {
      if (!inst) return setError(t('validation.instrument'));
      th = parseDecimal(threshold, f.locale);
      if (th === undefined || th <= 0) return setError(t('validation.positive'));
      if (kind === 'dayMove') th = th / 100;
      if (!map.has(inst.id)) await upsertInstruments([inst]);
    }
    await addAlert({ kind, instrumentId: needsInstrument ? inst!.id : undefined, threshold: th });
    setThreshold('');
    void evaluateAlerts();
  };

  const describe = (r: { kind: AlertKind; instrumentId?: string; threshold?: number }) => {
    const i = r.instrumentId ? map.get(r.instrumentId) : undefined;
    const sym = i?.symbol ?? r.instrumentId ?? '';
    if (r.kind === 'priceAbove' || r.kind === 'priceBelow') return t(`alerts.rule.${r.kind}`, { symbol: sym, price: formatPrice(r.threshold, i?.currency ?? 'USD', f.locale) });
    if (r.kind === 'dayMove') return t('alerts.rule.dayMove', { symbol: sym, pct: formatPct(r.threshold, f.locale, { decimals: 1 }) });
    return t(`alerts.rule.${r.kind}`);
  };

  return (
    <div>
      <PageHeader
        title={t('alerts.title')}
        subtitle={t('alerts.subtitle')}
        actions={
          <button
            className="btn"
            onClick={async () => {
              const ok = await requestNotificationPermission();
              setSetting('notifications', ok);
            }}
          >
            <BellRing size={15} /> {notifications ? t('alerts.notificationsOn') : t('alerts.enableNotifications')}
          </button>
        }
      />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Card title={t('alerts.newRule')}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Field label={t('alerts.kind')} htmlFor="al-kind">
              <select id="al-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as AlertKind)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`alerts.kinds.${k}`)}
                  </option>
                ))}
              </select>
            </Field>
            {needsInstrument && (
              <>
                <Field label={t('tx.instrument')} htmlFor="al-inst">
                  <InstrumentPicker inputId="al-inst" value={inst} onChange={setInst} onCreateManual={() => setError(t('watch.noManual'))} />
                </Field>
                <Field label={kind === 'dayMove' ? t('alerts.thresholdPct') : t('alerts.thresholdPrice', { currency: inst?.currency ?? '' })} htmlFor="al-th">
                  <input id="al-th" className="input num" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} data-testid="alert-threshold" />
                </Field>
              </>
            )}
            {error && <Banner tone="error">{error}</Banner>}
            <div className="flex justify-end">
              <button className="btn btn-primary" type="submit" data-testid="alert-create">
                <Bell size={15} /> {t('alerts.create')}
              </button>
            </div>
          </form>
        </Card>
        <Card title={t('alerts.rules')} bodyClassName="!p-0">
          <ul className="divide-y divide-line" data-testid="alert-rules">
            {(rules ?? []).map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <label className="flex items-center gap-2 flex-1 min-w-0">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => void db.alerts.update(r.id, { enabled: e.target.checked })} aria-label={t('alerts.enabled')} />
                  <span className={clsx('truncate', !r.enabled && 'text-muted line-through')}>{describe(r)}</span>
                </label>
                {r.lastFiredAt && <span className="text-[11px] text-muted">{formatDateTime(r.lastFiredAt, f.locale)}</span>}
                <button className="btn btn-sm btn-ghost btn-icon btn-danger" aria-label={t('common.delete')} onClick={() => void db.alerts.delete(r.id)}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
            {rules?.length === 0 && <li className="px-4 py-6 text-center text-muted text-sm">{t('alerts.noRules')}</li>}
          </ul>
        </Card>
      </div>
      <Card
        className="mt-3"
        title={t('alerts.inbox')}
        actions={
          events?.some((e) => !e.read) ? (
            <button className="btn btn-sm" onClick={() => void db.alertEvents.toCollection().modify({ read: true })}>
              <CheckCheck size={14} /> {t('alerts.markAllRead')}
            </button>
          ) : undefined
        }
        bodyClassName="!p-0"
      >
        {events && events.length === 0 ? (
          <EmptyState icon={<Bell size={20} />} title={t('alerts.emptyTitle')} body={t('alerts.emptyBody')} />
        ) : (
          <ul className="divide-y divide-line" data-testid="alert-events">
            {(events ?? []).map((e) => (
              <li key={e.id} className={clsx('px-4 py-3 text-[13px] flex gap-3', !e.read && 'bg-accent-soft/40')}>
                <span className={clsx('size-2 rounded-full mt-1.5 shrink-0', e.read ? 'bg-surface-3' : 'bg-accent')} aria-hidden />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">{e.title}</div>
                  <div className="text-ink-2 text-xs mt-0.5">{e.body}</div>
                  <div className="text-[11px] text-muted mt-1">{formatDateTime(e.createdAt, f.locale)}</div>
                </div>
                {e.href && (
                  <Link className="btn btn-sm self-start" to={e.href} onClick={() => void db.alertEvents.update(e.id, { read: true })}>
                    {t('alerts.open')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
