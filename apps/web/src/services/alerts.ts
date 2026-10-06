/**
 * Local alerts (no server): price above/below, big daily move, pending month-end closes and
 * upcoming announced dividends. Rules live in IndexedDB; fired alerts become AlertEvents shown
 * in the bell menu and, when the user allowed it, as system notifications (Notification API).
 */
import { db, type AlertEvent, type AlertRule } from '../db/schema';
import { newId, todayIso, addDays } from '../lib/ids';
import { pendingCloses } from '../lib/pendingCloses';
import { groupManualPrices } from '../hooks/useData';
import { useApp } from '../store/app';
import i18n from '../i18n';
import { formatPct, formatPrice, LOCALE_BY_LANG } from '../lib/format';

export async function addAlert(rule: Omit<AlertRule, 'id' | 'createdAt' | 'enabled'> & { enabled?: boolean }): Promise<AlertRule> {
  const r: AlertRule = { enabled: true, ...rule, id: newId('al'), createdAt: Date.now() };
  await db.alerts.put(r);
  return r;
}

export async function ensureDefaultAlerts(): Promise<void> {
  if ((await db.alerts.count()) > 0) return;
  await db.alerts.bulkPut([
    { id: 'default-monthclose', kind: 'monthClose', enabled: true, createdAt: Date.now() },
    { id: 'default-dividend', kind: 'dividend', enabled: true, createdAt: Date.now() },
  ]);
}

async function fire(rule: AlertRule, key: string, ev: Omit<AlertEvent, 'id' | 'createdAt' | 'read' | 'kind' | 'ruleId'>): Promise<AlertEvent | undefined> {
  if (rule.lastFiredKey === key) return undefined;
  const event: AlertEvent = { ...ev, id: newId('ev'), ruleId: rule.id, kind: rule.kind, createdAt: Date.now(), read: false };
  await db.alertEvents.put(event);
  await db.alerts.update(rule.id, { lastFiredAt: Date.now(), lastFiredKey: key });
  const { settings } = useApp.getState();
  try {
    if (settings.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(event.title, { body: event.body, tag: key });
    }
  } catch {
    /* notifications unavailable */
  }
  return event;
}

/** Evaluates every enabled rule against cached data. Returns the events fired now. */
export async function evaluateAlerts(today = todayIso()): Promise<AlertEvent[]> {
  const t = i18n.t.bind(i18n);
  const locale = LOCALE_BY_LANG[useApp.getState().settings.language];
  const [rules, prices, instruments, transactions, manual, actions, portfolios] = await Promise.all([
    db.alerts.toArray(),
    db.priceSeries.toArray(),
    db.instruments.toArray(),
    db.transactions.toArray(),
    db.manualPrices.toArray(),
    db.corporateActions.toArray(),
    db.portfolios.toArray(),
  ]);
  const demo = new Set(portfolios.filter((p) => p.isDemo).map((p) => p.id));
  const realTxs = transactions.filter((x) => !demo.has(x.portfolioId));
  const inst = new Map(instruments.map((i) => [i.id, i]));
  const series = new Map(prices.map((p) => [p.instrumentId, p.points]));
  const out: AlertEvent[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const sym = r.instrumentId ? (inst.get(r.instrumentId)?.symbol ?? r.instrumentId) : '';
    const pts = r.instrumentId ? (series.get(r.instrumentId) ?? []) : [];
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const ccy = r.instrumentId ? (inst.get(r.instrumentId)?.currency ?? 'USD') : 'USD';
    let ev: AlertEvent | undefined;
    if ((r.kind === 'priceAbove' || r.kind === 'priceBelow') && last && r.threshold !== undefined) {
      const hit = r.kind === 'priceAbove' ? last.close >= r.threshold : last.close <= r.threshold;
      if (hit)
        ev = await fire(r, `${last.date}`, {
          title: t(`alerts.fired.${r.kind}`, { symbol: sym, price: formatPrice(r.threshold, ccy, locale) }),
          body: t('alerts.fired.priceBody', { symbol: sym, price: formatPrice(last.close, ccy, locale), date: last.date }),
          href: `/posiciones/${encodeURIComponent(r.instrumentId!)}`,
        });
    } else if (r.kind === 'dayMove' && last && prev && prev.close) {
      const ch = last.close / prev.close - 1;
      if (Math.abs(ch) >= (r.threshold ?? 0.05))
        ev = await fire(r, last.date, {
          title: t('alerts.fired.dayMove', { symbol: sym, change: formatPct(ch, locale, { signed: true }) }),
          body: t('alerts.fired.priceBody', { symbol: sym, price: formatPrice(last.close, ccy, locale), date: last.date }),
          href: `/posiciones/${encodeURIComponent(r.instrumentId!)}`,
        });
    } else if (r.kind === 'monthClose') {
      const pending = pendingCloses(realTxs, instruments, groupManualPrices(manual), today);
      const n = pending.reduce((s, p) => s + p.months.length, 0);
      if (n > 0)
        ev = await fire(r, today.slice(0, 7), {
          title: t('alerts.fired.monthClose', { count: n }),
          body: pending.map((p) => `${inst.get(p.instrumentId)?.symbol ?? p.instrumentId}: ${p.months.join(', ')}`).join(' · '),
          href: '/mensual/cierre',
        });
    } else if (r.kind === 'dividend') {
      const held = new Set(realTxs.filter((x) => x.type === 'BUY').map((x) => x.instrumentId));
      const soon = actions.filter((a) => a.type === 'DIVIDEND' && held.has(a.instrumentId) && (a.payDate ?? a.date) > today && (a.payDate ?? a.date) <= addDays(today, 7));
      if (soon.length)
        ev = await fire(r, soon.map((a) => a.id).join(','), {
          title: t('alerts.fired.dividend', { count: soon.length }),
          body: soon.map((a) => `${inst.get(a.instrumentId)?.symbol ?? a.instrumentId} · ${a.payDate ?? a.date}`).join(' · '),
          href: '/dividendos',
        });
    }
    if (ev) out.push(ev);
  }
  return out;
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  return p === 'granted';
}
