import { useEffect, useMemo, useState } from 'react';
import ReactEChartsCoreModule from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { useTheme } from '../hooks/useTheme';

// The package ships CJS (`lib`) with `exports.default`; unwrap it for every bundler/interop mode.
const ReactEChartsCore = ((ReactEChartsCoreModule as unknown as { default?: typeof ReactEChartsCoreModule }).default ??
  ReactEChartsCoreModule) as typeof ReactEChartsCoreModule;

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export interface ChartTokens {
  text: string;
  text2: string;
  muted: string;
  grid: string;
  axis: string;
  surface: string;
  surface2: string;
  border: string;
  accent: string;
  pos: string;
  neg: string;
  series: string[];
}

export function readTokens(): ChartTokens {
  const cs = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : undefined;
  const v = (name: string, fallback: string) => (cs?.getPropertyValue(name).trim() || fallback);
  return {
    text: v('--text', '#0e1525'),
    text2: v('--text-2', '#4a5468'),
    muted: v('--muted', '#7a8396'),
    grid: v('--grid', '#eceef2'),
    axis: v('--axis', '#c3c8d1'),
    surface: v('--surface', '#ffffff'),
    surface2: v('--surface-2', '#f2f4f7'),
    border: v('--border', '#e3e6eb'),
    accent: v('--accent', '#0f766e'),
    pos: v('--pos', '#047857'),
    neg: v('--neg', '#c2312f'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`, '#888')),
  };
}

/** Base option shared by every chart: recessive axes, hairline grid, readable tooltip. */
export function baseOption(t: ChartTokens): EChartsOption {
  return {
    animationDuration: 350,
    textStyle: { fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', color: t.text2 },
    grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: 1,
      textStyle: { color: t.text, fontSize: 12 },
      extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,.12); border-radius: 8px;',
    },
  };
}

export function Chart({
  option,
  height = 280,
  ariaLabel,
  className,
  onEvents,
}: {
  option: (t: ChartTokens) => EChartsOption;
  height?: number | string;
  ariaLabel: string;
  className?: string;
  onEvents?: Record<string, (params: unknown) => void>;
}) {
  const { resolved } = useTheme();
  const [tokens, setTokens] = useState(readTokens);
  useEffect(() => setTokens(readTokens()), [resolved]);
  const opt = useMemo(() => option(tokens), [option, tokens]);
  return (
    <div role="img" aria-label={ariaLabel} className={className}>
      <ReactEChartsCore
        echarts={echarts}
        option={opt}
        notMerge
        lazyUpdate
        style={{ height, width: '100%' }}
        opts={{ renderer: 'canvas' }}
        onEvents={onEvents}
      />
    </div>
  );
}
