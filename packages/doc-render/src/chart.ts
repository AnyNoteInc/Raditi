import { artifactChartLimits, type ArtifactChartSpec } from '@repo/domain/artifacts'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'

// The charts of «Отчёт» (docs/plan/88-artifacts.md, §7.13, slice 88.28): the narrow spec of a chart
// drawn into an SVG on the server by ECharts (`renderToSVGString`, no DOM). The text of the spec
// becomes text of the SVG, escaped by ECharts; the picture is shown as `<img>`, so nothing in it
// runs. Server only: the cabinet never loads ECharts.

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  SVGRenderer,
])

/** A palette that reads on white and in print: the first is the brand's primary by default. */
const PALETTE = [
  '#2f5d50',
  '#e07a3f',
  '#4a7fb5',
  '#c9a227',
  '#8a5a9e',
  '#5b8c3a',
  '#b5484a',
  '#6b706c',
]
const FONT = 'Arial, "Liberation Sans", sans-serif'

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })

export interface ChartPicture {
  svg: string
  width: number
  height: number
}

/** The SVG of a chart, 720×360 unless asked otherwise. */
export function chartSvg(
  spec: ArtifactChartSpec,
  size: { width: number; height: number } = {
    width: artifactChartLimits.width,
    height: artifactChartLimits.height,
  },
): ChartPicture {
  const chart = echarts.init(null, null, {
    renderer: 'svg',
    ssr: true,
    width: size.width,
    height: size.height,
  })
  try {
    const unit = spec.unit ? ` ${spec.unit}` : ''
    const format = (value: number) => `${number.format(value)}${unit}`
    const titled = spec.title !== undefined
    chart.setOption({
      animation: false,
      color: PALETTE,
      textStyle: { fontFamily: FONT, color: '#1f2421' },
      ...(titled
        ? { title: { text: spec.title, left: 'center', top: 8, textStyle: { fontSize: 16 } } }
        : {}),
      ...(spec.series.length > 1 || spec.type === 'pie'
        ? { legend: { bottom: 4, type: 'plain' } }
        : {}),
      ...(spec.type === 'pie'
        ? {
            series: [
              {
                type: 'pie',
                radius: ['0%', '62%'],
                center: ['50%', titled ? '54%' : '48%'],
                label: {
                  formatter: (item: { name: string; value: number }) =>
                    `${item.name}: ${format(item.value)}`,
                },
                data: spec.categories.map((name, at) => ({
                  name,
                  value: spec.series[0]!.values[at],
                })),
              },
            ],
          }
        : {
            grid: {
              left: 64,
              right: 24,
              top: titled ? 48 : 24,
              bottom: spec.series.length > 1 ? 56 : 32,
            },
            xAxis: {
              type: 'category',
              data: spec.categories,
              axisLabel: { interval: 0, hideOverlap: true },
            },
            yAxis: { type: 'value', axisLabel: { formatter: format } },
            series: spec.series.map((series) => ({
              type: spec.type,
              name: series.name,
              data: series.values,
              ...(spec.stacked && spec.type === 'bar' ? { stack: 'all' } : {}),
            })),
          }),
    })
    return { svg: chart.renderToSVGString(), width: size.width, height: size.height }
  } finally {
    chart.dispose()
  }
}
