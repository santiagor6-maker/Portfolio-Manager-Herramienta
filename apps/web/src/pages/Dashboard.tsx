import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRight, CalendarClock, Database, Plus, Upload, Wallet } from 'lucide-react';
import type { AllocationDimension } from '@pm/core';
import { Banner, Card, Delta, EmptyState, Kpi, Money, PageHeader, Pct, Segmented, Skeleton } from '../components/ui';
import { AllocationDonut, ReturnBars, ValueChart } from '../components/charts';
import { seriesForPeriod, useAnalysis, useInstrumentLabel, type ChartPeriod } from '../hooks/useAnalysis';
import { useSliceLabel } from '../lib/labels';
import { useApp, useFmt } from '../store/app';
import { formatDate, formatMonth, formatRelative } from '../lib/format';
import { indexName } from '../lib/labels';
import { GettingStarted } from '../components/Onboarding';
import { addDays, addMonths, monthEnd } from '../lib/ids';
import { useInstrumentMap } from '../hooks/useData';
import { previousBusinessDay } from '../services/analysis';
import { benchmarkName } from '../lib/benchmarks';

const DIMS: AllocationDimension[] = ['country', 'currency', 'assetClass', 'sector'];

export default function DashboardPage() {
  const { t } = useTranslation();
  const { analysis: a, loading } = useAnalysis();
  const f = useFmt();
  const [period, setPeriod] = useState<ChartPeriod>('ALL');
  const [dim, setDim] = useState<AllocationDimension>('country');
  const sliceLabel = useSliceLabel(dim);
  const label = useInstrumentLabel();
  const benchmarks = useApp((s) => s.settings.benchmarks);

  const series = useMemo(() => seriesForPeriod(a, period), [a, period]);
  const v = a?.valuation;
  const day = a?.summaries.DAY;
  const mtd = a?.summaries.MTD;
  const ytd = a?.summaries.YTD;
  const si = a?.summaries.SI;

  // Prices older than the previous business day: a "today" change would be meaningless.
  const stalePrices = !!a?.latestPriceDate && a.latestPriceDate < previousBusinessDay(a.asOf);
  const rateIdx = a?.rateIndices[0];
  const periodSummary =
    period === 'MTD' ? mtd : period === 'YTD' ? ytd : period === '1Y' ? a?.summaries['1Y'] : period === '3Y' ? a?.summaries['3Y'] : si;

  if (!loading && a && !a.hasTransactions) return <EmptyDashboard />;

  const last12 = (a?.monthly ?? []).slice(-12);
  const bench = benchmarks[0];

  return (
    <div>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={a ? t('dashboard.asOf', { date: formatDate(a.asOf, f.locale) }) : undefined}
        actions={
          <Link to="/movimientos?nuevo=1" className="btn btn-primary">
            <Plus size={15} /> {t('tx.add')}
          </Link>
        }
      />

      <GettingStarted />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3" data-testid="kpis">
        <Kpi
          loading={loading}
          label={t('dashboard.totalValue')}
          value={<Money value={v?.totalMarketValueBase} />}
          sub={
            stalePrices && a?.latestPriceDate ? (
              <span className="text-muted text-xs">{t('dashboard.pricesAsOf', { date: formatDate(a.latestPriceDate, f.locale) })}</span>
            ) : day ? (
              <span className="flex items-center gap-1.5">
                <Delta amount={day.gainBase} pct={day.twr} size="sm" />
                <span className="text-muted text-xs">
                  {a?.latestPriceDate && a.latestPriceDate < a.asOf
                    ? t('dashboard.sinceClose', { date: formatDate(a.movers[0]?.prevDate ?? previousBusinessDay(a.latestPriceDate), f.locale) })
                    : t('dashboard.today')}
                </span>
              </span>
            ) : (
              <span className="text-muted text-xs">—</span>
            )
          }
        />
        <Kpi
          loading={loading}
          label={t('dashboard.month')}
          value={<Money value={mtd?.gainBase} signed />}
          sub={<Pct value={mtd?.twr} signed colored />}
        />
        <Kpi
          loading={loading}
          label={t('dashboard.ytd')}
          value={<Money value={ytd?.gainBase} signed />}
          sub={<Pct value={ytd?.twr} signed colored />}
        />
        <Kpi
          loading={loading}
          label={t('dashboard.totalGain')}
          value={<Money value={si?.gainBase} signed />}
          sub={
            <span className="flex items-center gap-2 flex-wrap">
              <Pct value={si?.twr} signed colored />
              {si?.realTwr !== undefined && (
                <span className="text-muted text-xs" title={t('dashboard.realHint', { index: indexName(a?.inflationIndex) })}>
                  {t('dashboard.real')} <Pct value={si.realTwr} signed />
                </span>
              )}
              {rateIdx && si?.percentOfIndex?.[rateIdx] !== undefined && (
                <span className="text-muted text-xs" data-testid="pct-index">
                  <Pct value={si.percentOfIndex[rateIdx]} decimals={0} /> {t('dashboard.ofIndex', { index: indexName(rateIdx) })}
                </span>
              )}
            </span>
          }
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 mt-3">
        <Card
          className="xl:col-span-2"
          title={t('dashboard.valueVsInvested')}
          subtitle={
            periodSummary ? (
              <span className="flex items-center gap-2 flex-wrap">
                <span>{t('dashboard.periodGain')}</span>
                <Delta amount={periodSummary.gainBase} pct={periodSummary.twr} size="sm" />
              </span>
            ) : undefined
          }
          actions={
            <Segmented
              label={t('common.period')}
              value={period}
              onChange={setPeriod}
              options={[
                { value: 'MTD', label: t('period.MTD') },
                { value: 'YTD', label: t('period.YTD') },
                { value: '1Y', label: t('period.1Y') },
                { value: '3Y', label: t('period.3Y') },
                { value: 'ALL', label: t('period.ALL') },
              ]}
            />
          }
        >
          {loading ? <Skeleton className="h-[300px]" /> : series.length ? <ValueChart data={series} inflationLabel={a?.inflationIndex ? indexName(a.inflationIndex) : undefined} /> : <NoSeries />}
        </Card>

        <Card
          title={t('dashboard.allocation')}
          actions={
            <label className="sr-only" htmlFor="alloc-dim">
              {t('dashboard.allocationBy')}
            </label>
          }
        >
          <div className="mb-3 -mt-1">
            <Segmented
              label={t('dashboard.allocationBy')}
              value={dim}
              onChange={setDim}
              options={DIMS.map((d) => ({ value: d, label: t(`dim.${d}`) }))}
            />
          </div>
          {loading ? <Skeleton className="h-[170px]" /> : <AllocationDonut slices={a?.allocations[dim] ?? []} labelFor={sliceLabel} />}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3 mt-3">
        <Card
          title={t('dashboard.last12')}
          actions={
            <Link to="/mensual" className="btn btn-ghost btn-sm">
              {t('dashboard.seeMonthly')} <ArrowRight size={14} />
            </Link>
          }
        >
          {loading ? (
            <Skeleton className="h-[220px]" />
          ) : last12.length ? (
            <ReturnBars
              data={last12.map((m) => ({ month: m.month, twr: m.twr, bench: bench ? m.benchmarkReturns?.[bench] : undefined }))}
              benchmark={bench && last12.some((m) => m.benchmarkReturns?.[bench] !== undefined) ? benchmarkName(bench) : undefined}
            />
          ) : (
            <NoSeries />
          )}
        </Card>

        <Card
          title={t('dashboard.movers')}
          subtitle={a?.movers[0] ? t('dashboard.moversSub', { date: formatDate(a.movers[0].date, f.locale) }) : undefined}
        >
          {loading ? (
            <Skeleton className="h-[200px]" />
          ) : a?.movers.length ? (
            <ul className="flex flex-col divide-y divide-line -mx-1">
              {a.movers.slice(0, 6).map((m) => {
                const l = label(m.instrumentId);
                return (
                  <li key={m.instrumentId}>
                    <Link
                      to={`/posiciones/${encodeURIComponent(m.instrumentId)}`}
                      className="flex items-center gap-3 py-2 px-1 rounded-md hover:bg-surface-2"
                    >
                      <span className="w-[86px] font-semibold text-[13px] truncate">{l.symbol}</span>
                      <span className="flex-1 text-xs text-muted truncate">{l.name}</span>
                      <Delta pct={m.changePct} size="sm" className="w-[74px] justify-end" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted py-6 text-center">{t('dashboard.noMovers')}</p>
          )}
        </Card>

        <DividendsCard />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
        <FreshnessCard />
        <WarningsCard />
      </div>
    </div>
  );
}

function NoSeries() {
  const { t } = useTranslation();
  return <p className="text-sm text-muted py-16 text-center">{t('common.noData')}</p>;
}

function DividendsCard() {
  const { t } = useTranslation();
  const { analysis: a, loading } = useAnalysis();
  const f = useFmt();
  const label = useInstrumentLabel();
  // Announced by the provider first, then projected from last year's payments.
  const upcoming = (a?.upcomingDividends ?? []).filter((d) => d.payDate <= addDays(a!.asOf, 90)).slice(0, 4).map((d) => ({ ...d, date: d.payDate }));
  const last = useMemo(() => [...(a?.income ?? [])].filter((e) => e.date <= (a?.asOf ?? '')).sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 4), [a]);

  return (
    <Card
      title={t('dashboard.dividends')}
      actions={
        <Link to="/dividendos" className="btn btn-ghost btn-sm">
          {t('common.seeAll')} <ArrowRight size={14} />
        </Link>
      }
    >
      {loading ? (
        <Skeleton className="h-[200px]" />
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-xs font-medium text-muted mb-1 flex items-center gap-1.5">
              <CalendarClock size={13} aria-hidden /> {t('dashboard.upcomingEstimated')}
            </div>
            {upcoming.length ? (
              <ul className="text-[13px] flex flex-col gap-1">
                {upcoming.map((e, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="w-[86px] font-semibold truncate">{label(e.instrumentId).symbol}</span>
                    <span className="text-muted text-xs flex-1">
                      {e.source === 'provider' ? '' : '≈ '}
                      {formatDate(e.date, f.locale)}
                      {e.source === 'provider' && <span className="chip !h-4 ml-1.5 !text-[10px]">{t('div.announced')}</span>}
                    </span>
                    <Money value={e.netBase} className="text-ink-2" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">{t('dashboard.noUpcoming')}</p>
            )}
          </div>
          <div>
            <div className="text-xs font-medium text-muted mb-1">{t('dashboard.lastPayments')}</div>
            {last.length ? (
              <ul className="text-[13px] flex flex-col gap-1">
                {last.map((e, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="w-[86px] font-semibold truncate">{e.instrumentId ? label(e.instrumentId).symbol : t('tx.type.INTEREST')}</span>
                    <span className="text-muted text-xs flex-1">{formatDate(e.date, f.locale)}</span>
                    <Money value={e.netBase} className="text-pos" signed />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">{t('dashboard.noDividends')}</p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function FreshnessCard() {
  const { t } = useTranslation();
  const market = useApp((s) => s.market);
  const f = useFmt();
  const { analysis: a } = useAnalysis();
  const sources = Object.entries(market.sources);
  return (
    <Card title={t('dashboard.freshness')} subtitle={t('dashboard.freshnessSub')}>
      <ul className="text-[13px] flex flex-col gap-2">
        <li className="flex items-center gap-2">
          <Database size={14} className="text-muted" aria-hidden />
          <span className="flex-1">{t('dashboard.serverStatus')}</span>
          <span className="chip">{t(`market.status.${market.status}`)}</span>
        </li>
        {sources.map(([name, s]) => (
          <li key={name} className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${s.ok ? 'bg-pos' : 'bg-warn'}`} aria-hidden />
            <span className="flex-1">
              {name.startsWith('idx_') ? `${t('source.index')} ${indexName(name.slice(4))}` : t(`source.${name}`, { defaultValue: name })}
              {s.count ? <span className="text-muted text-xs"> · {s.count}</span> : null}
            </span>
            <span className="text-xs text-muted">{s.updatedAt ? formatRelative(s.updatedAt, f.locale) : s.ok ? '—' : t('market.failed')}</span>
          </li>
        ))}
        {!sources.length && <li className="text-xs text-muted">{t('dashboard.noSources')}</li>}
        {a && (
          <li className="text-xs text-muted pt-1 border-t border-line">
            {t('dashboard.computeTime', { ms: a.computeMs })}
          </li>
        )}
      </ul>
    </Card>
  );
}

function WarningsCard() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a } = useAnalysis();
  const label = useInstrumentLabel();
  const map = useInstrumentMap();
  const market = useApp((s) => s.market);
  const missing = a?.valuation?.missingPrices ?? [];
  const missingFx = a?.valuation?.missingFx ?? [];
  const issues = [...(a?.issues.errors ?? []), ...(a?.issues.warnings ?? [])];
  const manualStale = (a?.valuation?.holdings ?? []).filter((h) => {
    const inst = map.get(h.instrumentId);
    // Manual prices are due at every month end: flag when the last closed month has none.
    return inst?.pricing === 'manual' && h.priceDate && h.priceDate < monthEnd(addMonths(a!.asOf.slice(0, 7), -1));
  });
  const pending = a?.pendingCloses ?? [];
  const pendingIds = new Set(pending.map((p) => p.instrumentId));
  const manualStaleOnly = manualStale.filter((h) => !pendingIds.has(h.instrumentId));
  const diagErrors = (a?.diagnostics ?? []).filter((d) => d.severity === 'error');
  const total = missing.length + missingFx.length + issues.length + manualStaleOnly.length + pending.length + market.failedSymbols.length + (diagErrors.length ? 1 : 0);
  return (
    <Card title={t('dashboard.warnings')} subtitle={total ? t('dashboard.warningsCount', { count: total }) : t('dashboard.allGood')}>
      {total === 0 ? (
        <Banner tone="success">{t('dashboard.noWarnings')}</Banner>
      ) : (
        <ul className="text-[13px] flex flex-col gap-2">
          {missing.map((id) => (
            <li key={id} className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">
                {t('dashboard.missingPrice', { symbol: label(id).symbol })}{' '}
                <Link className="text-accent underline-offset-2 hover:underline" to="/mensual/cierre">
                  {t('dashboard.enterPrice')}
                </Link>
              </span>
            </li>
          ))}
          {diagErrors.length > 0 && (
            <li className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-neg mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">
                {t('diag.dashboard', { count: diagErrors.length })}{' '}
                <Link className="text-accent hover:underline" to="/movimientos">
                  {t('diag.review')}
                </Link>
              </span>
            </li>
          )}
          {pending.map((p) => (
            <li key={p.instrumentId} className="flex items-start gap-2" data-testid="pending-close-warning">
              <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">
                {t('dashboard.pendingCloses', { symbol: label(p.instrumentId).symbol, count: p.months.length, months: p.months.map((m) => formatMonth(m, f.locale)).join(', ') })}{' '}
                <Link className="text-accent hover:underline" to="/mensual/cierre">
                  {t('dashboard.closeMonth')}
                </Link>
              </span>
            </li>
          ))}
          {manualStaleOnly.map((h) => (
            <li key={h.instrumentId} className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">
                {t('dashboard.stalePrice', { symbol: label(h.instrumentId).symbol, date: formatDate(h.priceDate, f.locale) })}{' '}
                <Link className="text-accent hover:underline" to="/mensual/cierre">
                  {t('dashboard.closeMonth')}
                </Link>
              </span>
            </li>
          ))}
          {missingFx.map((c) => (
            <li key={c} className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
              {t('dashboard.missingFx', { currency: c })}
            </li>
          ))}
          {market.failedSymbols.slice(0, 5).map((s) => (
            <li key={s} className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
              {t('dashboard.failedSymbol', { symbol: s })}
            </li>
          ))}
          {issues.slice(0, 6).map((i, k) => (
            <li key={k} className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function EmptyDashboard() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={t('dashboard.title')} />
      <div className="card">
        <EmptyState
          icon={<Wallet size={20} />}
          title={t('dashboard.emptyTitle')}
          body={t('dashboard.emptyBody')}
          action={
            <>
              <Link to="/movimientos?nuevo=1" className="btn btn-primary">
                <Plus size={15} /> {t('tx.add')}
              </Link>
              <Link to="/importar" className="btn">
                <Upload size={15} /> {t('nav.import')}
              </Link>
            </>
          }
        />
      </div>
    </div>
  );
}

