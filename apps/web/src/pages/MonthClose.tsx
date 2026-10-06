import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, CalendarCheck, CheckCircle2, Lock } from 'lucide-react';
import type { Holding } from '@pm/core';
import { db } from '../db/schema';
import { getMeta, setManualPrice, setMeta } from '../db/repo';
import { Banner, Card, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { useInstrumentMap } from '../hooks/useData';
import { useFmt } from '../store/app';
import { formatDate, formatMonth, formatPrice, formatQuantity } from '../lib/format';
import { addMonths, monthEnd, todayIso } from '../lib/ids';
import { holdingsAt } from '../services/engineDirect';
import { pendingCloses, pendingMonths } from '../lib/pendingCloses';
import { groupManualPrices } from '../hooks/useData';
import clsx from 'clsx';
import { parseDecimal, toInputNumber } from '../lib/parse';

export default function MonthClosePage() {
  const { t } = useTranslation();
  const f = useFmt();
  const map = useInstrumentMap();
  const today = todayIso();
  const defaultMonth = addMonths(today.slice(0, 7), -1);
  const [monthChoice, setMonth] = useState<string>();
  // Every month-end still missing a manual price since each instrument was bought (W5).
  const pending = useLiveQuery(async () => {
    const [txs, insts, manual] = await Promise.all([db.transactions.toArray(), db.instruments.toArray(), db.manualPrices.toArray()]);
    return pendingCloses(txs, insts, groupManualPrices(manual), today);
  }, [today]);
  const pendingList = pending ? pendingMonths(pending) : [];
  const month = monthChoice ?? pendingList[0] ?? defaultMonth;
  const [holdings, setHoldings] = useState<Holding[]>();
  const [error, setError] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [nextMsg, setNextMsg] = useState<string>();
  const closed = useLiveQuery(() => getMeta<string[]>('closedMonths'), [], undefined);
  const end = monthEnd(month);
  const manualRows = useLiveQuery(() => db.manualPrices.toArray(), []);
  const priceSeries = useLiveQuery(() => db.priceSeries.toArray(), []);

  useEffect(() => {
    let cancelled = false;
    setHoldings(undefined);
    setSaved(false);
    setError(undefined);
    holdingsAt(end)
      .then((h) => !cancelled && setHoldings(h))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [end]);

  /** Last known price on/before month end, and its date + source. */
  const lastPrice = useMemo(() => {
    const out = new Map<string, { close: number; date: string; source: 'manual' | 'auto' }>();
    for (const s of priceSeries ?? []) {
      const p = [...s.points].reverse().find((x) => x.date <= end);
      if (p) out.set(s.instrumentId, { close: p.close, date: p.date, source: 'auto' });
    }
    for (const m of manualRows ?? []) {
      if (m.date > end) continue;
      const prev = out.get(m.instrumentId);
      if (!prev || m.date >= prev.date) out.set(m.instrumentId, { close: m.close, date: m.date, source: 'manual' });
    }
    return out;
  }, [priceSeries, manualRows, end]);

  const needsManual = (holdings ?? []).filter((h) => {
    const inst = map.get(h.instrumentId);
    const lp = lastPrice.get(h.instrumentId);
    // Accrual instruments (CDT, CDB...) are valued by the engine: nothing to type.
    if (inst?.accrual) return false;
    return inst?.pricing === 'manual' || !lp || lp.date < `${month}-01`;
  });
  const automatic = (holdings ?? []).filter((h) => !needsManual.includes(h));

  useEffect(() => {
    const init: Record<string, string> = {};
    for (const h of needsManual) {
      const lp = lastPrice.get(h.instrumentId);
      const exact = (manualRows ?? []).find((m) => m.instrumentId === h.instrumentId && m.date === end);
      const v = exact?.close ?? lp?.close;
      init[h.instrumentId] = toInputNumber(v, f.locale);
    }
    setValues(init);
  }, [holdings, end]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalid = needsManual.filter((h) => {
    const v = parseDecimal(values[h.instrumentId] ?? '', f.locale);
    return v === undefined || v <= 0;
  });
  const isClosed = closed?.includes(month);

  const confirm = async () => {
    for (const h of needsManual) {
      const v = parseDecimal(values[h.instrumentId] ?? '', f.locale);
      if (v === undefined || v <= 0) continue;
      await setManualPrice({
        instrumentId: h.instrumentId,
        date: end,
        close: v,
        currency: map.get(h.instrumentId)?.currency ?? h.currency,
        note: t('close.note', { month }),
      });
    }
    const list = new Set(closed ?? []);
    list.add(month);
    await setMeta('closedMonths', [...list].sort());
    setSaved(true);
    // Walk the user through the remaining pending months, oldest first.
    const next = pendingList.find((m) => m !== month);
    if (next) {
      setNextMsg(t('close.nextPending', { month: formatMonth(next, f.locale, 'long') }));
      setMonth(next);
    } else setNextMsg(undefined);
  };

  const months = [...new Set([...Array.from({ length: 24 }, (_, i) => addMonths(today.slice(0, 7), -i)), ...pendingList])].sort().reverse();

  return (
    <div>
      <Link to="/mensual" className="btn btn-ghost btn-sm -ml-2 mb-2">
        <ArrowLeft size={14} /> {t('nav.monthly')}
      </Link>
      <PageHeader
        title={t('close.title')}
        subtitle={t('close.subtitle')}
        actions={
          <>
            <label htmlFor="close-month" className="sr-only">
              {t('close.month')}
            </label>
            <select id="close-month" className="select !w-auto" value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => (
                <option key={m} value={m}>
                  {formatMonth(m, f.locale, 'long')}
                  {closed?.includes(m) ? ' ✓' : ''}
                  {pendingList.includes(m) ? ` · ${t('close.pendingShort')}` : ''}
                </option>
              ))}
            </select>
          </>
        }
      />

      {pendingList.length > 0 && (
        <div className="mb-3" data-testid="pending-months">
          <Banner tone="warn">
            <div className="font-semibold">{t('close.pendingTitle', { count: pendingList.length })}</div>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {(pending ?? []).flatMap((p) =>
                p.months.map((m) => (
                  <button key={`${p.instrumentId}${m}`} type="button" className={clsx('chip hover:!border-accent', m === month && '!border-accent !text-accent')} onClick={() => setMonth(m)}>
                    {formatMonth(m, f.locale)} · {map.get(p.instrumentId)?.symbol ?? p.instrumentId}
                  </button>
                )),
              )}
            </div>
          </Banner>
        </div>
      )}
      {nextMsg && (
        <div className="mb-3">
          <Banner tone="info">{nextMsg}</Banner>
        </div>
      )}
      {isClosed && !saved && (
        <div className="mb-3">
          <Banner tone="success">{t('close.alreadyClosed', { month: formatMonth(month, f.locale, 'long') })}</Banner>
        </div>
      )}
      {saved && (
        <div className="mb-3">
          <Banner tone="success">{t('close.saved', { month: formatMonth(month, f.locale, 'long') })}</Banner>
        </div>
      )}
      {error && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      <Card
        title={t('close.manualTitle', { date: formatDate(end, f.locale) })}
        subtitle={t('close.manualSub')}
        bodyClassName="!p-0"
      >
        {!holdings ? (
          <div className="p-4">
            <Skeleton className="h-32" />
          </div>
        ) : needsManual.length === 0 ? (
          <EmptyState icon={<CheckCircle2 size={20} />} title={t('close.nothingManual')} body={t('close.nothingManualBody')} />
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('pos.instrument')}</th>
                    <th className="r">{t('pos.quantity')}</th>
                    <th className="r">{t('close.lastKnown')}</th>
                    <th className="r">{t('close.priceAt', { date: formatDate(end, f.locale, 'short') })}</th>
                  </tr>
                </thead>
                <tbody>
                  {needsManual.map((h) => {
                    const inst = map.get(h.instrumentId);
                    const lp = lastPrice.get(h.instrumentId);
                    const bad = invalid.includes(h);
                    const id = `px-${h.instrumentId}`;
                    return (
                      <tr key={h.instrumentId}>
                        <td>
                          <div className="font-semibold">{inst?.symbol ?? h.instrumentId}</div>
                          <div className="text-xs text-muted">
                            {inst?.name} · {inst?.pricing === 'manual' ? t('pos.manual') : t('close.noAutoPrice')}
                          </div>
                        </td>
                        <td className="r num">{formatQuantity(h.quantity, f.locale, f.privacy)}</td>
                        <td className="r num text-ink-2">
                          {lp ? (
                            <>
                              {formatPrice(lp.close, h.currency, f.locale)}
                              <div className="text-[11px] text-muted">{formatDate(lp.date, f.locale, 'short')}</div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="r">
                          <label htmlFor={id} className="sr-only">
                            {t('close.priceFor', { symbol: inst?.symbol ?? h.instrumentId })}
                          </label>
                          <div className="inline-flex items-center gap-1.5">
                            <input
                              id={id}
                              inputMode="decimal"
                              className="input !w-36 text-right num"
                              aria-invalid={bad}
                              value={values[h.instrumentId] ?? ''}
                              onChange={(e) => setValues((v) => ({ ...v, [h.instrumentId]: e.target.value }))}
                            />
                            <span className="text-xs text-muted w-8">{h.currency}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-2 p-3 border-t border-line flex-wrap">
              <p className="text-xs text-muted">{invalid.length ? t('close.invalid', { count: invalid.length }) : t('close.ready')}</p>
              <button className="btn btn-primary" type="submit" disabled={invalid.length === needsManual.length}>
                <CalendarCheck size={15} /> {t('close.confirm')}
              </button>
            </div>
          </form>
        )}
      </Card>

      <Card className="mt-3" title={t('close.autoTitle')} subtitle={t('close.autoSub')} bodyClassName="!p-0">
        {!holdings ? (
          <div className="p-4">
            <Skeleton className="h-24" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('pos.instrument')}</th>
                  <th className="r">{t('pos.quantity')}</th>
                  <th className="r">{t('close.monthEndPrice')}</th>
                  <th className="r">{t('close.date')}</th>
                </tr>
              </thead>
              <tbody>
                {automatic.map((h) => {
                  const inst = map.get(h.instrumentId);
                  const lp = lastPrice.get(h.instrumentId);
                  return (
                    <tr key={h.instrumentId}>
                      <td>
                        <span className="font-semibold">{inst?.symbol ?? h.instrumentId}</span>{' '}
                        <span className="text-xs text-muted">{inst?.name}</span>
                      </td>
                      <td className="r num">{formatQuantity(h.quantity, f.locale, f.privacy)}</td>
                      <td className="r num">{lp ? formatPrice(lp.close, h.currency, f.locale) : '—'}</td>
                      <td className="r text-muted">
                        <span className="inline-flex items-center gap-1">
                          <Lock size={12} aria-hidden /> {inst?.accrual ? t('close.accrual') : lp ? formatDate(lp.date, f.locale, 'short') : '—'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {!automatic.length && (
                  <tr>
                    <td colSpan={4} className="text-center text-muted !py-6">
                      —
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

