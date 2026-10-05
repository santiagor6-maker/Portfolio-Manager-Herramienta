import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { CalendarCheck, CalendarRange, Download, FileSpreadsheet } from 'lucide-react';
import type { MonthlyRow } from '@pm/core';
import { Card, EmptyState, Kpi, Money, PageHeader, Pct, Skeleton } from '../components/ui';
import { useAnalysis } from '../hooks/useAnalysis';
import { useApp, useFmt } from '../store/app';
import { formatMonth, formatPct, monthName } from '../lib/format';
import { BENCHMARKS, benchmarkName } from '../lib/benchmarks';
import { downloadText, downloadXlsx, toCsv } from '../lib/export';

/** Compounds monthly returns. */
export function compound(rs: number[]): number {
  return rs.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

export interface YearRow {
  year: string;
  months: (MonthlyRow | undefined)[];
  annual: number;
  annualBench?: number;
}

export function buildHeatmap(rows: MonthlyRow[], bench?: string): YearRow[] {
  const byYear = new Map<string, (MonthlyRow | undefined)[]>();
  for (const r of rows) {
    const y = r.month.slice(0, 4);
    const m = Number(r.month.slice(5, 7)) - 1;
    if (!byYear.has(y)) byYear.set(y, Array(12).fill(undefined));
    byYear.get(y)![m] = r;
  }
  return [...byYear.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([year, months]) => {
      const present = months.filter((m): m is MonthlyRow => !!m);
      const benchVals = bench ? present.map((m) => m.benchmarkReturns?.[bench]).filter((v): v is number => v !== undefined) : [];
      return {
        year,
        months,
        annual: compound(present.map((m) => m.twr)),
        annualBench: benchVals.length === present.length && benchVals.length ? compound(benchVals) : undefined,
      };
    });
}

function heatStyle(r: number | undefined): React.CSSProperties | undefined {
  if (r === undefined || !Number.isFinite(r)) return undefined;
  const cap = 0.08;
  const strength = Math.min(1, Math.abs(r) / cap);
  if (strength < 0.02) return { background: 'var(--surface-2)' };
  const pct = Math.round(10 + strength * 55);
  const color = r > 0 ? 'var(--pos)' : 'var(--neg)';
  return { background: `color-mix(in srgb, ${color} ${pct}%, var(--surface))` };
}

export default function MonthlyPage() {
  const { t } = useTranslation();
  const { analysis: a, loading } = useAnalysis();
  const f = useFmt();
  const settingsBench = useApp((s) => s.settings.benchmarks);
  const [bench, setBench] = useState<string>(settingsBench[0] ?? 'XBOG:ICOLCAP');
  const [year, setYear] = useState<string>('all');
  const [focus, setFocus] = useState<string>();

  const rows = a?.monthly ?? [];
  const hasBench = rows.some((r) => r.benchmarkReturns?.[bench] !== undefined);
  const heat = useMemo(() => buildHeatmap(rows, hasBench ? bench : undefined), [rows, bench, hasBench]);
  const years = heat.map((h) => h.year);
  const tableRows = useMemo(
    () => [...rows].filter((r) => year === 'all' || r.month.startsWith(year)).reverse(),
    [rows, year],
  );

  const currentMonth = (a?.asOf ?? '').slice(0, 7);
  // The KPI shows the last *closed* month; the running month is flagged "en curso" in the table.
  const closedRows = rows.filter((r) => r.month < currentMonth);
  const last = closedRows[closedRows.length - 1] ?? rows[rows.length - 1];
  const risk = a?.risk;
  const positive = rows.length ? rows.filter((r) => r.twr > 0).length / rows.length : undefined;

  const totals = useMemo(() => {
    const s = (fn: (r: MonthlyRow) => number) => tableRows.reduce((acc, r) => acc + fn(r), 0);
    const chrono = [...tableRows].reverse();
    return {
      flows: s((r) => r.netFlowsBase),
      income: s((r) => r.incomeBase),
      fees: s((r) => r.feesBase),
      taxes: s((r) => r.taxesBase),
      gain: s((r) => r.gainBase),
      twr: compound(chrono.map((r) => r.twr)),
      bench: hasBench ? compound(chrono.map((r) => r.benchmarkReturns?.[bench] ?? 0)) : undefined,
      start: chrono[0]?.startValueBase,
      end: chrono[chrono.length - 1]?.endValueBase,
    };
  }, [tableRows, bench, hasBench]);

  const exportRows = () => {
    const header = [
      t('monthly.col.month'),
      t('monthly.col.start'),
      t('monthly.col.flows'),
      t('monthly.col.income'),
      t('monthly.col.fees'),
      t('monthly.col.taxes'),
      t('monthly.col.gain'),
      t('monthly.col.end'),
      t('monthly.col.twr'),
      t('monthly.col.cumulative'),
      t('monthly.col.priceEffect'),
      t('monthly.col.fxEffect'),
      ...(hasBench ? [benchmarkName(bench), t('monthly.col.alpha')] : []),
    ];
    const body = rows.map((r) => {
      const b = r.benchmarkReturns?.[bench];
      return [
        r.month,
        r.startValueBase,
        r.netFlowsBase,
        r.incomeBase,
        r.feesBase,
        r.taxesBase,
        r.gainBase,
        r.endValueBase,
        r.twr,
        r.cumulativeTwr,
        r.localReturn ?? '',
        r.fxReturn ?? '',
        ...(hasBench ? [b ?? '', b !== undefined ? r.twr - b : ''] : []),
      ];
    });
    return { header, body };
  };

  const onCsv = () => {
    const { header, body } = exportRows();
    downloadText(`seguimiento-mensual-${f.currency}.csv`, toCsv([header, ...body]), 'text/csv');
  };
  const onXlsx = () => {
    const { header, body } = exportRows();
    const fmts: ('pct' | 'money' | undefined)[] = [undefined, 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'pct', 'pct', 'pct', 'pct', 'pct', 'pct'];
    downloadXlsx(`seguimiento-mensual-${f.currency}.xlsx`, t('monthly.title'), [header, ...body], fmts);
  };

  if (!loading && a && !a.hasTransactions) {
    return (
      <div>
        <PageHeader title={t('monthly.title')} />
        <div className="card">
          <EmptyState icon={<CalendarRange size={20} />} title={t('monthly.emptyTitle')} body={t('monthly.emptyBody')} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t('monthly.title')}
        subtitle={t('monthly.subtitle', { currency: f.currency })}
        actions={
          <>
            <Link to="/mensual/cierre" className="btn btn-primary">
              <CalendarCheck size={15} /> {t('monthly.closeMonth')}
            </Link>
            <button className="btn" onClick={onCsv} disabled={!rows.length} data-testid="export-csv">
              <Download size={15} /> CSV
            </button>
            <button className="btn" onClick={onXlsx} disabled={!rows.length}>
              <FileSpreadsheet size={15} /> XLSX
            </button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi
          loading={loading}
          label={last ? t('monthly.lastMonth', { month: formatMonth(last.month, f.locale, 'long') }) : t('monthly.lastMonthShort')}
          value={<Pct value={last?.twr} signed colored />}
          sub={<Money value={last?.gainBase} signed className="text-xs text-muted" />}
        />
        <Kpi loading={loading} label={t('monthly.cumulative')} value={<Pct value={rows[rows.length - 1]?.cumulativeTwr} signed colored />} sub={<span className="text-xs text-muted">{t('monthly.sinceInception')}</span>} />
        <Kpi
          loading={loading}
          label={t('monthly.best')}
          value={<Pct value={risk?.bestMonth?.twr} signed colored />}
          sub={<span className="text-xs text-muted">{risk?.bestMonth ? formatMonth(risk.bestMonth.month, f.locale) : '—'}</span>}
        />
        <Kpi
          loading={loading}
          label={t('monthly.worst')}
          value={<Pct value={risk?.worstMonth?.twr} signed colored />}
          sub={<span className="text-xs text-muted">{risk?.worstMonth ? formatMonth(risk.worstMonth.month, f.locale) : '—'}</span>}
        />
        <Kpi
          loading={loading}
          label={t('monthly.positiveMonths')}
          value={<Pct value={risk?.positiveMonthsRatio ?? positive} decimals={0} />}
          sub={<span className="text-xs text-muted">{t('monthly.monthsCount', { count: rows.length })}</span>}
        />
      </div>

      <Card
        className="mt-3"
        title={t('monthly.heatmap')}
        subtitle={t('monthly.heatmapSub')}
        actions={
          <>
            <label htmlFor="bench" className="text-xs text-muted">
              {t('monthly.benchmark')}
            </label>
            <select id="bench" className="select !w-auto !h-8" value={bench} onChange={(e) => setBench(e.target.value)}>
              {BENCHMARKS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </>
        }
        bodyClassName="!px-0 !pb-2"
      >
        {loading ? (
          <div className="px-4">
            <Skeleton className="h-40" />
          </div>
        ) : (
          <div className="overflow-x-auto px-4" data-testid="monthly-heatmap">
            <table className="w-full border-separate border-spacing-[3px] text-[12px] min-w-[760px]">
              <thead>
                <tr>
                  <th className="text-left text-muted font-medium w-14 px-1">{t('monthly.year')}</th>
                  {Array.from({ length: 12 }, (_, i) => (
                    <th key={i} className="text-muted font-medium">
                      {monthName(i, f.locale)}
                    </th>
                  ))}
                  <th className="text-ink font-semibold">{t('monthly.yearTotal')}</th>
                  {hasBench && <th className="text-muted font-medium">{benchmarkName(bench)}</th>}
                </tr>
              </thead>
              <tbody>
                {heat.map((y) => (
                  <tr key={y.year}>
                    <th scope="row" className="text-left font-semibold px-1 num">
                      {y.year}
                    </th>
                    {y.months.map((m, i) => (
                      <td key={i} className="p-0">
                        {m ? (
                          <button
                            type="button"
                            onClick={() => {
                              setFocus(m.month);
                              setYear('all');
                              setTimeout(() => document.getElementById(`m-${m.month}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
                            }}
                            title={`${formatMonth(m.month, f.locale, 'long')}: ${formatPct(m.twr, f.locale, { signed: true })}${
                              hasBench && m.benchmarkReturns?.[bench] !== undefined
                                ? ` · ${benchmarkName(bench)} ${formatPct(m.benchmarkReturns[bench], f.locale, { signed: true })}`
                                : ''
                            }`}
                            aria-label={`${formatMonth(m.month, f.locale, 'long')} ${formatPct(m.twr, f.locale, { signed: true })}`}
                            className={clsx(
                              'num w-full h-9 rounded-md text-ink font-medium hover:ring-2 hover:ring-[var(--focus)] transition-shadow',
                              focus === m.month && 'ring-2 ring-[var(--text)]',
                            )}
                            style={heatStyle(m.twr)}
                          >
                            {formatPct(m.twr, f.locale, { signed: true, decimals: 1 })}
                          </button>
                        ) : (
                          <div className="h-9 rounded-md border border-dashed border-line" aria-hidden />
                        )}
                      </td>
                    ))}
                    <td className="p-0">
                      <div className="num h-9 rounded-md grid place-items-center font-semibold border border-line-strong" style={heatStyle(y.annual / 3)}>
                        {formatPct(y.annual, f.locale, { signed: true, decimals: 1 })}
                      </div>
                    </td>
                    {hasBench && (
                      <td className="text-center num text-ink-2">
                        {y.annualBench !== undefined ? formatPct(y.annualBench, f.locale, { signed: true, decimals: 1 }) : '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <HeatLegend />
          </div>
        )}
      </Card>

      <Card
        className="mt-3"
        title={t('monthly.table')}
        subtitle={t('monthly.tableSub')}
        actions={
          <select className="select !w-auto !h-8" aria-label={t('monthly.year')} value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="all">{t('monthly.allYears')}</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        }
        bodyClassName="!p-0"
      >
        {loading ? (
          <div className="p-4">
            <Skeleton className="h-64" />
          </div>
        ) : (
          <div className="overflow-auto max-h-[640px]" data-testid="monthly-table">
            <table className="table">
              <thead>
                <tr>
                  <th className="sticky left-0 z-[3]">{t('monthly.col.month')}</th>
                  <th className="r">{t('monthly.col.start')}</th>
                  <th className="r" title={t('monthly.col.flowsHint')}>
                    {t('monthly.col.flows')}
                  </th>
                  <th className="r">{t('monthly.col.income')}</th>
                  <th className="r">{t('monthly.col.fees')}</th>
                  <th className="r" title={t('monthly.col.gainHint')}>
                    {t('monthly.col.gain')}
                  </th>
                  <th className="r">{t('monthly.col.end')}</th>
                  <th className="r">{t('monthly.col.twr')}</th>
                  <th className="r">{t('monthly.col.cumulative')}</th>
                  <th className="r" title={t('monthly.col.priceEffectHint')}>
                    {t('monthly.col.priceEffect')}
                  </th>
                  <th className="r" title={t('monthly.col.fxEffectHint')}>
                    {t('monthly.col.fxEffect')}
                  </th>
                  {hasBench && <th className="r">{benchmarkName(bench)}</th>}
                  {hasBench && (
                    <th className="r" title={t('monthly.col.alphaHint')}>
                      {t('monthly.col.alpha')}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r, idx) => {
                  const b = r.benchmarkReturns?.[bench];
                  const newYear = idx > 0 && tableRows[idx - 1]!.month.slice(0, 4) !== r.month.slice(0, 4);
                  return (
                    <Fragment key={r.month}>
                      {newYear && (
                        <tr aria-hidden>
                          <td colSpan={hasBench ? 13 : 11} className="!py-1 !bg-surface-2 text-[11px] font-semibold text-muted sticky left-0">
                            {r.month.slice(0, 4)}
                          </td>
                        </tr>
                      )}
                      <tr id={`m-${r.month}`} className={clsx(focus === r.month && '[&>td]:!bg-accent-soft')}>
                        <td className="sticky left-0 bg-surface font-medium z-[1]">
                          {formatMonth(r.month, f.locale)}
                          {r.month === currentMonth && <span className="chip ml-2 !h-5">{t('monthly.inProgress')}</span>}
                        </td>
                        <td className="r">
                          <Money value={r.startValueBase} className="text-ink-2" />
                        </td>
                        <td className="r">
                          <Money value={r.netFlowsBase} signed className={r.netFlowsBase ? '' : 'text-muted'} />
                        </td>
                        <td className="r">
                          <Money value={r.incomeBase} className={r.incomeBase ? 'text-pos' : 'text-muted'} />
                        </td>
                        <td className="r">
                          <Money value={r.feesBase ? -Math.abs(r.feesBase) : 0} className="text-muted" />
                        </td>
                        <td className="r">
                          <Money value={r.gainBase} signed className={r.gainBase >= 0 ? 'text-pos' : 'text-neg'} />
                        </td>
                        <td className="r font-semibold">
                          <Money value={r.endValueBase} />
                        </td>
                        <td className="r">
                          <span className="inline-block px-1.5 py-0.5 rounded-md font-semibold" style={heatStyle(r.twr)}>
                            <Pct value={r.twr} signed />
                          </span>
                        </td>
                        <td className="r">
                          <Pct value={r.cumulativeTwr} signed colored />
                        </td>
                        <td className="r">
                          <Pct value={r.localReturn} signed className="text-ink-2" />
                        </td>
                        <td className="r">
                          <Pct value={r.fxReturn} signed className="text-ink-2" />
                        </td>
                        {hasBench && (
                          <td className="r">
                            <Pct value={b} signed className="text-ink-2" />
                          </td>
                        )}
                        {hasBench && (
                          <td className="r">
                            <Pct value={b !== undefined ? r.twr - b : undefined} signed colored />
                          </td>
                        )}
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
              {tableRows.length > 0 && (
                <tfoot>
                  <tr className="[&>td]:bg-surface-2 [&>td]:font-semibold [&>td]:border-t [&>td]:border-line">
                    <td className="sticky left-0 z-[1]">{t('common.total')}</td>
                    <td className="r">
                      <Money value={totals.start} />
                    </td>
                    <td className="r">
                      <Money value={totals.flows} signed />
                    </td>
                    <td className="r">
                      <Money value={totals.income} />
                    </td>
                    <td className="r">
                      <Money value={-Math.abs(totals.fees)} />
                    </td>
                    <td className="r">
                      <Money value={totals.gain} signed />
                    </td>
                    <td className="r">
                      <Money value={totals.end} />
                    </td>
                    <td className="r">
                      <Pct value={totals.twr} signed colored />
                    </td>
                    <td />
                    <td />
                    <td />
                    {hasBench && (
                      <td className="r">
                        <Pct value={totals.bench} signed />
                      </td>
                    )}
                    {hasBench && (
                      <td className="r">
                        <Pct value={totals.bench !== undefined ? totals.twr - totals.bench : undefined} signed colored />
                      </td>
                    )}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-muted mt-3 max-w-3xl">{t('monthly.footnote', { currency: f.currency })}</p>
    </div>
  );
}

function HeatLegend() {
  const { t } = useTranslation();
  const { locale } = useFmt();
  const steps = [-0.08, -0.04, -0.01, 0, 0.01, 0.04, 0.08];
  return (
    <div className="flex items-center gap-2 mt-3 text-[11px] text-muted flex-wrap" aria-hidden>
      <span>{t('monthly.legend')}</span>
      {steps.map((s) => (
        <span key={s} className="num inline-flex items-center justify-center h-5 px-1.5 rounded text-ink" style={heatStyle(s) ?? { background: 'var(--surface-2)' }}>
          {formatPct(s, locale, { signed: true, decimals: 0 })}
        </span>
      ))}
    </div>
  );
}
