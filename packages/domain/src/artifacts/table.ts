import { Decimal } from 'decimal.js'

import {
  artifactCellProblem,
  artifactCellsSchema,
  artifactColumnsSchema,
  type ArtifactCell,
  type ArtifactCells,
  type ArtifactColumn,
} from './blocks.ts'
import { artifactLimits } from './limits.ts'

/**
 * The rules of a table (docs/plan/88-artifacts.md, §7.7 «Таблица», spike 5): what a person typed
 * or pasted becomes the value of a cell of its column, how a value reads on the screen, in the
 * clipboard and in CSV, where a block pasted from Excel or Google Sheets goes, the order of rows
 * the cabinet keeps, and the totals of number and money columns. One module for the cabinet and
 * the server: the totals are the server's (rule 9 — Decimal, never a float), the cabinet reads
 * the same rules for its own cells.
 */

const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

/** A row of a table as the cabinet and the server read it: its block key, revision and cells. */
export interface TableRow {
  key: string
  rev: number
  cells: ArtifactCells
}

export type TableCellParsed = { ok: true; value: ArtifactCell } | { ok: false; reason: string }

/** Words of a table for the client (rule 10). */
export const tableReasons = Object.freeze({
  number: 'Введите число, например 12 или 3,5',
  money: 'Введите сумму, например 1 250,50',
  moneyFraction: 'Не больше двух знаков после запятой',
  moneyLarge: 'Слишком большая сумма',
  date: 'Введите дату, например 12.11.2026',
  flag: 'Ожидается «да» или «нет»',
  link: 'Нужен адрес, который начинается с https://',
  image: 'Картинку добавляют загрузкой, а не текстом',
  option: (word: string) => `Нет такого варианта: «${word}»`,
  long: (max: number) => `Не длиннее ${max} знаков`,
})

const TEXT_MAX = 4000
const MONEY_MAX = new Money('9999999999.99')
const CURRENCY = /^(?:₽|руб\.?|р\.|rub)\s*|\s*(?:₽|руб(?:лей|ля|ль)?\.?|р\.|rub)$/giu
const GROUP_SPACES = /[\s\u00a0\u202f\u2009']/g

/** «1 234,56», «1.234,56», «1,234.56», «1234.56» → «1234.56»; null — not a number. */
function decimalText(raw: string): string | null {
  let text = raw.trim().replace(/^[−–]/, '-').replace(GROUP_SPACES, '')
  if (text === '') return null
  const negative = text.startsWith('-')
  if (negative) text = text.slice(1)
  const comma = text.lastIndexOf(',')
  const dot = text.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    // The last mark separates the fraction, the other one groups.
    const decimalMark = comma > dot ? ',' : '.'
    const groupMark = decimalMark === ',' ? '.' : ','
    text = text.split(groupMark).join('').replace(decimalMark, '.')
  } else if (comma >= 0) {
    if (text.indexOf(',') !== comma) return null
    text = text.replace(',', '.')
  } else if (dot >= 0 && text.indexOf('.') !== dot) {
    text = text.split('.').join('')
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null
  return negative ? `-${text}` : text
}

/** A sum in roubles typed by a person or pasted from Excel: a string with up to two decimals. */
export function parseRubles(raw: string): TableCellParsed {
  const stripped = raw.trim().replace(CURRENCY, '').trim()
  if (stripped === '') return { ok: true, value: null }
  const text = decimalText(stripped)
  if (text === null) return { ok: false, reason: tableReasons.money }
  if ((text.split('.')[1] ?? '').length > 2)
    return { ok: false, reason: tableReasons.moneyFraction }
  const value = new Money(text)
  if (value.abs().greaterThan(MONEY_MAX)) return { ok: false, reason: tableReasons.moneyLarge }
  return { ok: true, value: value.toFixed(2) }
}

/** «12 900», «1 990,50», «−300»: groups by no-break spaces, a comma before kopecks, no «,00». */
export function formatRubles(value: string): string {
  const fixed = new Money(value).toFixed(2)
  const negative = fixed.startsWith('-')
  const [rubles = '0', kopecks = '00'] = (negative ? fixed.slice(1) : fixed).split('.')
  const grouped = rubles.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
  return `${negative ? '−' : ''}${grouped}${kopecks === '00' ? '' : `,${kopecks}`}`
}

/** A sum as it goes into the clipboard, CSV or an editor: «1234,50», no grouping. */
export function plainRubles(value: string): string {
  const [rubles = '0', kopecks = '00'] = new Money(value).toFixed(2).split('.')
  return kopecks === '00' ? rubles : `${rubles},${kopecks}`
}

const TRUE_WORDS = new Set(['да', 'true', 'истина', '1', '+', 'x', 'х', '✓', '✔', 'yes', 'есть'])
const FALSE_WORDS = new Set(['нет', 'false', 'ложь', '0', '-', '', 'no'])

/** Case and «ё» do not matter in a search or a choice. */
export const foldText = (text: string): string => text.toLowerCase().replaceAll('ё', 'е')

const pad = (n: number) => String(n).padStart(2, '0')

function dayOf(year: number, month: number, day: number): string | null {
  const iso = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
  const date = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso) ? iso : null
}

