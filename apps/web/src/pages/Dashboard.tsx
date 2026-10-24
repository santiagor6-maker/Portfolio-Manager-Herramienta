import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRight, CalendarClock, Plus, Upload, Wallet } from 'lucide-react';
import type { AllocationDimension } from '@pm/core';
import { Banner, Card, Delta, EmptyState, Kpi, Money, PageHeader, Pct, Segmented, Skeleton } from '../components/ui';
import { AllocationDonut, ReturnBars, ValueChart } from '../components/charts';
import { monthWithoutPrices, seriesForPeriod, unpricedMonths, useAnalysis, useInstrumentLabel, type ChartPeriod } from '../hooks/useAnalysis';
import { useSliceLabel } from '../lib/labels';
import { useApp, useFmt } from '../store/app';
import { formatDate, formatMonth } from '../lib/format';
import { indexName } from '../lib/labels';
import { GettingStarted } from '../components/Onboarding';
import { addDays, addMonths, monthEnd, previousBusinessDay } from '../lib/ids';
import { useInstrumentMap } from '../hooks/useData';
import { refreshMarketData } from '../services/marketData';
import { useLiveQuery } from 'dexie-react-hooks';
import { renamedPair } from '../lib/diagnosticText';
import { recordSplit, renameInstrumentRows } from '../components/DiagnosticsPanel';
import { acceptSuggestions } from '../services/suggestions';
import { pendingEvents, type PendingSplit } from '../lib/pendingEvents';
import { formatSplitRatio } from '../lib/corporateText';
import { db } from '../db/schema';
import { primaryBenchmark, benchmarkName } from '../lib/benchmarks';
import { describeIssue } from '../lib/diagnosticText';
import { FxUnavailable, fxPairs } from '../components/FxNotice';
import { useConversion } from '../hooks/useConversion';

const DIMS: AllocationDimension[] = ['country', 'currency', 'assetClass', 'sector'];

