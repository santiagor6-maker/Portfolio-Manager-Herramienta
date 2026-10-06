/**
 * "Informe": a printable monthly/annual report (Guardar como PDF) and a shareable read-only
 * snapshot (self-contained HTML file). Styled with its own plain CSS + inline SVG so the print,
 * the PDF and the snapshot look the same and need nothing else to render.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDown, Printer } from 'lucide-react';
import type { MonthlyRow, PerformanceSummary } from '@pm/core';
import { PageHeader, Segmented, Skeleton, Banner } from '../components/ui';
import { useAnalysis, useInstrumentLabel } from '../hooks/useAnalysis';
import { usePortfolios } from '../hooks/useData';
import { useApp, useFmt } from '../store/app';
import { formatDate, formatMoney, formatMonth, formatPct, monthName, MASK } from '../lib/format';
import { addMonths, monthEnd, todayIso } from '../lib/ids';
import { indexName, useSliceLabel } from '../lib/labels';
import { benchmarkName } from '../lib/benchmarks';
import { exchangeLabel } from '../lib/exchanges';
import { downloadText } from '../lib/export';
import { customSummary } from '../services/engineDirect';
import { compound, benchValue } from './Monthly';
import { annualize, yearsOf } from './Performance';
import type { SeriesPoint } from '../services/analysis';

type Scope = 'month' | 'year' | 'all';

export const REPORT_CSS = `
.rp{font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#0e1525;background:#fff;font-size:12px;line-height:1.45;max-width:1080px;margin:0 auto;padding:28px 32px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.rp *{box-sizing:border-box}
.rp .num{font-variant-numeric:tabular-nums}
.rp h1{font-size:24px;margin:0;letter-spacing:-.01em}
.rp h2{font-size:14px;margin:0 0 8px;padding-bottom:4px;border-bottom:2px solid #0f766e;color:#0e1525}
.rp .cover{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:1px solid #d9dee6;padding-bottom:14px;margin-bottom:16px}
.rp .brand{display:flex;align-items:center;gap:8px;color:#0f766e;font-weight:600;font-size:12px;margin-bottom:6px}
.rp .logo{width:22px;height:22px;border-radius:6px;background:#0f766e;display:inline-block}
.rp .muted{color:#5f687b}
.rp .meta{text-align:right;font-size:11px;color:#5f687b}
.rp .demo{display:inline-block;margin-top:4px;padding:2px 8px;border-radius:999px;background:#fff6e6;color:#b45309;border:1px solid #f3d9a8;font-size:10.5px}
.rp section{margin:0 0 18px;break-inside:avoid}
.rp .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.rp .kpi{border:1px solid #e3e6eb;border-radius:8px;padding:8px 10px}
.rp .kpi .l{font-size:10.5px;color:#5f687b}
.rp .kpi .v{font-size:16px;font-weight:600;margin-top:2px}
.rp .kpi .s{font-size:10.5px;color:#5f687b}
.rp .pos{color:#047857}.rp .neg{color:#c2312f}
.rp table{width:100%;border-collapse:collapse;font-size:10.5px}
.rp th{background:#f3f5f8;color:#5f687b;font-weight:600;text-align:right;padding:4px 5px;border-bottom:1px solid #d9dee6;white-space:nowrap}
.rp th:first-child,.rp td:first-child{text-align:left}
.rp td{padding:3.5px 5px;border-bottom:1px solid #eceef2;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.rp tfoot td{font-weight:600;background:#f3f5f8;border-top:1px solid #d9dee6}
.rp .heat td{padding:2px;border:0}
.rp .heat .c{border-radius:4px;padding:5px 2px;text-align:center;font-weight:500;color:#0e1525}
.rp .heat th{background:none;border:0;text-align:center}
.rp .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.rp .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
.rp .bar{display:grid;grid-template-columns:110px 1fr 46px;align-items:center;gap:6px;margin:3px 0;font-size:10.5px}
.rp .bar .t{height:9px;background:#eef1f5;border-radius:3px;overflow:hidden}
.rp .bar .f{height:100%;border-radius:3px}
.rp .note{font-size:10px;color:#5f687b}
.rp .pb{break-before:page}
@media print{.rp{padding:0;max-width:none}}
`;

const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#8a8f99'];

/** Diverging heat colour (green/red over white) as a plain rgb() string (no color-mix: portable). */
export function heatColor(r: number | undefined): string {
  if (r === undefined || !Number.isFinite(r)) return '#ffffff';
  const s = Math.min(1, Math.abs(r) / 0.08);
  if (s < 0.02) return '#f3f5f8';
  const a = 0.1 + s * 0.55;
  const [R, G, B] = r > 0 ? [4, 120, 87] : [194, 49, 47];
  const mix = (c: number) => Math.round(255 * (1 - a) + c * a);
  return `rgb(${mix(R)},${mix(G)},${mix(B)})`;
}