/** «12.11.2026», «12.11.26», «2026-11-12», «12/11/2026» → «2026-11-12»; null — not a day. */
export function parseDay(raw: string): string | null {
  const text = raw.trim()
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (iso) return dayOf(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const ru = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/.exec(text)
  if (!ru) return null
  const year = ru[3]!.length === 2 ? 2000 + Number(ru[3]) : Number(ru[3])
  return dayOf(year, Number(ru[2]), Number(ru[1]))
}

/** «2026-11-12» → «12.11.2026». */
export const formatDay = (iso: string): string => {
  const [year, month, day] = iso.split('-')
  return `${day}.${month}.${year}`
}

/** What a person typed or pasted, as the value of a cell of this column — or why not. */
export function parseTableCell(column: ArtifactColumn, raw: string): TableCellParsed {
  const text = raw.trim()
  switch (column.type) {
    case 'text': {
      const value = raw.replace(/\r\n?/g, '\n')
      if (value.length > TEXT_MAX) return { ok: false, reason: tableReasons.long(TEXT_MAX) }
      return { ok: true, value: value === '' ? null : value }
    }
    case 'number': {
      if (text === '') return { ok: true, value: null }
      const value = decimalText(text)
      if (value === null || !Number.isFinite(Number(value)))
        return { ok: false, reason: tableReasons.number }
      return { ok: true, value: Number(value) }
    }
    case 'money':
      return parseRubles(raw)
    case 'date': {
      if (text === '') return { ok: true, value: null }
      const day = parseDay(text)
      return day === null ? { ok: false, reason: tableReasons.date } : { ok: true, value: day }
    }
    case 'select': {
      if (text === '') return { ok: true, value: null }
      const word = foldText(text)
      const option = column.options?.find((each) => foldText(each) === word)
      return option ? { ok: true, value: option } : { ok: false, reason: tableReasons.option(text) }
    }
    case 'link': {
      if (text === '') return { ok: true, value: null }
      // A bare address gets its scheme; another scheme is not a link of a table.
      const value = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
      return artifactCellProblem(column, value) === null
        ? { ok: true, value }
        : { ok: false, reason: tableReasons.link }
    }
    case 'checkbox': {
      const word = text.toLowerCase()
      if (TRUE_WORDS.has(word)) return { ok: true, value: true }
      if (FALSE_WORDS.has(word)) return { ok: true, value: false }
      return { ok: false, reason: tableReasons.flag }
    }
    case 'image':
      return text === '' ? { ok: true, value: null } : { ok: false, reason: tableReasons.image }
  }
}

/** The text of a cell on the screen; an empty cell is ''. */
export function tableCellText(column: ArtifactColumn, value: ArtifactCell | undefined): string {
  if (value === null || value === undefined) return column.type === 'checkbox' ? 'нет' : ''
  switch (column.type) {
    case 'money':
      return typeof value === 'string' ? formatRubles(value) : String(value)
    case 'number':
      return typeof value === 'number' ? value.toLocaleString('ru-RU') : String(value)
    case 'date':
      return typeof value === 'string' ? formatDay(value) : String(value)
    case 'checkbox':
      return value === true ? 'да' : 'нет'
    case 'image':
      return value === '' ? '' : 'картинка'
    default:
      return String(value)
  }
}

/** The text of a cell for an editor, the clipboard and CSV: the form `parseTableCell` reads back. */
export function tableCellPlain(column: ArtifactColumn, value: ArtifactCell | undefined): string {
  if (value === null || value === undefined) return column.type === 'checkbox' ? 'нет' : ''
  switch (column.type) {
    case 'money':
      return typeof value === 'string' ? plainRubles(value) : String(value)
    case 'number':
      return String(value).replace('.', ',')
    case 'date':
      return typeof value === 'string' ? formatDay(value) : String(value)
    case 'checkbox':
      return value === true ? 'да' : 'нет'
    default:
      return String(value)
  }
}

// ---- Clipboard: tab-separated text as Excel and Google Sheets put it ----

/**
 * Rows end with CRLF or LF (Excel adds one at the very end); a cell with a tab, a line break or a
 * quote is wrapped in quotes with inner quotes doubled. A quote that does not open a cell is text.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  const n = text.length
  let atCellStart = true
  while (i < n) {
    const ch = text[i]!
    if (atCellStart && ch === '"') {
      let j = i + 1
      let value = ''
      let closed = false
      while (j < n) {
        const c = text[j]!
        if (c === '"') {
          if (text[j + 1] === '"') {
            value += '"'
            j += 2
            continue
          }
          const after = text[j + 1]
          if (after === undefined || after === '\t' || after === '\n' || after === '\r') {
            closed = true
            j += 1
            break
          }
          value += '"'
          j += 1
          continue
        }
        value += c
        j += 1
      }
      if (closed) {
        cell = value
        i = j
        atCellStart = false
        continue
      }
    }
    atCellStart = false
    if (ch === '\t') {
      row.push(cell)
      cell = ''
      atCellStart = true
      i += 1
    } else if (ch === '\r' || ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      atCellStart = true
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
    } else {
      cell += ch
      i += 1
    }
  }
  if (!atCellStart || cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

const tsvQuote = (cell: string) =>
  /[\t\r\n"]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell

/** The clipboard form of a range: what Excel and Google Sheets read back. */
export const toTsv = (matrix: readonly (readonly string[])[]): string =>
  matrix.map((row) => row.map(tsvQuote).join('\t')).join('\r\n')

// ---- CSV ----

/**
 * A cell that starts with «=», «+», «-», «@», a tab or a line break is a formula for Excel and
 * Google Sheets: agents and other people write these cells, so CSV gets a leading apostrophe
 * (the OWASP advice for CSV injection).
 */
export const neutralizeCsvCell = (cell: string): string =>
  /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell

const csvQuote = (cell: string) =>
  /[;"\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell

/**
 * CSV for Excel with a Russian locale: «;» between cells (a comma there is the decimal mark), a
 * byte order mark so that Excel reads UTF-8, CRLF between lines, sums as «1234,50».
 */
export function tableCsv(
  columns: readonly ArtifactColumn[],
  rows: readonly Pick<TableRow, 'cells'>[],
): string {
  const lines = [columns.map((column) => csvQuote(neutralizeCsvCell(column.name))).join(';')]
  for (const row of rows)
    lines.push(
      columns
        .map((column) => {
          const text = tableCellPlain(column, row.cells[column.key])
          const free = column.type === 'text' || column.type === 'select' || column.type === 'link'
          return csvQuote(free ? neutralizeCsvCell(text) : text)
        })
        .join(';'),
    )
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

// ---- Paste ----

/** A rectangle of the screen order: rows `r0..r1` of the view, columns `c0..c1` of the shown ones. */
export interface TableRect {
  r0: number
  r1: number
  c0: number
  c1: number
}

export interface TablePastePlan {
  /** Cells of rows that exist, by their key. */
  changes: { key: string; cells: ArtifactCells }[]
  /** New rows after the last one, in order. */
  inserts: ArtifactCells[]
  cells: number
  refused: number
  reasons: string[]
  clippedColumns: number
  clippedRows: number
  /** One value filled the selection, as in Excel. */
  filled: boolean
}

/**
 * Where a block of text from Excel or Google Sheets goes: from the top left cell of the selection
 * to the right and down; rows past the end become new rows up to the limit of the table; a single
 * value pasted into a range fills the range. A value that does not fit its column (a word in a
 * price) leaves the cell as it was, and the plan names why.
 */
export function planTablePaste(input: {
  view: readonly string[]
  columns: readonly ArtifactColumn[]
  matrix: readonly (readonly string[])[]
  rect: TableRect
  rowCount: number
}): TablePastePlan {
  const { view, columns, matrix, rect } = input
  const plan: TablePastePlan = {
    changes: [],
    inserts: [],
    cells: 0,
    refused: 0,
    reasons: [],
    clippedColumns: 0,
    clippedRows: 0,
    filled: false,
  }
  const note = (reason: string) => {
    plan.refused += 1
    if (plan.reasons.length < 3 && !plan.reasons.includes(reason)) plan.reasons.push(reason)
  }
  const read = (column: ArtifactColumn, raw: string, into: ArtifactCells) => {
    const parsed = parseTableCell(column, raw)
    plan.cells += 1
    if (parsed.ok) into[column.key] = parsed.value
    else note(parsed.reason)
  }
  const single = matrix.length === 1 && matrix[0]?.length === 1
  if (single && (rect.r1 > rect.r0 || rect.c1 > rect.c0)) {
    plan.filled = true
    const raw = matrix[0]![0]!
    for (let r = rect.r0; r <= rect.r1; r += 1) {
      const key = view[r]
      if (key === undefined) continue
      const cells: ArtifactCells = {}
      for (let c = rect.c0; c <= rect.c1; c += 1) {
        const column = columns[c]
        if (column) read(column, raw, cells)
      }
      plan.changes.push({ key, cells })
    }
    return plan
  }
  let room = artifactLimits.tableRows - input.rowCount
  matrix.forEach((line, i) => {
    const key = view[rect.r0 + i]
    if (key === undefined && room <= 0) {
      plan.clippedRows += 1
      return
    }
    const cells: ArtifactCells = {}
    line.forEach((raw, j) => {
      const column = columns[rect.c0 + j]
      if (!column) {
        if (i === 0) plan.clippedColumns += 1
        return
      }
      read(column, raw, cells)
    })
    if (key === undefined) {
      room -= 1
      plan.inserts.push(cells)
    } else plan.changes.push({ key, cells })
  })
  return plan
}

/** What a paste did, in one line for the client. */
export function tablePasteMessage(plan: TablePastePlan): string {
  const parts: string[] = []
  const done = plan.cells - plan.refused
  parts.push(plan.filled ? `Заполнено ячеек: ${done}` : `Вставлено ячеек: ${done}`)
  if (plan.inserts.length > 0) parts.push(`добавлено строк: ${plan.inserts.length}`)
  if (plan.refused > 0)
    parts.push(`не подошли ${plan.refused} — эти ячейки не изменены (${plan.reasons.join('; ')})`)
  if (plan.clippedColumns > 0) parts.push(`лишние столбцы не вставлены: ${plan.clippedColumns}`)
  if (plan.clippedRows > 0)
    parts.push(
      `не поместилось строк: ${plan.clippedRows} — в таблице не больше ${artifactLimits.tableRows.toLocaleString('ru-RU')} строк`,
    )
  return parts.join(' · ')
}

// ---- Order and filter ----

export interface TableSort {
  key: string
  desc: boolean
}

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })

type SortKey = bigint | number | string | null

/** The key of a cell for sorting, computed once a row: sums in kopecks, days as text, words folded. */
export function tableSortKey(column: ArtifactColumn, value: ArtifactCell | undefined): SortKey {
  if (value === null || value === undefined || value === '') return null
  switch (column.type) {
    case 'money': {
      if (typeof value !== 'string') return null
      const fixed = new Money(value).toFixed(2)
      return BigInt(fixed.replace('.', ''))
    }
    case 'number':
      return typeof value === 'number' ? value : null
    case 'checkbox':
      return value === true ? 0 : 1
    default:
      return String(value)
  }
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a === b) return 0
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b)
  return (a as number | bigint) < (b as number | bigint) ? -1 : 1
}

