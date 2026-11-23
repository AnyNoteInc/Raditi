import { describe, expect, it } from 'vitest'

import { reportPage } from './reading-page.ts'
import { chartDataUrl, reportPartsOf } from './report.ts'

// The page of «Отчёт» for its publication and its PDF (docs/plan/88-artifacts.md, 88.28, 88.32).

const chart = JSON.stringify({
  type: 'line',
  categories: ['Октябрь', 'Ноябрь'],
  series: [{ name: 'Заказы', values: [10, 14] }],
})

describe('the page of a report', () => {
  it('keeps the order of the blocks, leaves a broken chart out and draws the table once', () => {
    const parts = reportPartsOf(
      [
        { key: 's', kind: 'section', content: 'Текст', props: { heading: 'Итоги' } },
        { key: 'c', kind: 'chart', content: chart },
        { key: 'x', kind: 'chart', content: '{"type":"radar"}' },
        {
          key: 'cols',
          kind: 'columns',
          content: JSON.stringify([{ key: 'm', name: 'Месяц', type: 'text' }]),
        },
        { key: 'r', kind: 'row', content: JSON.stringify({ m: 'Ноябрь' }) },
      ],
      chartDataUrl,
    )
    expect(parts.map((part) => part.kind)).toEqual(['section', 'picture', 'table'])
    expect(parts[0]).toEqual({ kind: 'section', heading: 'Итоги', markdown: 'Текст' })
    expect(parts[1]).toMatchObject({ src: expect.stringMatching(/^data:image\/svg\+xml;base64,/) })
    expect(parts[2]).toEqual({ kind: 'table', head: ['Месяц'], rows: [['Ноябрь']] })
  })

  it('carries the print style only for a print', async () => {
    const parts = [{ kind: 'section' as const, heading: null, markdown: 'Текст' }]
    expect(await reportPage({ title: 'Отчёт', parts, print: true })).toContain("'Golos Text'")
    expect(await reportPage({ title: 'Отчёт', parts })).not.toContain("'Golos Text'")
  })
})
