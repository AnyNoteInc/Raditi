import { COLUMNS, plainCell, type PriceRow } from './model'

/**
 * A text cell that starts with «=», «+», «-», «@», a tab or a line break is a formula for Excel
 * and Google Sheets. Agents and other people write these cells, so CSV gets a leading apostrophe
 * (the OWASP advice for CSV injection). XLSX needs nothing: `write-excel-file` writes strings as
 * strings.
 */
export function neutralize(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell
}

function csvQuote(cell: string): string {
  return /[;"\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
}

/**
 * CSV for Excel with a Russian locale: «;» between cells (a comma there is the decimal mark),
 * a byte order mark so that Excel reads UTF-8, CRLF between lines, prices as «1234,50».
 */
export function toCsv(rows: PriceRow[]): string {
  const lines = [COLUMNS.map((c) => csvQuote(c.label)).join(';')]
  for (const row of rows) {
    lines.push(
      COLUMNS.map((c) => {
        const text = plainCell(c, row)
        return csvQuote(c.kind === 'text' || c.kind === 'select' ? neutralize(text) : text)
      }).join(';'),
    )
  }
  return `﻿${lines.join('\r\n')}\r\n`
}

export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function downloadCsv(rows: PriceRow[], title: string): void {
  download(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), `${title}.csv`)
}

/** Excel: loaded only when asked for, so its code is not part of the table. */
export async function downloadXlsx(rows: PriceRow[], title: string): Promise<number> {
  const t0 = performance.now()
  const { default: writeExcelFile } = await import('write-excel-file/browser')
  const header = COLUMNS.map((c) => ({ value: c.label, fontWeight: 'bold' as const }))
  const body = rows.map((row) =>
    COLUMNS.map((c) => {
      if (c.kind === 'money') {
        // The only place where a price becomes a binary number: Excel keeps numbers as doubles.
        return row.price === '' ? null : { value: Number(row.price), type: Number, format: '#,##0.00' }
      }
      return { value: plainCell(c, row), type: String }
    }),
  )
  await writeExcelFile([header, ...body], {
    sheet: 'Прайс-лист',
    stickyRowsCount: 1,
    columns: COLUMNS.map((c) => ({ width: Math.round(c.width / 7) })),
  }).toFile(`${title}.xlsx`)
  return performance.now() - t0
}
