import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Landmark } from 'lucide-react';
import type { IncomeEvent } from '@pm/core';
import { Card, EmptyState, Kpi, Money, PageHeader, Pct, Skeleton } from '../components/ui';
import { GroupedBars } from '../components/charts';
import { useAnalysis, useInstrumentLabel } from '../hooks/useAnalysis';
import { useFmt } from '../store/app';
import { formatDate, formatMoney, formatMonth, formatPct, monthName } from '../lib/format';
import { addDays, addMonths } from '../lib/ids';
import { countryName, flagEmoji } from '../lib/labels';

/** Gross and withholding in base currency, derived from the event's net/base ratio. */
export function toBase(e: IncomeEvent): { grossBase: number; taxesBase: number } {
  const rate = e.net ? e.netBase / e.net : 0;
  return { grossBase: e.gross * rate, taxesBase: e.taxes * rate };
}

export default function DividendsPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a, loading } = useAnalysis();
  const label = useInstrumentLabel();
  const events = useMemo(() => [...(a?.income ?? [])].sort((x, y) => (x.date < y.date ? 1 : -1)), [a]);
  const years = useMemo(() => [...new Set(events.map((e) => e.date.slice(0, 4)))].sort().reverse(), [events]);
  const [year, setYear] = useState<string>();
  const selYear = year ?? years[0] ?? (a?.asOf ?? '').slice(0, 4);

  const asOf = a?.asOf ?? '';
  const ttmFrom = addDays(asOf, -365);
  const ttm = events.filter((e) => e.date > ttmFrom && e.date <= asOf);
  const ttmNet = ttm.reduce((s, e) => s + e.netBase, 0);
  const yearEvents = events.filter((e) => e.date.startsWith(selYear));
  const yearNet = yearEvents.reduce((s, e) => s + e.netBase, 0);
  const yearTaxes = yearEvents.reduce((s, e) => s + toBase(e).taxesBase, 0);
  const yearGross = yearEvents.reduce((s, e) => s + toBase(e).grossBase, 0);
  const costBase = (a?.valuation?.holdings ?? []).reduce((s, h) => s + h.costBasisBase, 0);
  const valueBase = (a?.valuation?.holdings ?? []).reduce((s, h) => s + (h.marketValueBase ?? 0), 0);
  const prevYear = String(Number(selYear) - 1);
  const prevNet = events.filter((e) => e.date.startsWith(prevYear)).reduce((s, e) => s + e.netBase, 0);
  // Like-for-like (W8): for the running year compare against the same period of last year.
  const isCurrentYear = selYear === asOf.slice(0, 4);
  const cutoff = `${prevYear}${asOf.slice(4)}`;
  const prevSamePeriod = isCurrentYear ? events.filter((e) => e.date.startsWith(prevYear) && e.date <= cutoff).reduce((s, e) => s + e.netBase, 0) : prevNet;

  // Monthly bars for the last 4 years.
  const chartYears = years.slice(0, 4).reverse();
  const chart = useMemo(() => {
    const series = chartYears.map((y, i) => ({
      name: y,
      colorIndex: i,
      data: Array.from({ length: 12 }, (_, m) =>
        events.filter((e) => e.date.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`)).reduce((s, e) => s + e.netBase, 0),
      ),
    }));
    return { categories: Array.from({ length: 12 }, (_, m) => monthName(m, f.locale)), series };
  }, [chartYears.join(), events, f.locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const moneyFmt = useCallback(
    (v: number, axis?: boolean) => (f.privacy ? '•••' : formatMoney(v, f.currency, f.locale, { compact: axis })),
    [f.currency, f.locale, f.privacy],
  );

  const byCountry = useMemo(() => {
    const m = new Map<string, { gross: number; taxes: number; net: number }>();
    for (const e of yearEvents) {
      const c = e.instrumentId ? (label(e.instrumentId).inst?.country ?? '—') : 'CASH';
      const r = m.get(c) ?? { gross: 0, taxes: 0, net: 0 };
      const b = toBase(e);
      r.gross += b.grossBase;
      r.taxes += b.taxesBase;
      r.net += e.netBase;
      m.set(c, r);
    }
    return [...m.entries()].sort((x, y) => y[1].net - x[1].net);
  }, [yearEvents, label]);

  const byInstrument = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of ttm) if (e.instrumentId) m.set(e.instrumentId, (m.get(e.instrumentId) ?? 0) + e.netBase);
    return (a?.valuation?.holdings ?? [])
      .filter((h) => h.quantity > 0)
      .map((h) => ({
        id: h.instrumentId,
        ttm: m.get(h.instrumentId) ?? 0,
        yoc: h.costBasisBase ? (m.get(h.instrumentId) ?? 0) / h.costBasisBase : undefined,
        yld: h.marketValueBase ? (m.get(h.instrumentId) ?? 0) / h.marketValueBase : undefined,
      }))
      .filter((r) => r.ttm > 0)
      .sort((x, y) => y.ttm - x.ttm);
  }, [ttm, a]);

  if (!loading && !events.length) {
    return (
      <div>
        <PageHeader title={t('div.title')} />
        <div className="card">
          <EmptyState icon={<Landmark size={20} />} title={t('div.emptyTitle')} body={t('div.emptyBody')} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t('div.title')}
        subtitle={t('div.subtitle', { currency: f.currency })}
        actions={
          <select className="select !w-auto" aria-label={t('monthly.year')} value={selYear} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        }
      />
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Kpi
          loading={loading}
          label={t('div.yearNet', { year: selYear })}
          value={<Money value={yearNet} />}
          sub={
            prevSamePeriod ? (
              <span className="text-xs text-muted" data-testid="div-yoy">
                {isCurrentYear ? t('div.vsPrevSamePeriod', { year: prevYear }) : t('div.vsPrev', { year: prevYear })} <Pct value={yearNet / prevSamePeriod - 1} signed colored />
                {isCurrentYear && prevNet ? (
                  <span className="block">
                    {t('div.prevFullYear', { year: prevYear })}: {formatMoney(prevNet, f.currency, f.locale, { privacy: f.privacy })}
                  </span>
                ) : null}
              </span>
            ) : undefined
          }
        />
        <Kpi loading={loading} label={t('div.ttm')} value={<Money value={ttmNet} />} sub={<span className="text-xs text-muted">{t('div.monthlyAvg')}: {formatMoney(ttmNet / 12, f.currency, f.locale, { privacy: f.privacy })}</span>} />
        <Kpi
          loading={loading}
          label={t('div.yoc')}
          value={<Pct value={costBase ? ttmNet / costBase : undefined} />}
          sub={
            <span className="text-xs text-muted">
              {t('div.currentYield')}: <Pct value={valueBase ? ttmNet / valueBase : undefined} />
            </span>
          }
        />
        <Kpi
          loading={loading}
          label={t('div.withholding', { year: selYear })}
          value={<Money value={yearTaxes} />}
          sub={
            <span className="text-xs text-muted">
              {t('div.effectiveRate')}: <Pct value={yearGross ? yearTaxes / yearGross : undefined} />
            </span>
          }
        />
      </div>

      <UpcomingCalendar />

      <Card className="mt-3" title={t('div.byMonth')} subtitle={t('div.byMonthSub')}>
        {loading ? <Skeleton className="h-64" /> : <GroupedBars categories={chart.categories} series={chart.series} valueFormat={moneyFmt} ariaLabel={t('div.byMonth')} height={260} />}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-3">
        <Card title={t('div.byCountry', { year: selYear })} bodyClassName="!p-0">
          <table className="table">
            <thead>
              <tr>
                <th>{t('dim.country')}</th>
                <th className="r">{t('div.gross')}</th>
                <th className="r">{t('div.withheld')}</th>
                <th className="r">{t('div.rate')}</th>
                <th className="r">{t('div.net')}</th>
              </tr>
            </thead>
            <tbody>
              {byCountry.map(([c, r]) => (
                <tr key={c}>
                  <td>
                    {c === 'CASH' ? (
                      t('div.cashInterest')
                    ) : (
                      <>
                        <span aria-hidden>{flagEmoji(c)}</span> {countryName(c, f.locale)}
                      </>
                    )}
                  </td>
                  <td className="r">
                    <Money value={r.gross} />
                  </td>
                  <td className="r">
                    <Money value={r.taxes} className="text-muted" />
                  </td>
                  <td className="r">
                    <Pct value={r.gross ? r.taxes / r.gross : undefined} decimals={1} />
                  </td>
                  <td className="r font-semibold">
                    <Money value={r.net} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title={t('div.byInstrument')} subtitle={t('div.byInstrumentSub')} bodyClassName="!p-0">
          <div className="max-h-[360px] overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('pos.instrument')}</th>
                  <th className="r">{t('div.ttmShort')}</th>
                  <th className="r">{t('div.yocShort')}</th>
                  <th className="r">{t('div.yieldShort')}</th>
                </tr>
              </thead>
              <tbody>
                {byInstrument.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="font-semibold">{label(r.id).symbol}</span> <span className="text-xs text-muted">{label(r.id).name}</span>
                    </td>
                    <td className="r">
                      <Money value={r.ttm} />
                    </td>
                    <td className="r">
                      <Pct value={r.yoc} />
                    </td>
                    <td className="r">
                      <Pct value={r.yld} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card className="mt-3" title={t('div.payments', { year: selYear })} bodyClassName="!p-0">
        <div className="max-h-[480px] overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('tx.date')}</th>
                <th>{t('pos.instrument')}</th>
                <th className="r">{t('div.gross')}</th>
                <th className="r">{t('div.withheld')}</th>
                <th className="r">{t('div.net')}</th>
                <th className="r">{t('div.netBase', { currency: f.currency })}</th>
              </tr>
            </thead>
            <tbody>
              {yearEvents.map((e, i) => (
                <tr key={i}>
                  <td className="num">{formatDate(e.date, f.locale, 'short')}</td>
                  <td>
                    <span className="font-semibold">{e.instrumentId ? label(e.instrumentId).symbol : t('tx.type.INTEREST')}</span>
                    {e.type === 'INTEREST' && e.instrumentId && <span className="chip ml-2">{t('tx.type.INTEREST')}</span>}
                  </td>
                  <td className="r num">{formatMoney(e.gross, e.currency, f.locale, { privacy: f.privacy })}</td>
                  <td className="r num text-muted">{formatMoney(e.taxes, e.currency, f.locale, { privacy: f.privacy })}</td>
                  <td className="r num">{formatMoney(e.net, e.currency, f.locale, { privacy: f.privacy })}</td>
                  <td className="r font-semibold">
                    <Money value={e.netBase} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/** Next 12 months: provider-announced dividends + projection from last year's payments (W12). */
function UpcomingCalendar() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a } = useAnalysis();
  const label = useInstrumentLabel();
  const list = a?.upcomingDividends ?? [];
  const months = useMemo(() => {
    if (!a) return [];
    const start = a.asOf.slice(0, 7);
    return Array.from({ length: 12 }, (_, i) => addMonths(start, i));
  }, [a]);
  const moneyFmt = useCallback(
    (v: number, axis?: boolean) => (f.privacy ? '•••' : formatMoney(v, f.currency, f.locale, { compact: axis })),
    [f.currency, f.locale, f.privacy],
  );
  const series = useMemo(
    () => [
      { name: t('div.announced'), colorIndex: 0, data: months.map((m) => list.filter((d) => d.source === 'provider' && d.payDate.startsWith(m)).reduce((s, d) => s + d.netBase, 0)) },
      { name: t('div.estimated'), colorIndex: 2, data: months.map((m) => list.filter((d) => d.source === 'history' && d.payDate.startsWith(m)).reduce((s, d) => s + d.netBase, 0)) },
    ],
    [months, list, t],
  );
  if (!list.length) return null;
  const total = list.reduce((s, d) => s + d.netBase, 0);
  return (
    <Card className="mt-3" title={t('div.calendar')} subtitle={t('div.calendarSub', { total: formatMoney(total, f.currency, f.locale, { privacy: f.privacy }) })}>
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <div className="xl:col-span-3">
          <GroupedBars categories={months.map((m) => formatMonth(m, f.locale))} series={series} valueFormat={moneyFmt} ariaLabel={t('div.calendar')} height={230} stacked />
        </div>
        <ul className="xl:col-span-2 text-[13px] flex flex-col gap-1 max-h-[260px] overflow-auto" data-testid="div-calendar">
          {list.slice(0, 30).map((d, i) => (
            <li key={i} className="flex items-center gap-2 border-b border-line/60 py-1">
              <span className="w-20 font-semibold truncate">{label(d.instrumentId).symbol}</span>
              <span className="text-xs text-muted flex-1">
                {d.source === 'history' ? '≈ ' : ''}
                {formatDate(d.payDate, f.locale)}
                {d.source === 'provider' && <span className="chip !h-4 ml-1.5 !text-[10px]">{t('div.announced')}</span>}
              </span>
              <span className="text-[11px] text-muted" title={t('div.withholdingEst')}>
                −{formatPct(d.withholdingRate, f.locale, { decimals: 0 })}
              </span>
              <Money value={d.netBase} className="text-ink-2" />
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
