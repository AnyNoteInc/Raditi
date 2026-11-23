import { Buffer } from 'node:buffer'

import { artifactChartOf, tableCellText, tableOfBlocks } from '@repo/domain/artifacts'

import { chartSvg, type ChartPicture } from './chart.ts'
import type { ReportPagePart } from './reading-page.ts'

// The parts of the page of «Отчёт» (docs/plan/88-artifacts.md, §7.10, §7.13; 88.28, 88.32): its
// sections, its charts drawn on the server, its table, in the order of the blocks — one builder for
// the publication (the charts are files of the site) and for «Скачать PDF» (the charts inline).

export interface ReportSourceBlock {
  key: string
  kind: string
  content: string | null
  props?: Readonly<Record<string, unknown>> | null
}

/**
 * The parts of a report of its top blocks, in their order. `picture` names where a drawn chart is
 * read from; a chart whose spec does not parse is left out of the page rather than shown broken.
 */
export function reportPartsOf(
  blocks: readonly ReportSourceBlock[],
  picture: (chart: ChartPicture) => string,
): ReportPagePart[] {
  const table = tableOfBlocks(
    blocks.flatMap((block) =>
      block.kind === 'columns' || block.kind === 'row'
        ? [{ key: block.key, kind: block.kind, rev: 0, content: block.content }]
        : [],
    ),
  )
  const parts: ReportPagePart[] = []
  for (const block of blocks) {
    if (block.kind === 'section') {
      const heading = block.props?.heading
      parts.push({
        kind: 'section',
        heading: typeof heading === 'string' && heading.trim() !== '' ? heading : null,
        markdown: block.content ?? '',
      })
    } else if (block.kind === 'chart') {
      const chart = artifactChartOf(block.content)
      if (!chart.ok) continue
      const drawn = chartSvg(chart.spec)
      parts.push({ kind: 'picture', src: picture(drawn), width: drawn.width, height: drawn.height })
    } else if (block.kind === 'columns' && table.columns.length > 0) {
      parts.push({
        kind: 'table',
        head: table.columns.map((column) => column.name),
        rows: table.rows.map((row) =>
          table.columns.map((column) => tableCellText(column, row.cells[column.key])),
        ),
      })
    }
  }
  return parts
}

/** A drawn chart as a `data:` address: the page of a print loads nothing from anywhere. */
export function chartDataUrl(chart: ChartPicture): string {
  return `data:image/svg+xml;base64,${Buffer.from(chart.svg, 'utf8').toString('base64')}`
}
