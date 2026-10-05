import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { EChartsOption } from 'echarts';
import type { AllocationSlice } from '@pm/core';
import { baseOption, Chart, type ChartTokens } from './Chart';
import { formatDate, formatMoney, formatMonth, formatPct, MASK } from '../lib/format';
import { useFmt } from '../store/app';
import type { SeriesPoint } from '../services/analysis';

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function axisCommon(t: ChartTokens) {
  return {
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: t.grid } },
  };
}

// ---------------------------------------------------------------------------
// Value vs invested
// ---------------------------------------------------------------------------

export function ValueChart({ data, height = 300 }: { data: SeriesPoint[]; height?: number }) {
  const { t } = useTranslation();
  const f = useFmt();
  const option = useCallback(
    (tk: ChartTokens): EChartsOption => {
      const money = (v: number, compact = false) => formatMoney(v, f.currency, f.locale, { compact, privacy: f.privacy });
      return {
        ...baseOption(tk),
        grid: { left: 8, right: 16, top: 28, bottom: 4, containLabel: true },
        legend: {
          top: 0,
          right: 0,
          itemWidth: 14,
          itemHeight: 3,
          icon: 'rect',
          textStyle: { color: tk.text2, fontSize: 12 },
          data: [t('chart.value'), t('chart.invested')],
        },
        tooltip: {
          ...(baseOption(tk).tooltip as object),
          trigger: 'axis',
          axisPointer: { type: 'line', lineStyle: { color: tk.axis } },
          formatter: (params: unknown) => {
            const ps = params as { axisValue: string; seriesName: string; value: [string, number]; color: string }[];
            const d = ps[0]?.value[0];
            const rows = ps
              .map(
                (p) =>
                  `<div style="display:flex;gap:12px;justify-content:space-between"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color};margin-right:6px"></span>${p.seriesName}</span><b style="font-variant-numeric:tabular-nums">${money(p.value[1])}</b></div>`,
              )
              .join('');
            const v = ps.find((p) => p.seriesName === t('chart.value'))?.value[1] ?? 0;
            const inv = ps.find((p) => p.seriesName === t('chart.invested'))?.value[1] ?? 0;
            const gain = v - inv;
            return `<div style="min-width:200px"><div style="color:${tk.muted};margin-bottom:4px">${formatDate(d, f.locale)}</div>${rows}<div style="display:flex;justify-content:space-between;margin-top:4px;padding-top:4px;border-top:1px solid ${tk.border}"><span>${t('chart.gain')}</span><b style="color:${gain >= 0 ? tk.pos : tk.neg}">${f.privacy ? MASK : formatMoney(gain, f.currency, f.locale, { signed: true })}</b></div></div>`;
          },
        },
        xAxis: { type: 'time', ...axisCommon(tk), splitLine: { show: false }, axisLabel: { color: tk.muted, fontSize: 11, hideOverlap: true } },
        yAxis: {
          type: 'value',
          scale: true,
          ...axisCommon(tk),
          axisLine: { show: false },
          axisLabel: { color: tk.muted, fontSize: 11, formatter: (v: number) => (f.privacy ? '' : money(v, true)) },
        },
        series: [
          {
            name: t('chart.value'),
            type: 'line',
            showSymbol: false,
            symbolSize: 8,
            data: data.map((p) => [p.date, p.valueBase]),
            lineStyle: { width: 2, color: tk.series[0] },
            itemStyle: { color: tk.series[0] },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: hexA(tk.series[0]!, 0.18) },
                  { offset: 1, color: hexA(tk.series[0]!, 0.0) },
                ],
              },
            },
          },
          {
            name: t('chart.invested'),
            type: 'line',
            step: 'end',
            showSymbol: false,
            data: data.map((p) => [p.date, p.netInvestedBase]),
            lineStyle: { width: 1.5, color: tk.muted },
            itemStyle: { color: tk.muted },
          },
        ],
      };
    },
    [data, f.currency, f.locale, f.privacy, t],
  );
  return <Chart option={option} height={height} ariaLabel={t('chart.valueAria')} />;
}

// ---------------------------------------------------------------------------
// Allocation donut (≤6 segments + "Otros", legend as an HTML list beside it)
// ---------------------------------------------------------------------------

export function foldSlices(slices: AllocationSlice[], max = 6, otherLabel = 'Otros'): AllocationSlice[] {
  const sorted = [...slices].filter((s) => s.valueBase > 0).sort((a, b) => b.valueBase - a.valueBase);
  if (sorted.length <= max) return sorted;
  const head = sorted.slice(0, max - 1);
  const tail = sorted.slice(max - 1);
  return [
    ...head,
    {
      key: '__other',
      label: otherLabel,
      valueBase: tail.reduce((s, x) => s + x.valueBase, 0),
      weight: tail.reduce((s, x) => s + x.weight, 0),
    },
  ];
}