export default function ReportPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a, loading } = useAnalysis();
  const portfolios = usePortfolios();
  const pid = useApp((s) => s.settings.selectedPortfolioId);
  const today = todayIso();
  const [scope, setScope] = useState<Scope>('year');
  const [year, setYear] = useState(today.slice(0, 4));
  const [month, setMonth] = useState(addMonths(today.slice(0, 7), -1));
  const [summary, setSummary] = useState<PerformanceSummary>();
  const ref = useRef<HTMLDivElement>(null);
  const rows = a?.monthly ?? [];
  const years = [...new Set(rows.map((r) => r.month.slice(0, 4)))].sort().reverse();
  const months = [...rows].map((r) => r.month).reverse();

  const range = useMemo(() => {
    if (!a?.firstDate) return undefined;
    if (scope === 'all') return { from: a.firstDate, to: a.asOf };
    if (scope === 'year') return { from: `${year}-01-01` < a.firstDate ? a.firstDate : `${year}-01-01`, to: `${year}-12-31` > a.asOf ? a.asOf : `${year}-12-31` };
    return { from: `${month}-01`, to: monthEnd(month) > a.asOf ? a.asOf : monthEnd(month) };
  }, [a, scope, year, month]);

  useEffect(() => {
    let cancel = false;
    setSummary(undefined);
    if (range) void customSummary(range.from, range.to).then((s) => !cancel && setSummary(s));
    return () => {
      cancel = true;
    };
  }, [range?.from, range?.to, pid, f.currency, a]); // eslint-disable-line react-hooks/exhaustive-deps

  const periodRows = rows.filter((r) => range && r.month >= range.from.slice(0, 7) && r.month <= range.to.slice(0, 7));
  const portfolioName = pid === 'all' ? t('report.allPortfolios') : (portfolios.find((p) => p.id === pid)?.name ?? '');
  const isDemo = portfolios.some((p) => p.isDemo && (pid === 'all' || p.id === pid));
  const periodLabel =
    scope === 'all' ? t('report.sinceInception') : scope === 'year' ? t('report.yearLabel', { year }) : formatMonth(month, f.locale, 'long');

  const snapshot = () => {
    if (!ref.current) return;
    const html = `<!doctype html><html lang="${f.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t('report.title')} · ${portfolioName} · ${periodLabel}</title><meta name="generator" content="Portafolio Pro"><style>body{margin:0;background:#fff}${REPORT_CSS}</style></head><body>${ref.current.outerHTML}</body></html>`;
    downloadText(`informe-${(portfolioName || 'portafolio').toLowerCase().replace(/[^a-z0-9]+/gi, '-')}-${range?.to ?? today}.html`, html, 'text/html');
  };

  return (
    <div>
      <div className="print:hidden">
        <PageHeader
          title={t('report.title')}
          subtitle={t('report.subtitle')}
          actions={
            <>
              <Segmented<Scope>
                label={t('common.period')}
                value={scope}
                onChange={setScope}
                options={[
                  { value: 'month', label: t('report.month') },
                  { value: 'year', label: t('report.year') },
                  { value: 'all', label: t('period.ALL') },
                ]}
              />
              {scope === 'year' && (
                <select className="select !w-auto" aria-label={t('report.year')} value={year} onChange={(e) => setYear(e.target.value)}>
                  {(years.length ? years : [year]).map((y) => (
                    <option key={y}>{y}</option>
                  ))}
                </select>
              )}
              {scope === 'month' && (
                <select className="select !w-auto" aria-label={t('report.month')} value={month} onChange={(e) => setMonth(e.target.value)}>
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {formatMonth(m, f.locale, 'long')}
                    </option>
                  ))}
                </select>
              )}
              <button className="btn" onClick={snapshot} disabled={!a?.hasTransactions} data-testid="report-snapshot">
                <FileDown size={15} /> {t('report.snapshot')}
              </button>
              <button className="btn btn-primary" onClick={() => window.print()} disabled={!a?.hasTransactions} data-testid="report-print">
                <Printer size={15} /> {t('report.print')}
              </button>
            </>
          }
        />
        <div className="mb-3">
          <Banner tone="info">{t('report.howTo')}</Banner>
        </div>
      </div>
      {loading || !a ? (
        <Skeleton className="h-[600px]" />
      ) : !a.hasTransactions ? (
        <p className="text-muted">{t('common.noData')}</p>
      ) : (
        <div className="card print:border-0 print:shadow-none overflow-x-auto">
          <style>{REPORT_CSS}</style>
          <div ref={ref} className="rp" data-testid="report">
            <ReportBody
              rows={periodRows}
              allRows={rows}
              summary={summary}
              periodLabel={periodLabel}
              portfolioName={portfolioName}
              isDemo={isDemo}
              series={a.series.filter((p) => range && p.date >= range.from && p.date <= range.to)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ReportBody({
  rows,
  allRows,
  summary: s,
  periodLabel,
  portfolioName,
  isDemo,
  series,
}: {
  rows: MonthlyRow[];
  allRows: MonthlyRow[];
  summary?: PerformanceSummary;
  periodLabel: string;
  portfolioName: string;
  isDemo: boolean;
  series: SeriesPoint[];
}) {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a } = useAnalysis();
  const label = useInstrumentLabel();
  const lc = useSliceLabel('assetClass');
  const lco = useSliceLabel('country');
  const lcu = useSliceLabel('currency');
  const bench = useApp((st) => st.settings.benchmarks[0]);
  const m = (v: number | undefined, signed = false) => (f.privacy ? MASK : formatMoney(v, f.currency, f.locale, { signed }));
  const p = (v: number | undefined, signed = true, d = 2) => formatPct(v, f.locale, { signed, decimals: d });
  const cls = (v: number | undefined) => (v === undefined ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const twr = s?.twr ?? compound(rows.map((r) => r.twr));
  const years = yearsOf(s);
  const local = compound(rows.map((r) => r.localReturn ?? 0));
  const fxr = compound(rows.map((r) => r.fxReturn ?? 0));
  const idx = a?.rateIndices.find((i) => s?.percentOfIndex?.[i] !== undefined);
  const hasReal = rows.some((r) => r.realTwr !== undefined);
  const hasBench = !!bench && rows.some((r) => benchValue(r, bench) !== undefined);
  const heatYears = [...new Set(rows.map((r) => r.month.slice(0, 4)))].sort().reverse();
  const holdings = [...(a?.valuation?.holdings ?? [])].filter((h) => h.quantity > 0).sort((x, y) => (y.marketValueBase ?? 0) - (x.marketValueBase ?? 0));
  const income = (a?.income ?? []).filter((e) => rows.length && e.date >= `${rows[0]!.month}-01` && e.date <= monthEnd(rows[rows.length - 1]!.month));
  const incomeBy = new Map<string, number>();
  for (const e of income) incomeBy.set(e.instrumentId ?? 'CASH', (incomeBy.get(e.instrumentId ?? 'CASH') ?? 0) + e.netBase);
  const tot = (fn: (r: MonthlyRow) => number) => rows.reduce((x, r) => x + fn(r), 0);
  const kpis: [string, string, string?, string?][] = [
    [t('report.k.start'), m(s?.startValueBase ?? rows[0]?.startValueBase)],
    [t('report.k.end'), m(s?.endValueBase ?? rows[rows.length - 1]?.endValueBase)],
    [t('report.k.flows'), m(s?.netFlowsBase ?? tot((r) => r.netFlowsBase), true)],
    [t('report.k.gain'), m(s?.gainBase ?? tot((r) => r.gainBase), true), undefined, cls(s?.gainBase)],
    ['TWR', p(twr), years !== undefined && years >= 1 ? `${t('perf.annualized')}: ${p(annualize(twr, years))}` : t('perf.notAnnualized'), cls(twr)],
    [t('perf.mwrShort'), years !== undefined && years < 1 ? p(s?.mwrPeriod) : p(s?.mwr), years !== undefined && years < 1 ? t('perf.inPeriod') : t('perf.perYear'), cls(s?.mwr)],
    [t('report.k.real', { index: indexName(a?.inflationIndex) }), p(s?.realTwr), s?.inflation !== undefined ? `${indexName(a?.inflationIndex)} ${p(s.inflation)}` : undefined, cls(s?.realTwr)],
    [idx ? `% ${indexName(idx)}` : t('report.k.income'), idx ? formatPct(s?.percentOfIndex?.[idx], f.locale, { decimals: 0 }) : m(s?.incomeBase ?? tot((r) => r.incomeBase)), idx ? `${indexName(idx)} ${p(s?.indexReturns?.[idx])}` : undefined],
  ];

  const bars = (slices: { key: string; label: string; valueBase: number; weight: number }[], lab: (x: never) => string) =>
    slices
      .slice()
      .sort((x, y) => y.weight - x.weight)
      .slice(0, 7)
      .map((x, i) => (
        <div className="bar" key={x.key}>
          <span>{lab(x as never)}</span>
          <span className="t">
            <span className="f" style={{ width: `${Math.max(1, x.weight * 100)}%`, background: SERIES[i] }} />
          </span>
          <span className="num">{p(x.weight, false, 1)}</span>
        </div>
      ));

  return (
    <>
      <div className="cover">
        <div>
          <div className="brand">
            <span className="logo" /> Portafolio Pro
          </div>
          <h1>{t('report.title')}</h1>
          <div className="muted" style={{ fontSize: 14, marginTop: 2 }}>
            {portfolioName} · {periodLabel}
          </div>
          {isDemo && <span className="demo">{t('demo.badge')}</span>}
        </div>
        <div className="meta">
          <div>
            {t('report.currency')}: <b>{f.currency}</b>
          </div>
          <div>
            {t('report.generated')}: {formatDate(todayIso(), f.locale)}
          </div>
          {s && (
            <div>
              {formatDate(s.from, f.locale)} – {formatDate(s.to, f.locale)}
            </div>
          )}
        </div>
      </div>

      <section>
        <h2>{t('report.summary')}</h2>
        <div className="kpis">
          {kpis.map(([l, v, sub, c]) => (
            <div className="kpi" key={l}>
              <div className="l">{l}</div>
              <div className={`v num ${c ?? ''}`}>{v}</div>
              {sub && <div className="s">{sub}</div>}
            </div>
          ))}
        </div>
      </section>

      {series.length > 1 && (
        <section>
          <h2>{t('dashboard.valueVsInvested')}</h2>
          <SvgValueChart data={series} privacy={f.privacy} locale={f.locale} currency={f.currency} inflation={a?.inflationIndex ? t('chart.investedReal', { index: indexName(a.inflationIndex) }) : undefined} />
        </section>
      )}

      <section>
        <h2>{t('monthly.heatmap')}</h2>
        <table className="heat">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>{t('monthly.year')}</th>
              {Array.from({ length: 12 }, (_, i) => (
                <th key={i}>{monthName(i, f.locale)}</th>
              ))}
              <th>{t('monthly.yearTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {heatYears.map((y) => {
              const yr = allRows.filter((r) => r.month.startsWith(y));
              return (
                <tr key={y}>
                  <td style={{ fontWeight: 600 }}>{y}</td>
                  {Array.from({ length: 12 }, (_, i) => {
                    const r = yr.find((x) => Number(x.month.slice(5, 7)) === i + 1);
                    return (
                      <td key={i}>
                        <div className="c num" style={{ background: r ? heatColor(r.twr) : '#fff', border: r ? 0 : '1px dashed #e3e6eb' }}>
                          {r ? p(r.twr, true, 1) : ''}
                        </div>
                      </td>
                    );
                  })}
                  <td>
                    <div className="c num" style={{ background: heatColor(compound(yr.map((r) => r.twr)) / 3), fontWeight: 700 }}>
                      {p(compound(yr.map((r) => r.twr)), true, 1)}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2>{t('monthly.table')}</h2>
        <table>
          <thead>
            <tr>
              <th>{t('monthly.col.month')}</th>
              <th>{t('monthly.col.start')}</th>
              <th>{t('monthly.col.flows')}</th>
              <th>{t('monthly.col.income')}</th>
              <th>{t('monthly.col.fees')}</th>
              <th>{t('monthly.col.gain')}</th>
              <th>{t('monthly.col.end')}</th>
              <th>{t('monthly.col.twr')}</th>
              <th>{t('monthly.col.cumulative')}</th>
              <th>{t('monthly.col.priceEffect')}</th>
              <th>{t('monthly.col.fxEffect')}</th>
              {hasReal && <th>{t('monthly.col.real')}</th>}
              {hasBench && <th>{benchmarkName(bench!)}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month}>
                <td>{formatMonth(r.month, f.locale)}</td>
                <td>{m(r.startValueBase)}</td>
                <td>{m(r.netFlowsBase, true)}</td>
                <td>{m(r.incomeBase)}</td>
                <td>{m(-Math.abs(r.feesBase))}</td>
                <td className={cls(r.gainBase)}>{m(r.gainBase, true)}</td>
                <td style={{ fontWeight: 600 }}>{m(r.endValueBase)}</td>
                <td style={{ background: heatColor(r.twr), fontWeight: 600 }}>{p(r.twr)}</td>
                <td className={cls(r.cumulativeTwr)}>{p(r.cumulativeTwr)}</td>
                <td>{p(r.localReturn)}</td>
                <td>{p(r.fxReturn)}</td>
                {hasReal && <td className={cls(r.realTwr)}>{p(r.realTwr)}</td>}
                {hasBench && <td>{p(benchValue(r, bench!))}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>{t('common.total')}</td>
              <td>{m(rows[0]?.startValueBase)}</td>
              <td>{m(tot((r) => r.netFlowsBase), true)}</td>
              <td>{m(tot((r) => r.incomeBase))}</td>
              <td>{m(-Math.abs(tot((r) => r.feesBase)))}</td>
              <td>{m(tot((r) => r.gainBase), true)}</td>
              <td>{m(rows[rows.length - 1]?.endValueBase)}</td>
              <td>{p(compound(rows.map((r) => r.twr)))}</td>
              <td />
              <td>{p(local)}</td>
              <td>{p(fxr)}</td>
              {hasReal && <td>{p(compound(rows.map((r) => r.realTwr ?? 0)))}</td>}
              {hasBench && <td>{p(compound(rows.map((r) => benchValue(r, bench!) ?? 0)))}</td>}
            </tr>
          </tfoot>
        </table>
      </section>

      <section className="pb">
        <h2>{t('dashboard.allocation')}</h2>
        <div className="grid3">
          <div>
            <div className="muted" style={{ marginBottom: 4 }}>{t('dim.assetClass')}</div>
            {bars(a?.allocations.assetClass ?? [], lc as never)}
          </div>
          <div>
            <div className="muted" style={{ marginBottom: 4 }}>{t('dim.country')}</div>
            {bars(a?.allocations.country ?? [], lco as never)}
          </div>
          <div>
            <div className="muted" style={{ marginBottom: 4 }}>{t('dim.currency')}</div>
            {bars(a?.allocations.currency ?? [], lcu as never)}
          </div>
        </div>
      </section>

      <section>
        <h2>{t('report.positions', { date: formatDate(a?.asOf, f.locale) })}</h2>
        <table>
          <thead>
            <tr>
              <th>{t('pos.instrument')}</th>
              <th>{t('manual.exchange')}</th>
              <th>{t('pos.valueBase', { currency: f.currency })}</th>
              <th>{t('pos.weight')}</th>
              <th>{t('pos.unrealized')}</th>
              <th>{t('pos.priceEffect')}</th>
              <th>{t('pos.fxEffect')}</th>
            </tr>
          </thead>
          <tbody>
            {holdings.slice(0, 25).map((h) => (
              <tr key={h.instrumentId}>
                <td>
                  <b>{label(h.instrumentId).symbol}</b> <span className="muted">{label(h.instrumentId).name}</span>
                </td>
                <td>{exchangeLabel(label(h.instrumentId).inst?.exchange)}</td>
                <td>{m(h.marketValueBase)}</td>
                <td>{p(h.weight, false, 1)}</td>
                <td className={cls(h.unrealizedGainBase)}>{m(h.unrealizedGainBase, true)}</td>
                <td>{m(h.priceGainBase, true)}</td>
                <td>{m(h.fxGainBase, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid2">
        <section>
          <h2>{t('report.dividends')}</h2>
          {income.length ? (
            <table>
              <tbody>
                {[...incomeBy.entries()]
                  .sort((x, y) => y[1] - x[1])
                  .slice(0, 12)
                  .map(([id, v]) => (
                    <tr key={id}>
                      <td>{id === 'CASH' ? t('tx.type.INTEREST') : label(id).symbol}</td>
                      <td>{m(v)}</td>
                    </tr>
                  ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{t('common.total')}</td>
                  <td>{m(income.reduce((x, e) => x + e.netBase, 0))}</td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <p className="note">{t('dashboard.noDividends')}</p>
          )}
        </section>
        <section>
          <h2>{t('report.fxEffect')}</h2>
          <table>
            <tbody>
              <tr>
                <td>{t('fx.priceEffect')}</td>
                <td className={cls(local)}>{p(local)}</td>
                <td>{m(s?.priceGainBase, true)}</td>
              </tr>
              <tr>
                <td>{t('fx.fxEffect')}</td>
                <td className={cls(fxr)}>{p(fxr)}</td>
                <td>{m(s?.fxGainBase, true)}</td>
              </tr>
              <tr>
                <td>{t('report.combined')}</td>
                <td className={cls((1 + local) * (1 + fxr) - 1)}>{p((1 + local) * (1 + fxr) - 1)}</td>
                <td className="note">(1+p)(1+d)−1</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <section>
        <h2>{t('report.methodology')}</h2>
        <p className="note">{t('report.methodologyText', { currency: f.currency, index: indexName(a?.inflationIndex) })}</p>
        <p className="note">{t('report.disclaimer')}</p>
      </section>
    </>
  );
}

/** Static SVG line chart (value vs. invested) for print and snapshots. */
function SvgValueChart({ data, privacy, locale, currency, inflation }: { data: SeriesPoint[]; privacy: boolean; locale: string; currency: string; inflation?: string }) {
  const { t } = useTranslation();
  const W = 1000;
  const H = 220;
  const pad = { l: 70, r: 10, t: 10, b: 24 };
  const vals = data.flatMap((d) => [d.valueBase, d.netInvestedBase, d.investedRealBase ?? d.netInvestedBase]);
  const min = Math.min(...vals) * 0.97;
  const max = Math.max(...vals) * 1.02;
  const x = (i: number) => pad.l + (i / Math.max(1, data.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b);
  const path = (fn: (d: SeriesPoint) => number) => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(fn(d)).toFixed(1)}`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => min + (max - min) * k);
  const xt = [0, Math.floor(data.length / 3), Math.floor((2 * data.length) / 3), data.length - 1];
  const hasReal = !!inflation && data.some((d) => d.investedRealBase !== undefined);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={t('chart.valueAria')}>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#eceef2" />
          <text x={pad.l - 6} y={y(v) + 3} fontSize="10" textAnchor="end" fill="#5f687b">
            {privacy ? '' : formatMoney(v, currency, locale, { compact: true })}
          </text>
        </g>
      ))}
      {xt.map((i) => (
        <text key={i} x={x(i)} y={H - 6} fontSize="10" textAnchor="middle" fill="#5f687b">
          {data[i] ? formatDate(data[i]!.date, locale, 'short') : ''}
        </text>
      ))}
      <path d={`${path((d) => d.valueBase)}L${x(data.length - 1)},${y(min)}L${x(0)},${y(min)}Z`} fill="rgba(42,120,214,.12)" />
      <path d={path((d) => d.valueBase)} fill="none" stroke="#2a78d6" strokeWidth="2" />
      <path d={path((d) => d.netInvestedBase)} fill="none" stroke="#7a8396" strokeWidth="1.5" />
      {hasReal && <path d={path((d) => d.investedRealBase ?? d.netInvestedBase)} fill="none" stroke="#eb6834" strokeWidth="1.5" strokeDasharray="3 3" />}
      <g fontSize="10.5" fill="#3f4a5e">
        <rect x={pad.l + 6} y={pad.t + 2} width="10" height="3" fill="#2a78d6" />
        <text x={pad.l + 20} y={pad.t + 7}>{t('chart.value')}</text>
        <rect x={pad.l + 90} y={pad.t + 2} width="10" height="3" fill="#7a8396" />
        <text x={pad.l + 104} y={pad.t + 7}>{t('chart.invested')}</text>
        {hasReal && (
          <>
            <rect x={pad.l + 210} y={pad.t + 2} width="10" height="3" fill="#eb6834" />
            <text x={pad.l + 224} y={pad.t + 7}>{inflation}</text>
          </>
        )}
      </g>
    </svg>
  );
}