export default function DashboardPage() {
  const { t } = useTranslation();
  const { analysis: a, loading } = useAnalysis();
  const f = useFmt();
  const conv = useConversion();
  const noFx = conv.missing.length > 0;
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
  // Movers whose last closes differ (e.g. B3 and NYSE holidays): one date per row (W26).
  const moversMixed = new Set((a?.movers ?? []).slice(0, 6).map((m) => m.date)).size > 1;
  const rateIdx = a?.rateIndices[0];
  const periodSummary =
    period === 'MTD' ? mtd : period === 'YTD' ? ytd : period === '1Y' ? a?.summaries['1Y'] : period === '3Y' ? a?.summaries['3Y'] : si;

  if (!loading && a && !a.hasTransactions) return <EmptyDashboard />;

  // D4: with no price yet in the current month, "Este mes" is not 0 %: show the last closed month and
  // keep the empty month out of the 12-month bars.
  const openMonth = monthWithoutPrices(a);
  // W49: months without any close are not "0 %": skipped by the KPI and the 12-month bars.
  const noPrice = unpricedMonths(a);
  const lastClosed = openMonth ? [...(a?.monthly ?? [])].reverse().find((r) => r.month < openMonth && !r.partial && !noPrice.has(r.month)) : undefined;
  const last12 = (a?.monthly ?? []).filter((m) => !noPrice.has(m.month)).slice(-12);
  const bench = primaryBenchmark(benchmarks, f.currency);

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
      <PendingSplitsBanner />
      {/* W54: on the phone one compact card per row (figures keep their full width, no empty cell);
          three across from 640 px, the headline two columns wide from 1280 px. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-5 gap-2 sm:gap-3" data-testid="kpis">
        <Kpi
          primary
          className="sm:col-span-3 xl:col-span-2"
          loading={loading}
          label={t('dashboard.totalValue')}
          value={<Money value={v?.totalMarketValueBase} />}
          sub={
            noFx ? (
              <span className="text-warn text-xs" data-testid="kpi-no-fx">{t('fxGuard.short', { pairs: fxPairs(conv.missing, conv.target) })}</span>
            ) : stalePrices && a?.latestPriceDate ? (
              <span className="text-muted text-xs">{t('dashboard.pricesAsOf', { date: formatDate(a.latestPriceDate, f.locale) })}</span>
            ) : day ? (
              <span className="flex items-center gap-1.5">
                <Delta amount={day.gainBase} pct={day.twr} size="sm" />
                <span className="text-muted text-xs">
                  {a?.dayRange && a.dayRange.to < a.asOf
                    ? t('dashboard.sinceClose', { date: formatDate(a.dayRange.from, f.locale) })
                    : t('dashboard.today')}
                </span>
              </span>
            ) : (
              <span className="text-muted text-xs">—</span>
            )
          }
        />
        {lastClosed ? (
          <Kpi
            loading={loading}
            label={t('monthly.lastClosed', { month: formatMonth(lastClosed.month, f.locale) })}
            value={<Money value={lastClosed.gainBase} signed />}
            valueCompact={<Money value={lastClosed.gainBase} signed compact />}
            sub={
              <span className="flex items-center gap-2 flex-wrap" data-testid="kpi-open-month">
                <Pct value={lastClosed.twr} signed colored />
                <span className="text-muted text-xs">{t('monthly.openNoPrices', { month: formatMonth(openMonth!, f.locale) })}</span>
              </span>
            }
          />
        ) : (
          <Kpi loading={loading} label={t('dashboard.month')} value={<Money value={mtd?.gainBase} signed />} valueCompact={<Money value={mtd?.gainBase} signed compact />} sub={<Pct value={mtd?.twr} signed colored />} />
        )}
        <Kpi
          loading={loading}
          label={t('dashboard.ytd')}
          value={<Money value={ytd?.gainBase} signed />}
          valueCompact={<Money value={ytd?.gainBase} signed compact />}
          sub={<Pct value={ytd?.twr} signed colored />}
        />
        <Kpi
          loading={loading}
          label={t('dashboard.totalGain')}
          value={<Money value={si?.gainBase} signed />}
          valueCompact={<Money value={si?.gainBase} signed compact />}
          sub={
            <span className="flex items-center gap-2 flex-wrap">
              <Pct value={si?.twr} signed colored />
              {si?.realTwr !== undefined && (
                <span className="text-muted text-xs" title={t('dashboard.realHint', { index: indexName(a?.inflationIndex) })}>
                  {t('dashboard.real')} <Pct value={si.realTwr} signed />
                </span>
              )}
              {!rateIdx && a?.missingRateIndex && (
                <span className="text-muted text-xs" data-testid="rate-missing">
                  {t('report.notAvailable', { index: indexName(a.missingRateIndex) })}
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
          {loading ? <Skeleton className="h-[300px]" /> : noFx ? <FxUnavailable /> : series.length ? <ValueChart data={series} inflationLabel={a?.inflationIndex ? indexName(a.inflationIndex) : undefined} /> : <NoSeries />}
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
          {loading ? <Skeleton className="h-[170px]" /> : noFx ? <FxUnavailable className="py-10" /> : <AllocationDonut slices={a?.allocations[dim] ?? []} labelFor={sliceLabel} dim={dim} />}
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
          ) : noFx ? (
            <FxUnavailable />
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
          subtitle={
            a?.movers[0]
              ? moversMixed
                ? t('dashboard.moversSubMixed')
                : t('dashboard.moversSub', { date: formatDate(a.movers[0].date, f.locale) })
              : undefined
          }
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
                      <span className="min-w-[86px] max-w-[120px] font-semibold text-[13px] truncate" title={l.symbol}>{l.symbol}</span>
                      <span className="flex-1 text-xs text-muted truncate">{l.name}</span>
                      {moversMixed && <span className="text-[11px] text-muted num whitespace-nowrap" data-testid="mover-date">{formatDate(m.date, f.locale, 'short')}</span>}
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

      {/* D22: data freshness lives in Ajustes (and the header status); the Resumen keeps the warnings. */}
      <div className="mt-3">
        <WarningsCard />
      </div>
    </div>
  );
}

/**
 * W55: a split of a held position that is not recorded makes the quantity and the value wrong (10.000
 * NVDA valued as if they were 100.000 after a 10:1). Shown above the KPIs with a one-click fix.
 */