export function AllocationDonut({ slices, labelFor }: { slices: AllocationSlice[]; labelFor?: (s: AllocationSlice) => string }) {
  const { t } = useTranslation();
  const f = useFmt();
  const folded = foldSlices(slices, 6, t('common.other'));
  const option = useCallback(
    (tk: ChartTokens): EChartsOption => ({
      ...baseOption(tk),
      tooltip: {
        ...(baseOption(tk).tooltip as object),
        trigger: 'item',
        formatter: (p: unknown) => {
          const x = p as { name: string; value: number; percent: number };
          return `${x.name}<br/><b>${formatMoney(x.value, f.currency, f.locale, { privacy: f.privacy })}</b> · ${formatPct(x.percent / 100, f.locale, { decimals: 1 })}`;
        },
      },
      series: [
        {
          type: 'pie',
          radius: ['62%', '90%'],
          avoidLabelOverlap: true,
          label: { show: false },
          itemStyle: { borderColor: tk.surface, borderWidth: 2, borderRadius: 3 },
          emphasis: { scale: true, scaleSize: 4 },
          data: folded.map((s, i) => ({
            name: labelFor ? labelFor(s) : s.label,
            value: s.valueBase,
            itemStyle: { color: s.key === '__other' ? tk.series[7] : tk.series[i] },
          })),
        },
      ],
    }),
    [folded, f.currency, f.locale, f.privacy, labelFor],
  );
  if (!folded.length) return <p className="text-sm text-muted py-8 text-center">{t('common.noData')}</p>;
  return (
    <div className="flex items-center gap-4 flex-wrap sm:flex-nowrap">
      <Chart option={option} height={170} ariaLabel={t('chart.allocationAria')} className="w-[170px] shrink-0 mx-auto" />
      <ul className="flex-1 min-w-[160px] flex flex-col gap-1.5 text-[13px]">
        {folded.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2 min-w-0">
            <span
              className="size-2.5 rounded-[3px] shrink-0"
              style={{ background: s.key === '__other' ? 'var(--series-8)' : `var(--series-${i + 1})` }}
              aria-hidden
            />
            <span className="truncate text-ink-2 flex-1">{labelFor ? labelFor(s) : s.label}</span>
            <span className="num font-medium text-ink">{formatPct(s.weight, f.locale, { decimals: 1 })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monthly return bars
// ---------------------------------------------------------------------------

export function ReturnBars({
  data,
  height = 220,
  benchmark,
}: {
  data: { month: string; twr: number; bench?: number }[];
  height?: number;
  benchmark?: string;
}) {
  const { t } = useTranslation();
  const f = useFmt();
  const option = useCallback(
    (tk: ChartTokens): EChartsOption => ({
      ...baseOption(tk),
      grid: { left: 4, right: 8, top: benchmark ? 28 : 12, bottom: 4, containLabel: true },
      legend: benchmark
        ? { top: 0, right: 0, itemWidth: 12, itemHeight: 8, textStyle: { color: tk.text2, fontSize: 12 } }
        : undefined,
      tooltip: {
        ...(baseOption(tk).tooltip as object),
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: hexA(tk.muted, 0.08) } },
        valueFormatter: (v: unknown) => formatPct(v as number, f.locale, { signed: true }),
      },
      xAxis: {
        type: 'category',
        data: data.map((d) => formatMonth(d.month, f.locale)),
        ...axisCommon(tk),
        splitLine: { show: false },
        axisLabel: { color: tk.muted, fontSize: 11, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        ...axisCommon(tk),
        axisLine: { show: false },
        axisLabel: { color: tk.muted, fontSize: 11, formatter: (v: number) => formatPct(v, f.locale, { decimals: 0 }) },
      },
      series: [
        {
          name: t('chart.portfolio'),
          type: 'bar',
          barMaxWidth: 18,
          // Bars are coloured per value (sign); the legend swatch stays neutral.
          itemStyle: { color: tk.text2 },
          data: data.map((d) => ({
            value: d.twr,
            itemStyle: { color: d.twr >= 0 ? tk.pos : tk.neg, borderRadius: d.twr >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] },
          })),
        },
        ...(benchmark
          ? [
              {
                name: benchmark,
                type: 'line' as const,
                showSymbol: true,
                symbolSize: 5,
                lineStyle: { width: 0 },
                itemStyle: { color: tk.text2 },
                data: data.map((d) => d.bench ?? null),
              },
            ]
          : []),
      ],
    }),
    [data, f.locale, benchmark, t],
  );
  return <Chart option={option} height={height} ariaLabel={t('chart.returnsAria')} />;
}

// ---------------------------------------------------------------------------
// Generic multi-line chart (cumulative returns, FX rates, drawdown)
// ---------------------------------------------------------------------------

export interface LineSeries {
  name: string;
  data: [string, number][];
  colorIndex?: number;
  area?: boolean;
  dashed?: boolean;
  /** Use the negative token (drawdown). */
  tone?: 'neg';
}

export function LineChart({
  series,
  height = 280,
  valueFormat,
  ariaLabel,
  scale = true,
}: {
  series: LineSeries[];
  height?: number;
  valueFormat: (v: number, axis?: boolean) => string;
  ariaLabel: string;
  scale?: boolean;
}) {
  const f = useFmt();
  const option = useCallback(
    (tk: ChartTokens): EChartsOption => ({
      ...baseOption(tk),
      grid: { left: 8, right: 16, top: series.length > 1 ? 30 : 14, bottom: 4, containLabel: true },
      legend:
        series.length > 1
          ? { top: 0, right: 0, itemWidth: 14, itemHeight: 3, icon: 'rect', textStyle: { color: tk.text2, fontSize: 12 } }
          : undefined,
      tooltip: {
        ...(baseOption(tk).tooltip as object),
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: tk.axis } },
        valueFormatter: (v: unknown) => valueFormat(v as number),
      },
      xAxis: { type: 'time', ...axisCommon(tk), splitLine: { show: false }, axisLabel: { color: tk.muted, fontSize: 11, hideOverlap: true } },
      yAxis: {
        type: 'value',
        scale,
        ...axisCommon(tk),
        axisLine: { show: false },
        axisLabel: { color: tk.muted, fontSize: 11, formatter: (v: number) => valueFormat(v, true) },
      },
      series: series.map((s, i) => {
        const color = s.tone === 'neg' ? tk.neg : tk.series[s.colorIndex ?? i] ?? tk.text2;
        return {
          name: s.name,
          type: 'line' as const,
          showSymbol: false,
          symbolSize: 8,
          data: s.data,
          lineStyle: { width: i === 0 ? 2 : 1.5, color, type: s.dashed ? ('dotted' as const) : ('solid' as const) },
          itemStyle: { color },
          areaStyle: s.area ? { color: hexA(color, 0.14) } : undefined,
        };
      }),
    }),
    [series, valueFormat, scale],
  );
  void f;
  return <Chart option={option} height={height} ariaLabel={ariaLabel} />;
}

