import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MonthlyRow, RiskMetrics } from '@pm/core';
import { Card, Kpi, Money, PageHeader, Pct, Skeleton } from '../components/ui';
import { LineChart, type LineSeries } from '../components/charts';
import { useAnalysis } from '../hooks/useAnalysis';
import type { SummaryKey } from '../services/analysis';
import { useFmt } from '../store/app';
import { formatMonth, formatNumber, formatPct } from '../lib/format';
import { benchmarkName } from '../lib/benchmarks';
import { addMonths, monthEnd } from '../lib/ids';

/** Drawdown series (decimal ≤ 0) from monthly cumulative TWR. */
export function drawdowns(rows: MonthlyRow[]): [string, number][] {
  let peak = 1;
  return rows.map((r) => {
    const v = 1 + r.cumulativeTwr;
    peak = Math.max(peak, v);
    return [monthEnd(r.month), v / peak - 1];
  });
}

export function annualize(total: number, months: number): number | undefined {
  if (months < 12) return undefined;
  return Math.pow(1 + total, 12 / months) - 1;
}

const PERIODS: SummaryKey[] = ['MTD', 'YTD', '1Y', '3Y', 'SI'];

export default function PerformancePage() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a, loading } = useAnalysis();
  const rows = a?.monthly ?? [];
  const risk = a?.risk;
  const si = a?.summaries.SI;
  const benches = Object.keys(a?.benchmarkRisk ?? {});

  const cumSeries: LineSeries[] = useMemo(() => {
    if (!rows.length) return [];
    const first = rows[0]!.month;
    const start: [string, number] = [monthEnd(addMonths(first, -1)), 0];
    const out: LineSeries[] = [{ name: t('chart.portfolio'), data: [start, ...rows.map((r) => [monthEnd(r.month), r.cumulativeTwr] as [string, number])], area: true }];
    benches.forEach((b, i) => {
      let c = 1;
      out.push({
        name: benchmarkName(b),
        colorIndex: i + 1,
        data: [start, ...rows.map((r) => {
          c *= 1 + (r.benchmarkReturns?.[b] ?? 0);
          return [monthEnd(r.month), c - 1] as [string, number];
        })],
      });
    });
    return out;
  }, [rows, benches.join(), t]); // eslint-disable-line react-hooks/exhaustive-deps

  const ddSeries: LineSeries[] = useMemo(() => [{ name: t('perf.drawdown'), data: drawdowns(rows), area: true, tone: 'neg' }], [rows, t]);
  const pctFmt = useCallback((v: number, axis?: boolean) => formatPct(v, f.locale, { decimals: axis ? 0 : 2, signed: !axis }), [f.locale]);

  return (
    <div>
      <PageHeader title={t('perf.title')} subtitle={t('perf.subtitle', { currency: f.currency })} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi loading={loading} label={t('perf.twr')} value={<Pct value={si?.twr} signed colored />} sub={<span className="text-xs text-muted">{t('perf.annualized')}: {formatPct(si?.twrAnnualized, f.locale, { signed: true })}</span>} hint={t('perf.twrHint')} />
        <Kpi loading={loading} label={t('perf.mwr')} value={<Pct value={si?.mwr} signed colored />} sub={<span className="text-xs text-muted">{t('perf.mwrSub')}</span>} hint={t('perf.mwrHint')} />
        <Kpi loading={loading} label={t('perf.volatility')} value={<Pct value={risk?.volatility} />} sub={<span className="text-xs text-muted">{t('perf.volatilitySub')}</span>} />
        <Kpi
          loading={loading}
          label={t('perf.maxDrawdown')}
          value={<Pct value={risk?.maxDrawdown} colored />}
          sub={
            <span className="text-xs text-muted">
              {risk?.maxDrawdownStart ? `${formatMonth(risk.maxDrawdownStart, f.locale)} → ${risk.maxDrawdownEnd ? formatMonth(risk.maxDrawdownEnd, f.locale) : '…'}` : '—'}
            </span>
          }
        />
        <Kpi loading={loading} label="Sharpe" value={<span className="num">{formatNumber(risk?.sharpe, f.locale, 2)}</span>} sub={<span className="text-xs text-muted">{t('perf.sharpeSub')}</span>} />
        <Kpi loading={loading} label="Sortino" value={<span className="num">{formatNumber(risk?.sortino, f.locale, 2)}</span>} sub={<span className="text-xs text-muted">{t('perf.sortinoSub')}</span>} />
        <Kpi loading={loading} label={t('perf.beta')} value={<span className="num">{formatNumber(risk?.beta, f.locale, 2)}</span>} sub={<span className="text-xs text-muted">{t('perf.correlation')}: {formatNumber(risk?.correlation, f.locale, 2)}</span>} />
        <Kpi loading={loading} label={t('monthly.positiveMonths')} value={<Pct value={risk?.positiveMonthsRatio} decimals={0} />} sub={<span className="text-xs text-muted">{t('monthly.monthsCount', { count: rows.length })}</span>} />
      </div>

      <Card className="mt-3" title={t('perf.cumulative')} subtitle={t('perf.cumulativeSub')}>
        {loading ? <Skeleton className="h-72" /> : cumSeries.length ? <LineChart series={cumSeries} valueFormat={pctFmt} ariaLabel={t('perf.cumulative')} height={300} scale={false} /> : <p className="text-muted text-sm text-center py-12">{t('common.noData')}</p>}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-3">
        <Card title={t('perf.drawdown')} subtitle={t('perf.drawdownSub')}>
          {loading ? <Skeleton className="h-56" /> : <LineChart series={ddSeries} valueFormat={pctFmt} ariaLabel={t('perf.drawdown')} height={230} scale={false} />}
        </Card>
        <Card title={t('perf.periods')} bodyClassName="!p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.period')}</th>
                  <th className="r">TWR</th>
                  <th className="r">{t('perf.annualizedShort')}</th>
                  <th className="r">{t('perf.mwrShort')}</th>
                  <th className="r">{t('monthly.col.gain')}</th>
                  <th className="r">{t('monthly.col.income')}</th>
                </tr>
              </thead>
              <tbody>
                {PERIODS.map((p) => {
                  const s = a?.summaries[p];
                  return (
                    <tr key={p}>
                      <td className="font-medium">{t(`period.${p === 'SI' ? 'ALL' : p}`)}</td>
                      <td className="r">
                        <Pct value={s?.twr} signed colored />
                      </td>
                      <td className="r">
                        <Pct value={s?.twrAnnualized} signed />
                      </td>
                      <td className="r">
                        <Pct value={s?.mwr} signed />
                      </td>
                      <td className="r">
                        <Money value={s?.gainBase} signed />
                      </td>
                      <td className="r">
                        <Money value={s?.incomeBase} />
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
          <table className="table">
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
              <BenchRow name={t('chart.portfolio')} risk={risk} total={rows.at(-1)?.cumulativeTwr} months={rows.length} strong />
              {benches.map((b) => {
                const total = rows.reduce((c, r) => c * (1 + (r.benchmarkReturns?.[b] ?? 0)), 1) - 1;
                return <BenchRow key={b} name={benchmarkName(b)} risk={a?.benchmarkRisk[b]} total={total} months={rows.length} />;
              })}
              {!benches.length && (
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

function BenchRow({ name, risk, total, months, strong }: { name: string; risk?: RiskMetrics; total?: number; months: number; strong?: boolean }) {
  const { locale } = useFmt();
  return (
    <tr className={strong ? 'font-semibold' : undefined}>
      <td>{name}</td>
      <td className="r">
        <Pct value={total} signed colored />
      </td>
      <td className="r">
        <Pct value={total !== undefined ? annualize(total, months) : undefined} signed />
      </td>
      <td className="r">
        <Pct value={risk?.volatility} />
      </td>
      <td className="r num">{formatNumber(risk?.sharpe, locale, 2)}</td>
      <td className="r">
        <Pct value={risk?.maxDrawdown} />
      </td>
      <td className="r">
        <Pct value={risk?.positiveMonthsRatio} decimals={0} />
      </td>
    </tr>
  );
}
