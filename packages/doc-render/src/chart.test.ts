import { describe, expect, it } from 'vitest'

import { chartSvg } from './chart.ts'

// The charts of «Отчёт» drawn on the server (docs/plan/88-artifacts.md, 88.28).

describe('a chart of a report', () => {
  it('draws bars into an SVG with the labels and the unit in Russian', () => {
    const { svg, width, height } = chartSvg({
      type: 'bar',
      title: 'Выручка по месяцам',
      categories: ['Сентябрь', 'Октябрь', 'Ноябрь'],
      series: [{ name: 'Выручка', values: [120000, 135500.5, 98000] }],
      unit: '₽',
    })
    expect([width, height]).toEqual([720, 360])
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('Выручка по месяцам')
    expect(svg).toContain('Октябрь')
    expect(svg).toMatch(/₽/)
  })

  it('draws a pie and lines, and escapes the text of the client', () => {
    const pie = chartSvg({
      type: 'pie',
      categories: ['Сайт', '<script>x</script>'],
      series: [{ name: 'Заявки', values: [60, 40] }],
    }).svg
    expect(pie).not.toContain('<script>')
    expect(pie).toContain('Сайт')
    const lines = chartSvg({
      type: 'line',
      categories: ['Пн', 'Вт'],
      series: [
        { name: 'Звонки', values: [3, 5] },
        { name: 'Заявки', values: [1, 2] },
      ],
    }).svg
    expect(lines).toContain('Звонки')
  })
})