// ---------------------------------------------------------------------------
// Stacked monthly bars (dividends per month, by year)
// ---------------------------------------------------------------------------

export function GroupedBars({
  categories,
  series,
  height = 260,
  valueFormat,
  ariaLabel,
  stacked,
}: {
  categories: string[];
  series: { name: string; data: number[]; colorIndex?: number }[];
  height?: number;
  valueFormat: (v: number, axis?: boolean) => string;
  ariaLabel: string;
  stacked?: boolean;
}) {
  const option = useCallback(
    (tk: ChartTokens): EChartsOption => ({
      ...baseOption(tk),
      grid: { left: 4, right: 8, top: series.length > 1 ? 30 : 12, bottom: 4, containLabel: true },
      legend:
        series.length > 1
          ? { top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: tk.text2, fontSize: 12 } }
          : undefined,
      tooltip: {
        ...(baseOption(tk).tooltip as object),
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: hexA(tk.muted, 0.08) } },
        valueFormatter: (v: unknown) => valueFormat(v as number),
      },
      xAxis: { type: 'category', data: categories, ...axisCommon(tk), splitLine: { show: false } },
      yAxis: {
        type: 'value',
        ...axisCommon(tk),
        axisLine: { show: false },
        axisLabel: { color: tk.muted, fontSize: 11, formatter: (v: number) => valueFormat(v, true) },
      },
      series: series.map((s, i) => ({
        name: s.name,
        type: 'bar' as const,
        stack: stacked ? 'total' : undefined,
        barMaxWidth: 22,
        barGap: '15%',
        data: s.data,
        itemStyle: { color: tk.series[s.colorIndex ?? i], borderRadius: stacked ? 0 : [3, 3, 0, 0], borderColor: tk.surface, borderWidth: stacked ? 1 : 0 },
      })),
    }),
    [categories, series, valueFormat, stacked],
  );
  return <Chart option={option} height={height} ariaLabel={ariaLabel} />;
}
