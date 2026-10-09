import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { CalendarCheck, CalendarRange, ChevronDown, Columns3, Download, FileSpreadsheet, FileText, Rows3 } from 'lucide-react';
import type { MonthlyRow } from '@pm/core';
import { Card, EmptyState, Kpi, Money, PageHeader, Pct, Segmented, Skeleton } from '../components/ui';
import { useAnalysis } from '../hooks/useAnalysis';
import { useApp, useFmt } from '../store/app';
import { formatMonth, formatPct, monthName } from '../lib/format';
import { BENCHMARKS, benchmarkName } from '../lib/benchmarks';
import { PriceWarnings } from '../components/PriceWarnings';
import { downloadText, downloadXlsx, toCsv } from '../lib/export';
import { indexName } from '../lib/labels';

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

export type ReturnMode = 'nominal' | 'real';

export function rowReturn(r: MonthlyRow, mode: ReturnMode): number {
  return mode === 'real' && r.realTwr !== undefined ? r.realTwr : r.twr;
}

export function buildHeatmap(rows: MonthlyRow[], bench?: string, mode: ReturnMode = 'nominal'): YearRow[] {
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
      const benchVals = bench ? present.map((m) => benchValue(m, bench)).filter((v): v is number => v !== undefined) : [];
      return {
        year,
        months,
        annual: compound(present.map((m) => rowReturn(m, mode))),
        annualBench: benchVals.length === present.length && benchVals.length ? compound(benchVals) : undefined,
      };
    });
}

/** Benchmark return for a month: price/total benchmarks or a rate index (CDI, IBR...). */
export function benchValue(r: MonthlyRow, id: string): number | undefined {
  return r.benchmarkReturns?.[id] ?? r.indexReturns?.[id];
}

