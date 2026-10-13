/**
 * The only module that imports ECharts. Loaded lazily by <Chart> (W20): the Resumen paints its KPIs
 * without waiting for the charting library, and only the chart types/components actually used are
 * registered (line, bar, pie; grid, tooltip, legend; canvas).
 */
import ReactEChartsCoreModule from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

// The package ships CJS (`lib`) with `exports.default`; unwrap it for every bundler/interop mode.
const ReactEChartsCore = ((ReactEChartsCoreModule as unknown as { default?: typeof ReactEChartsCoreModule }).default ??
  ReactEChartsCoreModule) as typeof ReactEChartsCoreModule;

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export default function EChartsView({
  option,
  height,
  onEvents,
}: {
  option: EChartsOption;
  height: number | string;
  onEvents?: Record<string, (params: unknown) => void>;
}) {
  return (
    <ReactEChartsCore
      echarts={echarts}
      option={option}
      notMerge
      lazyUpdate
      style={{ height, width: '100%' }}
      opts={{ renderer: 'canvas' }}
      onEvents={onEvents}
    />
  );
}
