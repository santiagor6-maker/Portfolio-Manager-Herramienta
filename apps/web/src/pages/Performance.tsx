import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MonthlyRow, PerformanceSummary, RiskMetrics } from '@pm/core';
import { Card, Kpi, Money, PageHeader, Pct, Skeleton } from '../components/ui';
import { LineChart, type LineSeries } from '../components/charts';
import { useAnalysis } from '../hooks/useAnalysis';
import { useFmt } from '../store/app';
import { formatMonth, formatPct } from '../lib/format';
import { benchmarkName } from '../lib/benchmarks';
import { indexName } from '../lib/labels';
import { addMonths, monthEnd } from '../lib/ids';
import type { SummaryKey } from '../services/analysis';
import { compound } from './Monthly';

/** Drawdown series (decimal ≤ 0) from monthly cumulative TWR. */
export function drawdowns(rows: MonthlyRow[]): [string, number][] {
  let peak = 1;
  return rows.map((r) => {
    const v = 1 + r.cumulativeTwr;
    peak = Math.max(peak, v);
    return [monthEnd(r.month), v / peak - 1];
  });
}

/**
 * The single annualization rule of the app (same as the engine's): calendar years between the
 * period bounds, and nothing is annualized for periods shorter than one year (W9).
 */
export function annualize(total: number | undefined, years: number | undefined): number | undefined {
  if (total === undefined || years === undefined || years < 1 - 1e-9) return undefined;
  return Math.pow(1 + total, 1 / years) - 1;
}

export function yearsOf(s: PerformanceSummary | undefined): number | undefined {
  if (!s) return undefined;
  return s.years ?? (Date.parse(s.to) - Date.parse(s.from)) / (365.25 * 86_400_000);
}

/** Fixed 2-decimal ratio (Sharpe, Sortino, beta) — uniform everywhere. */
export function ratio(v: number | undefined, locale: string): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

const PERIODS: SummaryKey[] = ['MTD', 'YTD', '1Y', '3Y', 'SI'];

function NotAnnualized() {
  const { t } = useTranslation();
  return (
    <span className="text-muted" title={t('perf.notAnnualized')}>
      —
    </span>
  );
}

/** MWR: annualized when the period is ≥ 1 year, otherwise the period return (flagged). */
export function MwrValue({ s, colored }: { s?: PerformanceSummary; colored?: boolean }) {
  const { t } = useTranslation();
  const y = yearsOf(s);
  if (!s) return <span className="text-muted">—</span>;
  if (y !== undefined && y < 1)
    return (
      <span title={t('perf.notAnnualized')}>
        <Pct value={s.mwrPeriod} signed colored={colored} /> <span className="text-[10px] text-muted">{t('perf.inPeriod')}</span>
      </span>
    );
  return (
    <span title={s.mwrMultipleRoots ? t('perf.multipleRoots') : undefined}>
      <Pct value={s.mwr} signed colored={colored} />
      {s.mwrMultipleRoots ? ' *' : ''}
    </span>
  );
}