export function heatStyle(r: number | undefined): React.CSSProperties | undefined {
  if (r === undefined || !Number.isFinite(r)) return undefined;
  const cap = 0.08;
  const strength = Math.min(1, Math.abs(r) / cap);
  if (strength < 0.02) return { background: 'var(--surface-2)' };
  const pct = Math.round(10 + strength * 55);
  const color = r > 0 ? 'var(--pos)' : 'var(--neg)';
  return { background: `color-mix(in srgb, ${color} ${pct}%, var(--surface))` };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export type ColKey =
  | 'start'
  | 'flows'
  | 'income'
  | 'fees'
  | 'gain'
  | 'end'
  | 'twr'
  | 'cumulative'
  | 'local'
  | 'fx'
  | 'inflation'
  | 'real'
  | 'bench'
  | 'alpha'
  | 'pctIndex';

export const ALL_COLUMNS: ColKey[] = ['start', 'flows', 'income', 'fees', 'gain', 'end', 'twr', 'cumulative', 'local', 'fx', 'inflation', 'real', 'bench', 'alpha', 'pctIndex'];
/** Default view: fits at 1440 px with price/FX effects and benchmark visible. */
// Real return lives in the Nominal/Real switch (and the complete set) so the essential view fits 1440 px.
export const ESSENTIAL_COLUMNS: ColKey[] = ['flows', 'income', 'gain', 'end', 'twr', 'cumulative', 'local', 'fx', 'bench', 'alpha'];

export function resolveColumns(setting: string[] | 'essential' | 'complete'): ColKey[] {
  if (setting === 'complete') return ALL_COLUMNS;
  if (setting === 'essential') return ESSENTIAL_COLUMNS;
  return ALL_COLUMNS.filter((c) => setting.includes(c));
}

export default function MonthlyPage() {
  const { t } = useTranslation();
  const { analysis: a, loading } = useAnalysis();
  const f = useFmt();
  const settings = useApp((s) => s.settings);
  const setSetting = useApp((s) => s.setSetting);
  const rateIndices = a?.rateIndices ?? [];
  const [bench, setBench] = useState<string>(settings.benchmarks[0] ?? 'XBOG:ICOLCAP');
  const [year, setYear] = useState<string>('all');
  const [focus, setFocus] = useState<string>();

  const rows = a?.monthly ?? [];
  const hasReal = rows.some((r) => r.realTwr !== undefined);
  const mode: ReturnMode = settings.realReturns && hasReal ? 'real' : 'nominal';
  const hasBench = rows.some((r) => benchValue(r, bench) !== undefined);
  const pctIndexId = rateIndices.find((i) => rows.some((r) => r.percentOfIndex?.[i] !== undefined));
  const heat = useMemo(() => buildHeatmap(rows, hasBench ? bench : undefined, mode), [rows, bench, hasBench, mode]);
  const years = heat.map((h) => h.year);
  const tableRows = useMemo(() => [...rows].filter((r) => year === 'all' || r.month.startsWith(year)).reverse(), [rows, year]);

  const cols = resolveColumns(settings.monthlyColumns).filter(
    (c) => (c !== 'bench' && c !== 'alpha') || hasBench,
  ).filter((c) => (c !== 'real' && c !== 'inflation') || hasReal).filter((c) => c !== 'pctIndex' || !!pctIndexId);
  const compact = settings.density === 'compact';

  const currentMonth = (a?.asOf ?? '').slice(0, 7);
  const closedRows = rows.filter((r) => r.month < currentMonth && !r.partial);
  const last = closedRows[closedRows.length - 1] ?? rows[rows.length - 1];
  const risk = a?.risk;
  const positive = rows.length ? rows.filter((r) => r.twr > 0).length / rows.length : undefined;
  const lastRow = rows[rows.length - 1];

  const totals = useMemo(() => {
    const s = (fn: (r: MonthlyRow) => number) => tableRows.reduce((acc, r) => acc + fn(r), 0);
    const chrono = [...tableRows].reverse();
    return {
      flows: s((r) => r.netFlowsBase),
      income: s((r) => r.incomeBase),
      fees: s((r) => r.feesBase),
      gain: s((r) => r.gainBase),
      twr: compound(chrono.map((r) => r.twr)),
      real: hasReal ? compound(chrono.map((r) => r.realTwr ?? 0)) : undefined,
      inflation: hasReal ? compound(chrono.map((r) => r.inflation ?? 0)) : undefined,
      local: compound(chrono.map((r) => r.localReturn ?? 0)),
      fx: compound(chrono.map((r) => r.fxReturn ?? 0)),
      bench: hasBench ? compound(chrono.map((r) => benchValue(r, bench) ?? 0)) : undefined,
      start: chrono[0]?.startValueBase,
      end: chrono[chrono.length - 1]?.endValueBase,
    };
  }, [tableRows, bench, hasBench, hasReal]);

  const colDef: Record<ColKey, { label: string; hint?: string; cell: (r: MonthlyRow) => ReactNode; total?: ReactNode; csv: (r: MonthlyRow) => number | string; fmt?: 'pct' | 'money' }> = {
    start: { label: t('monthly.col.start'), cell: (r) => <Money value={r.startValueBase} className="text-ink-2" />, total: <Money value={totals.start} />, csv: (r) => r.startValueBase, fmt: 'money' },
    flows: { label: t('monthly.col.flows'), hint: t('monthly.col.flowsHint'), cell: (r) => <Money value={r.netFlowsBase} signed className={r.netFlowsBase ? '' : 'text-muted'} />, total: <Money value={totals.flows} signed />, csv: (r) => r.netFlowsBase, fmt: 'money' },
    income: { label: t('monthly.col.income'), cell: (r) => <Money value={r.incomeBase} className={r.incomeBase ? 'text-pos' : 'text-muted'} />, total: <Money value={totals.income} />, csv: (r) => r.incomeBase, fmt: 'money' },
    fees: { label: t('monthly.col.fees'), cell: (r) => <Money value={r.feesBase ? -Math.abs(r.feesBase) : 0} className="text-muted" />, total: <Money value={-Math.abs(totals.fees)} />, csv: (r) => -Math.abs(r.feesBase), fmt: 'money' },
    gain: { label: t('monthly.col.gain'), hint: t('monthly.col.gainHint'), cell: (r) => <Money value={r.gainBase} signed className={r.gainBase >= 0 ? 'text-pos' : 'text-neg'} />, total: <Money value={totals.gain} signed />, csv: (r) => r.gainBase, fmt: 'money' },
    end: { label: t('monthly.col.end'), cell: (r) => <Money value={r.endValueBase} className="font-semibold" />, total: <Money value={totals.end} />, csv: (r) => r.endValueBase, fmt: 'money' },
    twr: {
      label: t('monthly.col.twr'),
      cell: (r) => (
        <span className="inline-block px-1.5 py-0.5 rounded-md font-semibold print-heat" style={heatStyle(r.twr)}>
          <Pct value={r.twr} signed />
        </span>
      ),
      total: <Pct value={totals.twr} signed colored />,
      csv: (r) => r.twr,
      fmt: 'pct',
    },
    cumulative: { label: t('monthly.col.cumulative'), cell: (r) => <Pct value={r.cumulativeTwr} signed colored />, csv: (r) => r.cumulativeTwr, fmt: 'pct' },
    local: { label: t('monthly.col.priceEffect'), hint: t('monthly.col.priceEffectHint'), cell: (r) => <Pct value={r.localReturn} signed className="text-ink-2" />, total: <Pct value={totals.local} signed />, csv: (r) => r.localReturn ?? '', fmt: 'pct' },
    fx: { label: t('monthly.col.fxEffect'), hint: t('monthly.col.fxEffectHint'), cell: (r) => <Pct value={r.fxReturn} signed className="text-ink-2" />, total: <Pct value={totals.fx} signed />, csv: (r) => r.fxReturn ?? '', fmt: 'pct' },
    inflation: { label: t('monthly.col.inflation', { index: indexName(a?.inflationIndex) }), cell: (r) => <Pct value={r.inflation} signed className="text-ink-2" />, total: <Pct value={totals.inflation} signed />, csv: (r) => r.inflation ?? '', fmt: 'pct' },
    real: { label: t('monthly.col.real'), hint: t('monthly.col.realHint', { index: indexName(a?.inflationIndex) }), cell: (r) => <Pct value={r.realTwr} signed colored />, total: <Pct value={totals.real} signed colored />, csv: (r) => r.realTwr ?? '', fmt: 'pct' },
    bench: { label: benchmarkName(bench).replace(/\s*\(.*\)$/, ''), hint: benchmarkName(bench), cell: (r) => <Pct value={benchValue(r, bench)} signed className="text-ink-2" />, total: <Pct value={totals.bench} signed />, csv: (r) => benchValue(r, bench) ?? '', fmt: 'pct' },
    alpha: {
      label: t('monthly.col.alpha'),
      hint: t('monthly.col.alphaHint'),
      cell: (r) => {
        const b = benchValue(r, bench);
        return <Pct value={b !== undefined ? r.twr - b : undefined} signed colored />;
      },
      total: <Pct value={totals.bench !== undefined ? totals.twr - totals.bench : undefined} signed colored />,
      csv: (r) => (benchValue(r, bench) !== undefined ? r.twr - benchValue(r, bench)! : ''),
      fmt: 'pct',
    },
    pctIndex: {
      label: t('monthly.col.pctIndex', { index: indexName(pctIndexId) }),
      hint: t('monthly.col.pctIndexHint', { index: indexName(pctIndexId) }),
      cell: (r) => <Pct value={pctIndexId ? r.percentOfIndex?.[pctIndexId] : undefined} decimals={0} className="text-ink-2" />,
      csv: (r) => (pctIndexId ? (r.percentOfIndex?.[pctIndexId] ?? '') : ''),
      fmt: 'pct',
    },
  };

  const exportRows = () => {
    const keys = ALL_COLUMNS.filter((c) => (c !== 'bench' && c !== 'alpha') || hasBench).filter((c) => (c !== 'real' && c !== 'inflation') || hasReal).filter((c) => c !== 'pctIndex' || !!pctIndexId);
    const header = [t('monthly.col.month'), ...keys.map((k) => colDef[k].label)];
    const body = rows.map((r) => [r.month, ...keys.map((k) => colDef[k].csv(r))]);
    return { header, body, fmts: [undefined, ...keys.map((k) => colDef[k].fmt)] };
  };
  const onCsv = () => {
    const { header, body } = exportRows();
    downloadText(`seguimiento-mensual-${f.currency}.csv`, toCsv([header, ...body]), 'text/csv');
  };
  const onXlsx = () => {
    const { header, body, fmts } = exportRows();
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

  const benchOptions = [...BENCHMARKS.map((b) => ({ id: b.id, name: b.name })), ...rateIndices.map((i) => ({ id: i, name: indexName(i) }))];
  const pending = (a?.pendingCloses ?? []).reduce((s, p) => s + p.months.length, 0);

  return (
    <div>
      <PageHeader
        title={t('monthly.title')}
        subtitle={t('monthly.subtitle', { currency: f.currency })}
        actions={
          <>
            <Link to="/mensual/cierre" className="btn btn-primary">
              <CalendarCheck size={15} /> {t('monthly.closeMonth')}
              {pending > 0 && <span className="chip !h-5 !bg-white/20 !text-inherit !border-transparent">{pending}</span>}
            </Link>
            <Link to="/informe" className="btn">
              <FileText size={15} /> {t('report.short')}
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
          label={last ? t('monthly.lastMonth', { month: formatMonth(last.month, f.locale) }) : t('monthly.lastMonthShort')}
          value={<Pct value={last ? rowReturn(last, mode) : undefined} signed colored />}
          sub={<Money value={last?.gainBase} signed className="text-xs text-muted" />}
          hint={last ? formatMonth(last.month, f.locale, 'long') : undefined}
        />
        <Kpi
          loading={loading}
          label={t('monthly.cumulative')}
          value={<Pct value={mode === 'real' ? lastRow?.cumulativeRealTwr : lastRow?.cumulativeTwr} signed colored />}
          sub={
            <span className="text-xs text-muted">
              {mode === 'real' ? t('monthly.sinceInceptionReal', { index: indexName(a?.inflationIndex) }) : t('monthly.sinceInception')}
            </span>
          }
        />
        <Kpi loading={loading} label={t('monthly.best')} value={<Pct value={risk?.bestMonth?.twr} signed colored />} sub={<span className="text-xs text-muted">{risk?.bestMonth ? formatMonth(risk.bestMonth.month, f.locale) : '—'}</span>} />
        <Kpi loading={loading} label={t('monthly.worst')} value={<Pct value={risk?.worstMonth?.twr} signed colored />} sub={<span className="text-xs text-muted">{risk?.worstMonth ? formatMonth(risk.worstMonth.month, f.locale) : '—'}</span>} />
        <Kpi
          loading={loading}
          label={t('monthly.positiveMonths')}
          value={<Pct value={risk?.positiveMonthsRatio ?? positive} decimals={0} />}
          sub={<span className="text-xs text-muted">{t('monthly.monthsCount', { count: rows.length })}</span>}
        />
      </div>

      <Card
        className="mt-3 print-break-avoid"
        title={t('monthly.heatmap')}
        subtitle={mode === 'real' ? t('monthly.heatmapSubReal', { index: indexName(a?.inflationIndex) }) : t('monthly.heatmapSub')}
        actions={
          <>
            {hasReal && (
              <Segmented<ReturnMode>
                label={t('monthly.mode')}
                value={mode}
                onChange={(v) => setSetting('realReturns', v === 'real')}
                options={[
                  { value: 'nominal', label: t('monthly.nominal') },
                  { value: 'real', label: t('monthly.real') },
                ]}
              />
            )}
            <label htmlFor="bench" className="text-xs text-muted print:hidden">
              {t('monthly.benchmark')}
            </label>
            <select id="bench" className="select !w-auto !h-8 print:hidden" value={bench} onChange={(e) => setBench(e.target.value)}>
              {benchOptions.map((b) => (
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
          <div className="px-4" data-testid="monthly-heatmap">
            <Heatmap heat={heat} mode={mode} bench={hasBench ? bench : undefined} focus={focus} onPick={(m) => {
              setFocus(m);
              setYear('all');
              setTimeout(() => document.getElementById(`m-${m}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
            }} />
            <HeatLegend />
          </div>
        )}
      </Card>

      <Card
        className="mt-3"
        title={t('monthly.table')}
        subtitle={t('monthly.tableSub')}
        actions={
          <div className="flex items-center gap-2 flex-wrap print:hidden">
            <ColumnChooser cols={cols} available={Object.keys(colDef) as ColKey[]} labels={Object.fromEntries(Object.entries(colDef).map(([k, v]) => [k, v.label]))} />
            <button
              className="btn btn-sm"
              aria-pressed={compact}
              onClick={() => setSetting('density', compact ? 'comfortable' : 'compact')}
              title={t('monthly.density')}
            >
              <Rows3 size={14} /> {compact ? t('monthly.comfortable') : t('monthly.compact')}
            </button>
            <select className="select !w-auto !h-8" aria-label={t('monthly.year')} value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="all">{t('monthly.allYears')}</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        }
        bodyClassName="!p-0"
      >
        {loading ? (
          <div className="p-4">
            <Skeleton className="h-64" />
          </div>
        ) : (
          <>
            {/* Desktop / tablet table */}
            <div className="hidden md:block overflow-x-auto print:block print:overflow-visible" data-testid="monthly-table">
              <table className={clsx('table monthly-table', compact && 'table-compact')}>
                <thead>
                  <tr>
                    <th className="sticky left-0 z-[3]">{t('monthly.col.month')}</th>
                    {cols.map((c) => (
                      <th key={c} className="r" title={colDef[c].hint}>
                        {colDef[c].label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r, idx) => {
                    const newYear = idx > 0 && tableRows[idx - 1]!.month.slice(0, 4) !== r.month.slice(0, 4);
                    return (
                      <Fragment key={r.month}>
                        {newYear && (
                          <tr aria-hidden>
                            <td colSpan={cols.length + 1} className="!py-1 !bg-surface-2 text-[11px] font-semibold text-muted sticky left-0">
                              {r.month.slice(0, 4)}
                            </td>
                          </tr>
                        )}
                        <tr id={`m-${r.month}`} className={clsx(focus === r.month && '[&>td]:!bg-accent-soft')}>
                          <td className="sticky left-0 bg-surface font-medium z-[1]">
                            {formatMonth(r.month, f.locale)}
                            {r.warnings?.length ? (
                              <span className="ml-1.5">
                                <PriceWarnings warnings={r.warnings} from={`${r.month}-01`} to={`${r.month}-31`} compact />
                              </span>
                            ) : null}
                            {(r.partial || r.month === currentMonth) && <span className="block text-[10.5px] font-normal text-muted leading-tight">{t('monthly.inProgress')}</span>}
                          </td>
                          {cols.map((c) => (
                            <td key={c} className="r">
                              {colDef[c].cell(r)}
                            </td>
                          ))}
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
                {tableRows.length > 0 && (
                  <tfoot>
                    <tr className="[&>td]:bg-surface-2 [&>td]:font-semibold [&>td]:border-t [&>td]:border-line">
                      <td className="sticky left-0 z-[1]">{t('common.total')}</td>
                      {cols.map((c) => (
                        <td key={c} className="r">
                          {colDef[c].total ?? ''}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {/* Phone: one card per month */}
            <ul className="md:hidden print:hidden divide-y divide-line" data-testid="monthly-cards">
              {tableRows.map((r) => (
                <li key={r.month}>
                  <details className="group">
                    <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer list-none">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">
                          {formatMonth(r.month, f.locale)}
                          {r.month === currentMonth && <span className="chip ml-2 !h-5">{t('monthly.inProgress')}</span>}
                          {r.warnings?.length ? (
                            <span className="ml-2">
                              <PriceWarnings warnings={r.warnings} from={`${r.month}-01`} to={`${r.month}-31`} />
                            </span>
                          ) : null}
                        </div>
                        <div className="text-xs text-muted">
                          <Money value={r.endValueBase} /> · <Money value={r.gainBase} signed />
                        </div>
                      </div>
                      <span className="inline-block px-2 py-1 rounded-md font-semibold text-[13px]" style={heatStyle(rowReturn(r, mode))}>
                        <Pct value={rowReturn(r, mode)} signed />
                      </span>
                      <ChevronDown size={16} className="text-muted transition-transform group-open:rotate-180" aria-hidden />
                    </summary>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-4 pb-3 text-[12.5px]">
                      {ALL_COLUMNS.filter((c) => (c !== 'bench' && c !== 'alpha') || hasBench).filter((c) => (c !== 'real' && c !== 'inflation') || hasReal).filter((c) => c !== 'pctIndex' || !!pctIndexId).map((c) => (
                        <div key={c} className="flex justify-between gap-2 border-b border-line/60 py-1">
                          <dt className="text-muted truncate">{colDef[c].label}</dt>
                          <dd className="num text-right">{colDef[c].cell(r)}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <p className="text-xs text-muted mt-3 max-w-3xl">{t('monthly.footnote', { currency: f.currency })}</p>
    </div>
  );
}

function ColumnChooser({ cols, available, labels }: { cols: ColKey[]; available: ColKey[]; labels: Record<string, string> }) {
  const { t } = useTranslation();
  const setting = useApp((s) => s.settings.monthlyColumns);
  const setSetting = useApp((s) => s.setSetting);
  const preset = typeof setting === 'string' ? setting : 'custom';
  return (
    <details className="relative">
      <summary className="btn btn-sm list-none" aria-label={t('monthly.columns')}>
        <Columns3 size={14} /> {t('monthly.columns')}: {t(`monthly.preset.${preset}`)}
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-64 card !rounded-lg p-3 shadow-lg flex flex-col gap-2" role="group" aria-label={t('monthly.columns')}>
        <div className="flex gap-1">
          <button className={clsx('btn btn-sm flex-1', preset === 'essential' && '!border-accent !text-accent')} onClick={() => setSetting('monthlyColumns', 'essential')}>
            {t('monthly.preset.essential')}
          </button>
          <button className={clsx('btn btn-sm flex-1', preset === 'complete' && '!border-accent !text-accent')} onClick={() => setSetting('monthlyColumns', 'complete')}>
            {t('monthly.preset.complete')}
          </button>
        </div>
        <ul className="flex flex-col gap-1 max-h-72 overflow-auto">
          {ALL_COLUMNS.filter((c) => available.includes(c)).map((c) => (
            <li key={c}>
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={cols.includes(c)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...cols, c] : cols.filter((x) => x !== c);
                    setSetting('monthlyColumns', next);
                  }}
                />
                {labels[c]}
              </label>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

export function Heatmap({
  heat,
  mode,
  bench,
  focus,
  onPick,
}: {
  heat: YearRow[];
  mode: ReturnMode;
  bench?: string;
  focus?: string;
  onPick?: (month: string) => void;
}) {
  const { t } = useTranslation();
  const f = useFmt();
  const cell = (m: MonthlyRow | undefined, i: number, small = false) => {
    if (!m) return <div className={clsx('rounded-md border border-dashed border-line', small ? 'h-8' : 'h-9')} aria-hidden key={i} />;
    const v = rowReturn(m, mode);
    const bv = bench ? benchValue(m, bench) : undefined;
    return (
      <button
        key={i}
        type="button"
        onClick={() => onPick?.(m.month)}
        title={`${formatMonth(m.month, f.locale, 'long')}: ${formatPct(v, f.locale, { signed: true })}${bv !== undefined ? ` · ${benchmarkName(bench!)} ${formatPct(bv, f.locale, { signed: true })}` : ''}`}
        aria-label={`${formatMonth(m.month, f.locale, 'long')} ${formatPct(v, f.locale, { signed: true })}`}
        className={clsx(
          'num w-full rounded-md text-ink font-medium hover:ring-2 hover:ring-[var(--focus)] transition-shadow print-heat',
          small ? 'h-8 text-[11px]' : 'h-9',
          focus === m.month && 'ring-2 ring-[var(--text)]',
        )}
        style={heatStyle(v)}
      >
        {small ? <span className="block leading-tight"><span className="block text-[9px] text-ink-2">{monthName(i, f.locale)}</span>{formatPct(v, f.locale, { signed: true, decimals: 1 })}</span> : formatPct(v, f.locale, { signed: true, decimals: 1 })}
      </button>
    );
  };
  return (
    <>
      <table className="hidden md:table print:table w-full border-separate border-spacing-[3px] text-[12px]">
        <thead>
          <tr>
            <th className="text-left text-muted font-medium w-14 px-1">{t('monthly.year')}</th>
            {Array.from({ length: 12 }, (_, i) => (
              <th key={i} className="text-muted font-medium">
                {monthName(i, f.locale)}
              </th>
            ))}
            <th className="text-ink font-semibold">{t('monthly.yearTotal')}</th>
            {bench && <th className="text-muted font-medium">{benchmarkName(bench)}</th>}
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
                  {cell(m, i)}
                </td>
              ))}
              <td className="p-0">
                <div className="num h-9 rounded-md grid place-items-center font-semibold border border-line-strong print-heat" style={heatStyle(y.annual / 3)}>
                  {formatPct(y.annual, f.locale, { signed: true, decimals: 1 })}
                </div>
              </td>
              {bench && <td className="text-center num text-ink-2">{y.annualBench !== undefined ? formatPct(y.annualBench, f.locale, { signed: true, decimals: 1 }) : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {/* Phone: one compact grid per year */}
      <div className="md:hidden print:hidden flex flex-col gap-3">
        {heat.map((y) => (
          <div key={y.year}>
            <div className="flex items-center justify-between mb-1 text-[13px]">
              <span className="font-semibold num">{y.year}</span>
              <span className="num font-semibold px-1.5 rounded" style={heatStyle(y.annual / 3)}>
                {formatPct(y.annual, f.locale, { signed: true, decimals: 1 })}
                {bench && y.annualBench !== undefined && <span className="text-ink-2 font-normal"> · {formatPct(y.annualBench, f.locale, { signed: true, decimals: 1 })}</span>}
              </span>
            </div>
            <div className="grid grid-cols-6 gap-1">{y.months.map((m, i) => cell(m, i, true))}</div>
          </div>
        ))}
      </div>
    </>
  );
}

export function HeatLegend() {
  const { t } = useTranslation();
  const { locale } = useFmt();
  const steps = [-0.08, -0.04, -0.01, 0, 0.01, 0.04, 0.08];
  return (
    <div className="flex items-center gap-2 mt-3 text-[11px] text-muted flex-wrap" aria-hidden>
      <span>{t('monthly.legend')}</span>
      {steps.map((s) => (
        <span key={s} className="num inline-flex items-center justify-center h-5 px-1.5 rounded text-ink print-heat" style={heatStyle(s) ?? { background: 'var(--surface-2)' }}>
          {formatPct(s, locale, { signed: true, decimals: 0 })}
        </span>
      ))}
    </div>
  );
}
