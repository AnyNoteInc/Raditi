import { tableCellPlain, type ArtifactColumn, type TableRow } from '@repo/domain/artifacts'
import writeXlsxFile, { type Row, type SheetData } from 'write-excel-file/node'

/**
 * The workbook of a table (docs/plan/88-artifacts.md, §7.13, question 26): one sheet, the names of
 * the columns in bold as its first row, which stays in place. A sum is a number with two decimals
 * — the one place a sum in roubles becomes a binary number (rule 9's exception, §7.13): Excel keeps
 * numbers as doubles, exact for two decimals up to 99 999 999,99. A day is a date of Excel; a flag
 * is «да» or «нет»; a picture is not in the workbook.
 */

/** Excel's own width of a column in characters, from the kind of the column. */
const widthOf = (column: ArtifactColumn): number => {
  switch (column.type) {
    case 'money':
    case 'number':
    case 'date':
      return 14
    case 'checkbox':
      return 10
    case 'link':
      return 40
    default:
      return 28
  }
}

export function workbookSheet(
  columns: readonly ArtifactColumn[],
  rows: readonly Pick<TableRow, 'cells'>[],
): SheetData {
  const shown = columns.filter((column) => column.type !== 'image')
  const header: Row = shown.map((column) => ({ value: column.name, fontWeight: 'bold' as const }))
  const body = rows.map((row): Row =>
    shown.map((column) => {
      const value = row.cells[column.key]
      if (value === null || value === undefined || value === '')
        return column.type === 'checkbox' ? { value: 'нет', type: String } : null
      switch (column.type) {
        case 'money':
          return typeof value === 'string'
            ? { value: Number(value), type: Number, format: '#,##0.00' }
            : null
        case 'number':
          return typeof value === 'number' ? { value, type: Number } : null
        case 'date':
          return typeof value === 'string'
            ? { value: new Date(`${value}T00:00:00Z`), type: Date, format: 'dd.mm.yyyy' }
            : null
        default:
          // Text as text: a formula is never written as one (`type: String`).
          return { value: tableCellPlain(column, value), type: String }
      }
    }),
  )
  return [header, ...body]
}

/** The bytes of the workbook. */
export async function workbookBytes(input: {
  title: string
  columns: readonly ArtifactColumn[]
  rows: readonly Pick<TableRow, 'cells'>[]
}): Promise<Uint8Array> {
  const shown = input.columns.filter((column) => column.type !== 'image')
  // A sheet's name: up to 31 characters, none of []:*?/\ (Excel).
  const sheet =
    input.title
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || 'Таблица'
  const buffer = await writeXlsxFile(workbookSheet(input.columns, input.rows), {
    sheet,
    stickyRowsCount: 1,
    columns: shown.map((column) => ({ width: widthOf(column) })),
  }).toBuffer()
  return new Uint8Array(buffer)
}