export default function PerformancePage() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a, loading } = useAnalysis();
  const rows = a?.monthly ?? [];
  const risk = a?.risk;
  const si = a?.summaries.SI;
  const siYears = yearsOf(si);
  const benches = Object.keys(a?.benchmarkRisk ?? {});
  const rateIdx = a?.rateIndices ?? [];
  const inflation = a?.inflationIndex;

  const cumSeries: LineSeries[] = useMemo(() => {
    if (!rows.length) return [];
    const first = rows[0]!.month;
    const start: [string, number] = [monthEnd(addMonths(first, -1)), 0];
    const chain = (fn: (r: MonthlyRow) => number | undefined) => {
      let c = 1;
      return [start, ...rows.map((r) => {
        c *= 1 + (fn(r) ?? 0);
        return [monthEnd(r.month), c - 1] as [string, number];
      })];
    };
    const out: LineSeries[] = [{ name: t('chart.portfolio'), data: [start, ...rows.map((r) => [monthEnd(r.month), r.cumulativeTwr] as [string, number])], area: true }];
    benches.forEach((b, i) => out.push({ name: benchmarkName(b), colorIndex: i + 1, data: chain((r) => r.benchmarkReturns?.[b]) }));
    rateIdx.forEach((id, i) => {
      if (rows.some((r) => r.indexReturns?.[id] !== undefined)) out.push({ name: indexName(id), colorIndex: benches.length + 1 + i, dashed: true, data: chain((r) => r.indexReturns?.[id]) });
    });
    if (inflation && rows.some((r) => r.inflation !== undefined)) out.push({ name: t('perf.inflationLine', { index: indexName(inflation) }), colorIndex: 7, dashed: true, data: chain((r) => r.inflation) });
    return out.slice(0, 8);
  }, [rows, benches.join(), rateIdx.join(), inflation, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const ddSeries: LineSeries[] = useMemo(() => [{ name: t('perf.drawdown'), data: drawdowns(rows), area: true, tone: 'neg' }], [rows, t]);
  const pctFmt = useCallback((v: number, axis?: boolean) => formatPct(v, f.locale, { decimals: axis ? (v !== 0 && Math.abs(v) < 0.1 ? 1 : 0) : 2, signed: !axis }), [f.locale]);
  const mainIdx = rateIdx.find((id) => si?.percentOfIndex?.[id] !== undefined);
  const months = rows.length;

  return (
    <div>
      <PageHeader title={t('perf.title')} subtitle={t('perf.subtitle', { currency: f.currency })} />
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3" data-testid="perf-kpis">
        <Kpi
          loading={loading}
          label={t('perf.twr')}
          value={<Pct value={si?.twr} signed colored />}
          sub={
            <span className="text-xs text-muted">
              {t('perf.annualized')}: {siYears !== undefined && siYears >= 1 ? formatPct(annualize(si?.twr, siYears), f.locale, { signed: true }) : '—'}
            </span>
          }
          hint={t('perf.twrHint')}
        />
        <Kpi loading={loading} label={t('perf.mwr')} value={<MwrValue s={si} colored />} sub={<span className="text-xs text-muted">{t('perf.mwrSub')}</span>} hint={t('perf.mwrHint')} />
        <Kpi
          loading={loading}
          label={t('perf.realTwr', { index: indexName(inflation) })}
          value={<Pct value={si?.realTwr} signed colored />}
          sub={
            <span className="text-xs text-muted">
              {si?.inflation !== undefined ? t('perf.inflationWas', { index: indexName(inflation), value: formatPct(si.inflation, f.locale, { signed: true }) }) : t('perf.noInflation')}
            </span>
          }
          hint={t('perf.realHint')}
        />
        <Kpi
          loading={loading}
          label={mainIdx ? t('perf.pctOfIndex', { index: indexName(mainIdx) }) : t('perf.pctOfIndexShort')}
          value={<Pct value={mainIdx ? si?.percentOfIndex?.[mainIdx] : undefined} decimals={0} />}
          sub={
            <span className="text-xs text-muted">
              {mainIdx ? t('perf.indexWas', { index: indexName(mainIdx), value: formatPct(si?.indexReturns?.[mainIdx], f.locale, { signed: true }) }) : t('perf.noIndex')}
              {mainIdx && a?.indexCoverage[mainIdx] ? ` · ${t('perf.indexUntil', { month: formatMonth(a.indexCoverage[mainIdx]!, f.locale) })}` : ''}
            </span>
          }
          hint={t('perf.pctOfIndexHint')}
        />
        <Kpi loading={loading} label={t('perf.volatility')} value={<Pct value={risk?.volatility} />} sub={<span className="text-xs text-muted">{t('perf.volatilitySub')}</span>} />
        <Kpi
          loading={loading}
          label={t('perf.maxDrawdown')}
          value={<Pct value={risk?.maxDrawdown} colored />}
          sub={<span className="text-xs text-muted">{risk?.maxDrawdownStart ? `${formatMonth(risk.maxDrawdownStart, f.locale)} → ${risk.maxDrawdownEnd ? formatMonth(risk.maxDrawdownEnd, f.locale) : '…'}` : '—'}</span>}
        />
        <Kpi loading={loading} label="Sharpe" value={<span className="num">{ratio(risk?.sharpe, f.locale)}</span>} sub={<span className="text-xs text-muted">{t('perf.sharpeSub')}</span>} />
        <Kpi loading={loading} label="Sortino" value={<span className="num">{ratio(risk?.sortino, f.locale)}</span>} sub={<span className="text-xs text-muted">{t('perf.sortinoSub')}</span>} />
        <Kpi loading={loading} label={t('perf.beta')} value={<span className="num">{ratio(risk?.beta, f.locale)}</span>} sub={<span className="text-xs text-muted">{t('perf.correlation')}: {ratio(risk?.correlation, f.locale)}</span>} />
        <Kpi loading={loading} label={t('monthly.positiveMonths')} value={<Pct value={risk?.positiveMonthsRatio} decimals={0} />} sub={<span className="text-xs text-muted">{t('monthly.monthsCount', { count: months })}</span>} />
      </div>

      <Card className="mt-3" title={t('perf.cumulative')} subtitle={t('perf.cumulativeSub')}>
        {loading ? <Skeleton className="h-72" /> : cumSeries.length ? <LineChart series={cumSeries} valueFormat={pctFmt} ariaLabel={t('perf.cumulative')} height={300} scale={false} /> : <p className="text-muted text-sm text-center py-12">{t('common.noData')}</p>}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-3 mt-3">
        <Card className="xl:col-span-2" title={t('perf.drawdown')} subtitle={t('perf.drawdownSub')}>
          {loading ? <Skeleton className="h-56" /> : <LineChart series={ddSeries} valueFormat={pctFmt} ariaLabel={t('perf.drawdown')} height={230} scale={false} />}
        </Card>
        <Card className="xl:col-span-3" title={t('perf.periods')} bodyClassName="!p-0">
          <div className="overflow-x-auto">
            <table className="table" data-testid="periods-table">
              <thead>
                <tr>
                  <th>{t('common.period')}</th>
                  <th className="r">TWR</th>
                  <th className="r" title={t('perf.notAnnualized')}>
                    {t('perf.annualizedShort')}
                  </th>
                  <th className="r">{t('perf.mwrShort')}</th>
                  <th className="r">{t('perf.realShort')}</th>
                  {mainIdx && <th className="r">% {indexName(mainIdx)}</th>}
                  <th className="r">{t('monthly.col.gain')}</th>
                </tr>
              </thead>
              <tbody>
                {PERIODS.map((p) => {
                  const s = a?.summaries[p];
                  const y = yearsOf(s);
                  return (
                    <tr key={p}>
                      <td className="font-medium">{t(`period.${p === 'SI' ? 'ALL' : p}`)}</td>
                      <td className="r">
                        <Pct value={s?.twr} signed colored />
                      </td>
                      <td className="r">{y !== undefined && y >= 1 ? <Pct value={annualize(s?.twr, y)} signed /> : <NotAnnualized />}</td>
                      <td className="r">
                        <MwrValue s={s} />
                      </td>
                      <td className="r">
                        <Pct value={s?.realTwr} signed />
                      </td>
                      {mainIdx && (
                        <td className="r">
                          <Pct value={s?.percentOfIndex?.[mainIdx]} decimals={0} />
                        </td>
                      )}
                      <td className="r">
                        <Money value={s?.gainBase} signed />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card className="mt-3" title={t('perf.vsBenchmarks')} subtitle={t('perf.vsBenchmarksSub')} bodyClassName="!p-0">
        <div className="overflow-x-auto">
          <table className="table" data-testid="bench-table">
            <thead>
              <tr>
                <th></th>
                <th className="r">{t('perf.totalReturn')}</th>
                <th className="r">{t('perf.annualizedShort')}</th>
                <th className="r">{t('perf.volatility')}</th>
                <th className="r">Sharpe</th>
                <th className="r">{t('perf.maxDrawdown')}</th>
                <th className="r">{t('perf.positive')}</th>
              </tr>
            </thead>
            <tbody>
              <BenchRow name={t('chart.portfolio')} risk={risk} total={si?.twr} annual={siYears !== undefined && siYears >= 1 ? (annualize(si?.twr, siYears)) : undefined} strong />
              {benches.map((b) => {
                const total = compound(rows.map((r) => r.benchmarkReturns?.[b] ?? 0));
                return <BenchRow key={b} name={benchmarkName(b)} risk={a?.benchmarkRisk[b]} total={total} annual={annualize(total, siYears)} />;
              })}
              {rateIdx.map((id) => {
                const total = si?.indexReturns?.[id];
                if (total === undefined) return null;
                return <BenchRow key={id} name={indexName(id)} total={total} annual={annualize(total, siYears)} />;
              })}
              {!benches.length && !rateIdx.length && (
                <tr>
                  <td colSpan={7} className="text-center text-muted !py-6">
                    {t('perf.noBenchmarks')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-xs text-muted mt-3 max-w-3xl">{t('perf.footnote')}</p>
    </div>
  );
}

function BenchRow({ name, risk, total, annual, strong }: { name: string; risk?: RiskMetrics; total?: number; annual?: number; strong?: boolean }) {
  const { locale } = useFmt();
  return (
    <tr className={strong ? 'font-semibold' : undefined}>
      <td>{name}</td>
      <td className="r">
        <Pct value={total} signed colored />
      </td>
      <td className="r">{annual !== undefined ? <Pct value={annual} signed /> : <NotAnnualized />}</td>
      <td className="r">
        <Pct value={risk?.volatility} />
      </td>
      <td className="r num">{ratio(risk?.sharpe, locale)}</td>
      <td className="r">
        <Pct value={risk?.maxDrawdown} />
      </td>
      <td className="r">
        <Pct value={risk?.positiveMonthsRatio} decimals={0} />
      </td>
    </tr>
  );
}
