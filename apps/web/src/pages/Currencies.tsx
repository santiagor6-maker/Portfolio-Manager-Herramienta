import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import * as core from '@pm/core';
import { Card, Delta, Kpi, Money, PageHeader, Pct, Segmented, Skeleton } from '../components/ui';
import { AllocationDonut, GroupedBars, LineChart } from '../components/charts';
import { useAnalysis, type ChartPeriod, periodStart } from '../hooks/useAnalysis';
import { useFmt } from '../store/app';
import { db } from '../db/schema';
import { FX_PAIRS } from '../lib/currencies';
import { addDays } from '../lib/ids';
import { formatFxRate, formatPct, formatRelative } from '../lib/format';
import { useSliceLabel } from '../lib/labels';
import { compound } from './Monthly';

export default function CurrenciesPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a, loading } = useAnalysis();
  const fxRows = useLiveQuery(() => db.fxSeries.toArray(), []);
  const [pair, setPair] = useState(0);
  const [period, setPeriod] = useState<ChartPeriod>('1Y');
  const sliceLabel = useSliceLabel('currency');

  const holdings = a?.valuation?.holdings ?? [];
  const fxGain = holdings.reduce((s, h) => s + (h.fxGainBase ?? 0), 0);
  const priceGain = holdings.reduce((s, h) => s + (h.priceGainBase ?? 0), 0);
  const unrealized = holdings.reduce((s, h) => s + (h.unrealizedGainBase ?? 0), 0);

  const monthly = a?.monthly ?? [];
  const cumLocal = compound(monthly.map((m) => m.localReturn ?? 0));
  const cumFx = compound(monthly.map((m) => m.fxReturn ?? 0));

  const yearly = useMemo(() => {
    const by = new Map<string, { local: number[]; fx: number[] }>();
    for (const m of monthly) {
      const y = m.month.slice(0, 4);
      const e = by.get(y) ?? { local: [], fx: [] };
      e.local.push(m.localReturn ?? 0);
      e.fx.push(m.fxReturn ?? 0);
      by.set(y, e);
    }
    const years = [...by.keys()].sort();
    return {
      years,
      series: [
        { name: t('fx.priceEffect'), data: years.map((y) => compound(by.get(y)!.local)), colorIndex: 0 },
        { name: t('fx.fxEffect'), data: years.map((y) => compound(by.get(y)!.fx)), colorIndex: 1 },
      ],
    };
  }, [monthly, t]);

  // Rates history (fill-forward + triangulation via the engine's MarketData).
  const market = useMemo(() => {
    if (!fxRows) return undefined;
    try {
      return core.createMarketData({ prices: [], fx: fxRows.map(({ base, quote, points, source }) => ({ base, quote, points, source })) });
    } catch {
      return undefined;
    }
  }, [fxRows]);
  const earliest = useMemo(() => (fxRows ?? []).reduce((m, s) => (s.points[0] && s.points[0].date < m ? s.points[0].date : m), '9999'), [fxRows]);
  const asOf = a?.asOf ?? new Date().toISOString().slice(0, 10);
  const [base, quote] = FX_PAIRS[pair]!;
  const rateSeries = useMemo(() => {
    if (!market || earliest === '9999') return [];
    const from = periodStart(period, asOf, earliest);
    const span = (Date.parse(asOf) - Date.parse(from)) / 86_400_000;
    const step = span > 800 ? 7 : 1;
    const out: [string, number][] = [];
    for (let d = from; d <= asOf; d = addDays(d, step)) {
      const r = market.fx(base, quote, d);
      if (r !== undefined) out.push([d, r]);
    }
    return out;
  }, [market, earliest, period, asOf, base, quote]);
  const first = rateSeries[0]?.[1];
  const last = rateSeries[rateSeries.length - 1]?.[1];
  const fxFmt = useCallback((v: number) => formatFxRate(v, f.locale), [f.locale]);
  const chartSeries = useMemo(() => [{ name: `${base}/${quote}`, data: rateSeries, area: true }], [rateSeries, base, quote]);
  const pctFmt = useCallback((v: number, axis?: boolean) => formatPct(v, f.locale, { decimals: axis ? 0 : 2, signed: !axis }), [f.locale]);

  const exposure = a?.allocations.currency ?? [];
  const table = useMemo(() => {
    const now = asOf;
    const ago = addDays(now, -365);
    return [...new Set(exposure.map((s) => s.key))]
      .filter((c) => c !== f.currency)
      .map((c) => ({
        ccy: c,
        rate: market?.fx(c, f.currency, now),
        change: market && market.fx(c, f.currency, ago) ? (market.fx(c, f.currency, now) ?? 0) / market.fx(c, f.currency, ago)! - 1 : undefined,
      }));
  }, [exposure, market, asOf, f.currency]);

  return (
    <div>
      <PageHeader title={t('fx.title')} subtitle={t('fx.subtitle', { currency: f.currency })} />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Kpi loading={loading} label={t('fx.unrealized')} value={<Money value={unrealized} signed />} sub={<span className="text-xs text-muted">{t('fx.unrealizedSub')}</span>} />
        <Kpi loading={loading} label={t('fx.fromPrice')} value={<Money value={priceGain} signed />} sub={<span className="text-xs text-muted">{t('fx.fromPriceSub')}</span>} />
        <Kpi loading={loading} label={t('fx.fromFx')} value={<Money value={fxGain} signed />} sub={<span className="text-xs text-muted">{t('fx.fromFxSub')}</span>} />
        <Kpi
          loading={loading}
          label={t('fx.cumulativeSplit')}
          value={<Pct value={(1 + cumLocal) * (1 + cumFx) - 1} signed colored />}
          sub={
            <span className="text-xs text-muted num" data-testid="fx-composition">
              (1 {formatPct(cumLocal, f.locale, { signed: true })}) × (1 {formatPct(cumFx, f.locale, { signed: true })}) − 1
            </span>
          }
          hint={t('fx.cumulativeSplitSub')}
        />
      </div>

      <Waterfall />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 mt-3">
        <Card title={t('fx.exposure')} subtitle={t('fx.exposureSub')}>
          {loading ? <Skeleton className="h-44" /> : <AllocationDonut slices={exposure} labelFor={sliceLabel} />}
          {table.length > 0 && (
            <table className="table mt-3">
              <thead>
                <tr>
                  <th>{t('dim.currency')}</th>
                  <th className="r">{t('fx.rateIn', { currency: f.currency })}</th>
                  <th className="r">{t('fx.change1y')}</th>
                </tr>
              </thead>
              <tbody>
                {table.map((r) => (
                  <tr key={r.ccy}>
                    <td className="font-medium">{r.ccy}</td>
                    <td className="r num">{formatFxRate(r.rate, f.locale)}</td>
                    <td className="r">
                      <Pct value={r.change} signed colored />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          className="xl:col-span-2"
          title={t('fx.history')}
          subtitle={
            last !== undefined ? (
              <span className="flex items-center gap-2 flex-wrap">
                <span className="num font-semibold text-ink">
                  1 {base} = {formatFxRate(last, f.locale)} {quote}
                </span>
                {first ? <Delta pct={last / first - 1} size="sm" /> : null}
              </span>
            ) : undefined
          }
          actions={
            <>
              <label className="sr-only" htmlFor="fx-pair">
                {t('fx.pair')}
              </label>
              <select id="fx-pair" className="select !w-auto !h-8" value={pair} onChange={(e) => setPair(Number(e.target.value))}>
                {FX_PAIRS.map(([b, q], i) => (
                  <option key={i} value={i}>
                    {b}/{q}
                  </option>
                ))}
              </select>
              <Segmented
                label={t('common.period')}
                value={period}
                onChange={setPeriod}
                options={(['YTD', '1Y', '3Y', 'ALL'] as const).map((p) => ({ value: p, label: t(`period.${p}`) }))}
              />
            </>
          }
        >
          {rateSeries.length > 1 ? (
            <LineChart series={chartSeries} valueFormat={fxFmt} ariaLabel={t('fx.historyAria', { pair: `${base}/${quote}` })} height={280} />
          ) : (
            <p className="text-sm text-muted text-center py-16">{t('fx.noRates')}</p>
          )}
          <SourcesLine rows={fxRows ?? []} />
        </Card>
      </div>

      <Card className="mt-3" title={t('fx.yearly')} subtitle={t('fx.yearlySub', { currency: f.currency })}>
        {yearly.years.length ? (
          <GroupedBars categories={yearly.years} series={yearly.series} valueFormat={pctFmt} ariaLabel={t('fx.yearlyAria')} height={240} />
        ) : (
          <p className="text-sm text-muted text-center py-10">{t('common.noData')}</p>
        )}
        <p className="text-xs text-muted mt-2">{t('fx.explain', { currency: f.currency })}</p>
      </Card>
    </div>
  );
}

function SourcesLine({ rows }: { rows: { pair: string; source: string; updatedAt: number; isDemo?: boolean }[] }) {
  const { t } = useTranslation();
  const { locale } = useFmt();
  if (!rows.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-3">
      {rows.map((r) => (
        <span key={r.pair} className="chip" title={t('fx.sourceHint')}>
          {r.pair} · {r.isDemo ? t('demo.badge') : t(`source.${r.source}`, { defaultValue: r.source })} · {formatRelative(r.updatedAt, locale)}
        </span>
      ))}
    </div>
  );
}

/** Money waterfall since inception: contributions → price effect → FX effect → income → end (W14). */
function Waterfall() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a } = useAnalysis();
  const si = a?.summaries.SI;
  if (!si || si.priceGainBase === undefined || si.fxGainBase === undefined) return null;
  const other = si.gainBase - si.priceGainBase - si.fxGainBase - si.incomeBase;
  const steps: { key: string; value: number; total?: boolean }[] = [
    { key: 'start', value: si.startValueBase, total: true },
    { key: 'flows', value: si.netFlowsBase },
    { key: 'price', value: si.priceGainBase },
    { key: 'fx', value: si.fxGainBase },
    { key: 'income', value: si.incomeBase },
    { key: 'other', value: other },
    { key: 'end', value: si.endValueBase, total: true },
  ];
  const max = Math.max(...steps.map((s) => Math.abs(s.value)), 1);
  let running = 0;
  return (
    <Card className="mt-3" title={t('fx.waterfall')} subtitle={t('fx.waterfallSub', { currency: f.currency })}>
      <ul className="flex flex-col gap-1.5 text-[13px]" data-testid="fx-waterfall">
        {steps.map((s) => {
          const from = s.total ? 0 : running;
          const to = s.total ? s.value : running + s.value;
          if (!s.total) running = to;
          else running = s.value;
          const left = (Math.min(from, to) / max) * 100;
          const width = Math.max((Math.abs(to - from) / max) * 100, 0.4);
          const color = s.total ? 'var(--series-1)' : s.value >= 0 ? 'var(--pos)' : 'var(--neg)';
          return (
            <li key={s.key} className="grid grid-cols-[140px_1fr_150px] items-center gap-3">
              <span className="text-ink-2 truncate">{t(`fx.step.${s.key}`)}</span>
              <span className="relative h-5 rounded bg-surface-2 overflow-hidden" aria-hidden>
                <span className="absolute inset-y-0 rounded print-heat" style={{ left: `${Math.max(0, left)}%`, width: `${Math.min(100, width)}%`, background: color }} />
              </span>
              <Money value={s.value} signed={!s.total} className={s.total ? 'font-semibold text-right' : 'text-right'} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