function PendingSplitsBanner() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a } = useAnalysis();
  const label = useInstrumentLabel();
  const [busy, setBusy] = useState(false);
  // Splits already recorded from this banner stay hidden until the worker's next analysis drops them,
  // so a second click cannot record the same split twice.
  const [applied, setApplied] = useState<ReadonlySet<string>>(new Set());
  const key = (p: PendingSplit) => `${p.instrumentId}|${p.date}`;
  const splits = pendingEvents(a).splits.filter((p) => !applied.has(key(p)));
  if (!splits.length) return null;
  const apply = async (list: PendingSplit[]) => {
    setBusy(true);
    try {
      const provider = list.flatMap((p) => (p.suggestion ? [p.suggestion] : []));
      if (provider.length) await acceptSuggestions(provider, t, f.locale);
      for (const p of list) {
        if (p.suggestion) continue;
        // Only the portfolio whose history shows the jump (same rule as the diagnostics panel).
        const tx = p.diagnostic?.transactionId ? await db.transactions.get(p.diagnostic.transactionId) : undefined;
        await recordSplit({ instrumentId: p.instrumentId, ratio: p.ratio, date: p.date }, tx?.portfolioId);
      }
      setApplied((s) => new Set([...s, ...list.map(key)]));
    } finally {
      setBusy(false);
    }
  };
  const ratio = (r: number) => formatSplitRatio(r, f.locale);
  return (
    <div className="mb-3" data-testid="pending-splits">
      <Banner
        tone="error"
        action={
          <div className="flex gap-2 flex-wrap sm:justify-end">
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void apply(splits)} data-testid="apply-splits">
              {t('pending.applySplits', { count: splits.length })}
            </button>
            <Link to="/movimientos" className="btn btn-sm">
              {t('pending.review')}
            </Link>
          </div>
        }
      >
        <strong className="font-semibold">{t('pending.splitsTitle', { count: splits.length })}</strong>{' '}
        <span className="text-ink-2">
          {splits
            .slice(0, 3)
            .map((p) => t('pending.splitLine', { symbol: label(p.instrumentId).symbol, ratio: ratio(p.ratio), date: formatDate(p.date, f.locale) }))
            .join(' · ')}
          {splits.length > 3 ? ` · ${t('pending.more', { count: splits.length - 3 })}` : ''} {t('pending.splitsBody')}
        </span>
      </Banner>
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
  const pendingIncome = pendingEvents(a).income.length;
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
            {pendingIncome > 0 && (
              <p className="text-xs text-warn mb-1.5" data-testid="dashboard-pending-income">
                {t('pending.income', { count: pendingIncome })}{' '}
                <Link className="text-accent hover:underline" to="/dividendos">
                  {t('pending.register')}
                </Link>
              </p>
            )}
            <div className="text-xs font-medium text-muted mb-1">{t('dashboard.lastPayments')}</div>
            {last.length ? (
              <ul className="text-[13px] flex flex-col gap-1">
                {last.map((e, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="w-[86px] font-semibold truncate">{e.instrumentId ? label(e.instrumentId).symbol : t('tx.type.INTEREST')}</span>
                    <span className="text-muted text-xs flex-1">{formatDate(e.date, f.locale)}</span>
                    <Money value={e.netBase} className="text-ink" />
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

function WarningsCard() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a } = useAnalysis();
  const label = useInstrumentLabel();
  const map = useInstrumentMap();
  const market = useApp((s) => s.market);
  const missing = a?.valuation?.missingPrices ?? [];
  // W40: currencies without a rate are explained once by the page banner (with retry).
  const missingFx = (a?.valuation?.missingFx ?? []).filter((c) => !a?.fxMissing.includes(c));
  const issues = [...(a?.issues.errors ?? []), ...(a?.issues.warnings ?? [])];
  // W41: issues are described in the user's language from their code and transaction.
  const issueTxIds = issues.map((i) => i.transactionId).filter((x): x is string => !!x);
  const issueTxs = useLiveQuery(async () => new Map((await db.transactions.bulkGet(issueTxIds)).filter((x) => !!x).map((x) => [x!.id, x!])), [issueTxIds.join('|')]);
  const manualStale = (a?.valuation?.holdings ?? []).filter((h) => {
    const inst = map.get(h.instrumentId);
    // Manual prices are due at every month end: flag when the last closed month has none.
    return inst?.pricing === 'manual' && h.priceDate && h.priceDate < monthEnd(addMonths(a!.asOf.slice(0, 7), -1));
  });
  const pending = a?.pendingCloses ?? [];
  const pendingIds = new Set(pending.map((p) => p.instrumentId));
  const manualStaleOnly = manualStale.filter((h) => !pendingIds.has(h.instrumentId));
  const diagErrors = (a?.diagnostics ?? []).filter((d) => d.severity === 'error' && !(d.code === 'MISSING_FX' && a?.fxMissing.length));
  // W49: market-priced holdings of real portfolios without a recent close (interrupted refresh, server
  // down…); the analysis already leaves out the frozen sample.
  const staleMarket = a?.staleMarket ?? [];
  // W55: inbox items and valuation-changing warnings are never "Todo en orden".
  const pendingEv = pendingEvents(a);
  const otherPending = pendingEv.total - pendingEv.splits.filter((p) => p.suggestion).length;
  const valuationOnly = pendingEv.valuationWarnings.filter((d) => d.code === 'TRADE_PRICE_UNIT_SUSPECT');
  const staleSince = staleMarket.reduce<string | undefined>((m, h) => (h.priceDate && (!m || h.priceDate < m) ? h.priceDate : m), undefined);
  const demoPriced = a?.demoPriced ?? [];
  const total = missing.length + missingFx.length + issues.length + manualStaleOnly.length + pending.length + market.failedSymbols.length + (diagErrors.length ? 1 : 0) + (demoPriced.length ? 1 : 0) + (staleMarket.length ? 1 : 0) + pendingEv.splits.length + (otherPending > 0 ? 1 : 0) + (valuationOnly.length ? 1 : 0);
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
          {pendingEv.splits.map((p) => (
            <li key={`${p.instrumentId}|${p.date}`} className="flex items-start gap-2" data-testid="warning-split">
              <AlertTriangle size={14} className="text-neg mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">
                {t('pending.splitLine', { symbol: label(p.instrumentId).symbol, ratio: formatSplitRatio(p.ratio, f.locale), date: formatDate(p.date, f.locale) })} {t('pending.splitsBody')}
              </span>
            </li>
          ))}
          {otherPending > 0 && (
            <li className="flex items-start gap-2" data-testid="warning-inbox">
              <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">
                {t('pending.inbox', { count: otherPending })}{' '}
                <Link className="text-accent hover:underline" to="/movimientos">
                  {t('pending.review')}
                </Link>
              </span>
            </li>
          )}
          {valuationOnly.length > 0 && (
            <li className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">
                {t('pending.unitSuspect', { count: valuationOnly.length })}{' '}
                <Link className="text-accent hover:underline" to="/movimientos">
                  {t('pending.review')}
                </Link>
              </span>
            </li>
          )}
          {staleMarket.length > 0 && (
            <li className="flex items-start gap-2" data-testid="stale-market">
              <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">
                {staleSince
                  ? t('dashboard.staleMarket', { count: staleMarket.length, date: formatDate(staleSince, f.locale), symbols: staleMarket.slice(0, 4).map((h) => label(h.instrumentId).symbol).join(', ') })
                  : t('dashboard.staleMarketNever', { count: staleMarket.length, symbols: staleMarket.slice(0, 4).map((h) => label(h.instrumentId).symbol).join(', ') })}{' '}
                <button className="text-accent hover:underline" disabled={market.status === 'loading'} onClick={() => void refreshMarketData({ force: true })}>
                  {t('market.refresh')}
                </button>
              </span>
            </li>
          )}
          {demoPriced.length > 0 && (
            <li className="flex items-start gap-2" data-testid="demo-priced">
              <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">{t('dashboard.demoPriced', { symbols: demoPriced.map((id) => label(id).symbol).join(', ') })}</span>
            </li>
          )}
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
          {issues.slice(0, 6).map((i, k) => {
            const pair = i.code === 'RENAMED_TICKER_MIXED' ? renamedPair(i.message) : undefined;
            return (
              <li key={k} className="flex items-start gap-2">
                <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-hidden />
                {pair ? (
                  <span className="flex-1" data-testid="renamed-mixed">
                    {t('diag.text.RENAMED_TICKER_MIXED', { from: pair.from.split(':').pop(), to: pair.to.split(':').pop() })}{' '}
                    <button className="text-accent hover:underline" onClick={() => void renameInstrumentRows(pair.from, pair.to)}>
                      {t('diag.renameRows', { to: pair.to.split(':').pop() })}
                    </button>
                  </span>
                ) : (
                  <span className="flex-1" data-testid="warning-issue" title={i.message}>
                    {describeIssue(i, { tx: i.transactionId ? issueTxs?.get(i.transactionId) : undefined, instruments: map, locale: f.locale, t })}
                  </span>
                )}
              </li>
            );
          })}
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

