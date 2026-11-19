import { type CellValue, type ColumnId, type ColumnSpec, LIMITS, parseCell, plainCell, type PriceRow } from './model'
import type { CellChange, Insert, RowStore } from './store'
import { toTsv } from './tsv'

export interface Rect {
  r0: number
  r1: number
  c0: number
  c1: number
}

export interface PastePlan {
  changes: CellChange[]
  inserts: Insert[]
  cells: number
  refused: number
  reasons: string[]
  clippedColumns: number
  clippedRows: number
  filled: boolean
}

const NEW_ROW: Omit<PriceRow, 'id'> = {
  name: '',
  category: '',
  unit: 'шт',
  price: '',
  inStock: true,
  note: '',
}

/**
 * Where a block of text from Excel or Google Sheets goes: from the top left cell of the
 * selection, to the right and down; rows past the end become new rows (up to the limit of the
 * table); a single value pasted into a range fills the range, as in Excel and Google Sheets.
 * A value that does not fit its column (a word in a price) leaves the cell as it was.
 */
export function planPaste(
  store: RowStore,
  view: readonly string[],
  columns: readonly ColumnSpec[],
  matrix: string[][],
  rect: Rect,
): PastePlan {
  const plan: PastePlan = {
    changes: [],
    inserts: [],
    cells: 0,
    refused: 0,
    reasons: [],
    clippedColumns: 0,
    clippedRows: 0,
    filled: false,
  }
  const single = matrix.length === 1 && matrix[0]?.length === 1
  const many = rect.r1 > rect.r0 || rect.c1 > rect.c0
  if (single && many) {
    plan.filled = true
    const raw = matrix[0]?.[0] ?? ''
    for (let r = rect.r0; r <= rect.r1; r++) {
      const id = view[r]
      if (!id) continue
      const cells: Partial<Record<ColumnId, CellValue>> = {}
      for (let c = rect.c0; c <= rect.c1; c++) {
        const column = columns[c]
        if (!column) continue
        const parsed = parseCell(column, raw)
        plan.cells++
        if (parsed.ok) cells[column.id] = parsed.value
        else note(plan, parsed.reason)
      }
      plan.changes.push({ id, cells })
    }
    return plan
  }
  let room = LIMITS.rows - store.rows.size
  let after: string | null = store.order.at(-1) ?? null
  matrix.forEach((line, i) => {
    const r = rect.r0 + i
    const existing = view[r]
    let target: PriceRow | undefined
    if (!existing) {
      if (room <= 0) {
        plan.clippedRows++
        return
      }
      room--
      target = { id: store.newRowId(), ...NEW_ROW }
      plan.inserts.push({ after, row: target })
      after = target.id
    }
    const cells: Partial<Record<ColumnId, CellValue>> = {}
    line.forEach((raw, j) => {
      const column = columns[rect.c0 + j]
      if (!column) {
        if (i === 0) plan.clippedColumns++
        return
      }
      const parsed = parseCell(column, raw)
      plan.cells++
      if (parsed.ok) cells[column.id] = parsed.value
      else note(plan, parsed.reason)
    })
    if (target) Object.assign(target, cells)
    else if (existing) plan.changes.push({ id: existing, cells })
  })
  return plan
}

function note(plan: PastePlan, reason: string): void {
  plan.refused++
  if (plan.reasons.length < 3 && !plan.reasons.includes(reason)) plan.reasons.push(reason)
}

export function pasteMessage(plan: PastePlan): string {
  const parts: string[] = []
  const done = plan.cells - plan.refused
  parts.push(plan.filled ? `Заполнено ячеек: ${done}` : `Вставлено ячеек: ${done}`)
  if (plan.inserts.length > 0) parts.push(`добавлено строк: ${plan.inserts.length}`)
  if (plan.refused > 0) parts.push(`не подошли ${plan.refused} — эти ячейки не изменены (${plan.reasons.join('; ')})`)
  if (plan.clippedColumns > 0) parts.push(`лишние столбцы не вставлены: ${plan.clippedColumns}`)
  if (plan.clippedRows > 0) parts.push(`не поместилось строк: ${plan.clippedRows} — в таблице не больше ${LIMITS.rows.toLocaleString('ru-RU')} строк`)
  return parts.join(' · ')
}

/** The clipboard text of a range, in the plain form Excel and Google Sheets read back. */
export function copyRange(store: RowStore, view: readonly string[], columns: readonly ColumnSpec[], rect: Rect): string {
  const matrix: string[][] = []
  for (let r = rect.r0; r <= rect.r1; r++) {
    const row = store.get(view[r] ?? '')
    if (!row) continue
    const line: string[] = []
    for (let c = rect.c0; c <= rect.c1; c++) {
      const column = columns[c]
      if (column) line.push(plainCell(column, row))
    }
    matrix.push(line)
  }
  return toTsv(matrix)
}