/**
 * The order of rows on screen: filtered by the words and sorted once, when the person asks. The
 * cabinet keeps it; edits after that do not move rows. An empty cell stays at the end both ways.
 */
export function tableOrder(input: {
  rows: readonly TableRow[]
  columns: readonly ArtifactColumn[]
  sort: readonly TableSort[]
  search: string
}): string[] {
  const words = foldText(input.search).split(/\s+/).filter(Boolean)
  const shown = input.rows.filter((row) => {
    if (words.length === 0) return true
    const text = foldText(
      input.columns.map((column) => tableCellText(column, row.cells[column.key])).join('\n'),
    )
    return words.every((word) => text.includes(word))
  })
  const sorts = input.sort.flatMap((each) => {
    const column = input.columns.find((c) => c.key === each.key)
    return column ? [{ column, desc: each.desc }] : []
  })
  if (sorts.length === 0) return shown.map((row) => row.key)
  const keyed = shown.map((row, index) => ({
    key: row.key,
    index,
    keys: sorts.map(({ column }) => tableSortKey(column, row.cells[column.key])),
  }))
  keyed.sort((x, y) => {
    for (let i = 0; i < sorts.length; i += 1) {
      const a = x.keys[i] ?? null
      const b = y.keys[i] ?? null
      if (a === null && b === null) continue
      if (a === null) return 1
      if (b === null) return -1
      const r = compareKeys(a, b)
      if (r !== 0) return sorts[i]!.desc ? -r : r
    }
    return x.index - y.index
  })
  return keyed.map((row) => row.key)
}

// ---- Totals ----

/**
 * The totals of a table (§7.7): the sum of each number and money column over the given rows, as a
 * string — money with two decimals (rule 9), numbers as Decimal makes them; columns without a
 * value have none.
 */
export function tableTotals(
  columns: readonly ArtifactColumn[],
  rows: readonly Pick<TableRow, 'cells'>[],
): Record<string, string> {
  const totals: Record<string, string> = {}
  for (const column of columns) {
    if (column.type !== 'money' && column.type !== 'number') continue
    let sum = new Money(0)
    let any = false
    for (const row of rows) {
      const value = row.cells[column.key]
      if (column.type === 'money' && typeof value === 'string' && value !== '') {
        sum = sum.plus(value)
        any = true
      } else if (column.type === 'number' && typeof value === 'number') {
        sum = sum.plus(value)
        any = true
      }
    }
    if (any) totals[column.key] = column.type === 'money' ? sum.toFixed(2) : sum.toString()
  }
  return totals
}

// ---- The blocks of a table ----

/** The columns and rows of a table from its blocks (in their order); bad JSON is no row. */
export function tableOfBlocks(
  blocks: readonly { key: string; kind: string; rev: number; content: string | null }[],
): { columnsKey: string | null; columnsRev: number; columns: ArtifactColumn[]; rows: TableRow[] } {
  let columns: ArtifactColumn[] = []
  let columnsKey: string | null = null
  let columnsRev = 0
  const rows: TableRow[] = []
  for (const block of blocks) {
    if (block.content === null) continue
    let value: unknown
    try {
      value = JSON.parse(block.content) as unknown
    } catch {
      continue
    }
    if (block.kind === 'columns' && columnsKey === null) {
      const parsed = artifactColumnsSchema.safeParse(value)
      if (parsed.success) {
        columns = parsed.data
        columnsKey = block.key
        columnsRev = block.rev
      }
    } else if (block.kind === 'row') {
      const parsed = artifactCellsSchema.safeParse(value)
      if (parsed.success) rows.push({ key: block.key, rev: block.rev, cells: parsed.data })
    }
  }
  return { columnsKey, columnsRev, columns, rows }
}

/** A Markdown table of a table, to publish it as a page for reading. */
export function tableMarkdown(
  columns: readonly ArtifactColumn[],
  rows: readonly Pick<TableRow, 'cells'>[],
): string {
  const escape = (text: string) =>
    text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const shown = columns.filter((column) => column.type !== 'image')
  const head = `| ${shown.map((column) => escape(column.name)).join(' | ')} |`
  const rule = `| ${shown.map((column) => (column.type === 'money' || column.type === 'number' ? '---:' : '---')).join(' | ')} |`
  const body = rows.map(
    (row) =>
      `| ${shown
        .map((column) => {
          const text = tableCellText(column, row.cells[column.key])
          return escape(column.type === 'money' && text !== '' ? `${text} ₽` : text)
        })
        .join(' | ')} |`,
  )
  return [head, rule, ...body].join('\n')
}
