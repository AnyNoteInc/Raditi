import Checkbox from '@mui/material/Checkbox'
import InputBase from '@mui/material/InputBase'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import { alpha, styled } from '@mui/material/styles'
import {
  cellSelectionFeature,
  columnSizingFeature,
  createColumnHelper,
  functionalUpdate,
  rowSortingFeature,
  type SortingState,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual'
import {
  type KeyboardEvent,
  memo,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { afterPaint, mark, spike, track } from '../instrument'
import { copyRange, pasteMessage, planPaste, type Rect } from './clipboard'
import {
  type CellValue,
  type ColumnId,
  COLUMNS,
  type ColumnSpec,
  displayCell,
  emptyValue,
  formatRubles,
  parseCell,
  plainCell,
  type PriceRow,
} from './model'
import type { CellChange, RowStore } from './store'
import { parseTsv } from './tsv'
import { useRow } from './useRow'
import type { Sorting } from './view'

export const ROW_H = 40
export const HEADER_H = 40
const NUM_W = 56
const STICKY_W = NUM_W + (COLUMNS[0]?.width ?? 0)
const TOTAL_W = NUM_W + COLUMNS.reduce((sum, c) => sum + c.width, 0)
const OFFSETS = COLUMNS.reduce<number[]>((acc, c, i) => {
  acc.push(i === 0 ? NUM_W : (acc[i - 1] ?? 0) + (COLUMNS[i - 1]?.width ?? 0))
  return acc
}, [])

const features = tableFeatures({ rowSortingFeature, columnSizingFeature, cellSelectionFeature })
type ViewRow = { id: string }
const helper = createColumnHelper<typeof features, ViewRow>()

type Direction = 'up' | 'down' | 'left' | 'right'
type Editing = { rowId: string; colId: ColumnId; mode: 'enter' | 'edit'; initial: string; seq: number }

export const cellDomId = (rowId: string, colId: string) => `c-${rowId}-${colId}`

/** Bits of a cell in a selection: selected and the four outer edges. */
const SEL = 1
const TOP = 2
const RIGHT = 4
const BOTTOM = 8
const LEFT = 16

interface RowApi {
  store: RowStore
  checkbox: 'mui' | 'plain'
  onCellMouseDown(rowId: string, colId: ColumnId, e: MouseEvent): void
  onCellMouseEnter(rowId: string, colId: ColumnId, e: MouseEvent): void
  onCellDoubleClick(rowId: string, colId: ColumnId, e: MouseEvent): void
  toggle(rowId: string, t0: number): void
  commit(rowId: string, colId: ColumnId, text: string, dir: Direction | null, t0: number): string | null
  cancel(): void
  setMode(mode: 'enter' | 'edit'): void
}

export interface GridProps {
  store: RowStore
  view: string[]
  sorting: Sorting
  onSorting(next: Sorting, t0: number): void
  onNotice(text: string): void
  checkbox: 'mui' | 'plain'
  label: string
}

export function Grid({ store, view, sorting, onSorting, onNotice, checkbox, label }: GridProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const data = useMemo<ViewRow[]>(() => view.map((id) => ({ id })), [view])
  const indexOf = useMemo(() => new Map(view.map((id, i) => [id, i])), [view])

  const columns = useMemo(
    () =>
      helper.columns([
        helper.display({ id: 'num', header: '№', size: NUM_W, enableSorting: false, enableCellSelection: false }),
        ...COLUMNS.map((c) =>
          helper.accessor((r: ViewRow) => store.get(r.id)?.[c.id], { id: c.id, header: c.label, size: c.width }),
        ),
      ]),
    [store],
  )

  const sortingState = sorting as SortingState
  const table = useTable({
    features,
    columns,
    data,
    getRowId: (r: ViewRow) => r.id,
    manualSorting: true,
    enableMultiSort: true,
    enableSortingRemoval: true,
    autoResetCellSelection: false,
    state: { sorting: sortingState },
    onSortingChange: (updater) => onSorting(functionalUpdate(updater, sortingState) as Sorting, performance.now()),
  })

  const [editing, setEditing] = useState<Editing | null>(null)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const editSeq = useRef(0)

  const focusedCell = table.getFocusedCell()
  const focusRowId = focusedCell?.row.id
  const focusColId = focusedCell?.column.id as ColumnId | undefined
  const focusIndex = focusRowId === undefined ? -1 : (indexOf.get(focusRowId) ?? -1)
  const focusCol = focusColId === undefined ? -1 : COLUMNS.findIndex((c) => c.id === focusColId)
  const editIndex = editing ? (indexOf.get(editing.rowId) ?? -1) : -1

  const rangeExtractor = useCallback(
    (range: Range) => {
      const out = defaultRangeExtractor(range)
      for (const keep of [focusIndex, editIndex]) {
        if (keep >= 0 && !out.includes(keep)) out.push(keep)
      }
      return out.sort((a, b) => a - b)
    },
    [focusIndex, editIndex],
  )

  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    paddingStart: HEADER_H,
    scrollPaddingStart: HEADER_H,
    getItemKey: (i) => view[i] ?? i,
    rangeExtractor,
  })

  const focusGrid = useCallback(() => scrollerRef.current?.focus({ preventScroll: true }), [])
  // A closing menu of a select editor may drop the focus on <body> after the grid took it.
  const refocusLater = useCallback(() => {
    requestAnimationFrame(() => {
      if (!editingRef.current && (document.activeElement === document.body || document.activeElement === null)) focusGrid()
    })
  }, [focusGrid])

  /** The active range in view coordinates: rows of the view, columns of COLUMNS. */
  const activeRect = useCallback((): Rect | null => {
    const ranges = table.atoms.cellSelection.get()
    const last = ranges[ranges.length - 1]
    if (!last) return null
    const r0 = indexOf.get(last.anchorRowId)
    const r1 = indexOf.get(last.focusRowId)
    const c0 = COLUMNS.findIndex((c) => c.id === last.anchorColumnId)
    const c1 = COLUMNS.findIndex((c) => c.id === last.focusColumnId)
    if (r0 === undefined || r1 === undefined || c0 < 0 || c1 < 0) return null
    return { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) }
  }, [table, indexOf])

  const reveal = useCallback(
    (rowIndex: number, colIndex: number) => {
      if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
      const el = scrollerRef.current
      if (!el || colIndex <= 0) return
      const left = OFFSETS[colIndex] ?? 0
      const right = left + (COLUMNS[colIndex]?.width ?? 0)
      if (left - STICKY_W < el.scrollLeft) el.scrollLeft = left - STICKY_W
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
    },
    [virtualizer],
  )

  const setFocus = useCallback(
    (rowIndex: number, colIndex: number) => {
      const r = Math.max(0, Math.min(view.length - 1, rowIndex))
      const c = Math.max(0, Math.min(COLUMNS.length - 1, colIndex))
      const id = view[r]
      const col = COLUMNS[c]
      if (!id || !col) return
      table.setFocusedCell(id, col.id)
      reveal(r, c)
    },
    [table, view, reveal],
  )

  const startEdit = useCallback(
    (rowId: string, colId: ColumnId, mode: 'enter' | 'edit', t0: number, initial?: string) => {
      const row = store.get(rowId)
      const col = COLUMNS.find((c) => c.id === colId)
      if (!row || !col) return
      if (col.kind === 'checkbox') return
      editSeq.current++
      setEditing({ rowId, colId, mode, initial: initial ?? plainCell(col, row), seq: editSeq.current })
      track('editStart', t0)
    },
    [store],
  )

  const apply = useCallback(
    (label: string, changes: CellChange[]) => {
      const sent = store.applyLocal(label, changes)
      spike.lastSent = sent
    },
    [store],
  )

  const api = useRef<RowApi>(null as unknown as RowApi)
  api.current = {
    store,
    checkbox,
    onCellMouseDown(rowId, colId, e) {
      if ((e.target as HTMLElement).closest('[data-editor]')) return
      e.preventDefault()
      const cell = table
        .getRow(rowId)
        ?.getAllCells()
        .find((c) => c.column.id === colId)
      cell?.getSelectionStartHandler()(e)
      focusGrid()
    },
    onCellMouseEnter(rowId, colId, e) {
      const cell = table
        .getRow(rowId)
        ?.getAllCells()
        .find((c) => c.column.id === colId)
      cell?.getSelectionExtendHandler()(e)
    },
    onCellDoubleClick(rowId, colId, e) {
      startEdit(rowId, colId, 'edit', e.timeStamp)
    },
    toggle(rowId, t0) {
      const row = store.get(rowId)
      if (!row) return
      apply('Наличие', [{ id: rowId, cells: { inStock: !row.inStock } }])
      track('toggle', t0)
    },
    commit(rowId, colId, text, dir, t0) {
      const col = COLUMNS.find((c) => c.id === colId) as ColumnSpec
      const parsed = parseCell(col, text)
      if (!parsed.ok) return parsed.reason
      apply('Правка', [{ id: rowId, cells: { [colId]: parsed.value } }])
      setEditing(null)
      const r = indexOf.get(rowId) ?? 0
      const c = COLUMNS.indexOf(col)
      if (dir === 'down') setFocus(r + 1, c)
      else if (dir === 'up') setFocus(r - 1, c)
      else if (dir === 'right') setFocus(r, c + 1)
      else if (dir === 'left') setFocus(r, c - 1)
      else table.setFocusedCell(rowId, colId)
      focusGrid()
      refocusLater()
      track('editCommit', t0)
      return null
    },
    cancel() {
      setEditing(null)
      focusGrid()
      refocusLater()
    },
    setMode(mode) {
      setEditing((e) => (e ? { ...e, mode } : e))
    },
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editingRef.current || e.target !== e.currentTarget) return
    const mod = e.metaKey || e.ctrlKey
    const t0 = e.timeStamp
    const rows = view.length
    if (rows === 0) return
    const r = focusIndex < 0 ? 0 : focusIndex
    const c = focusCol < 0 ? 0 : focusCol
    const page = Math.max(1, Math.floor(((scrollerRef.current?.clientHeight ?? 400) - HEADER_H) / ROW_H) - 1)
    const move = (dir: Direction) => {
      e.preventDefault()
      if (focusIndex < 0) {
        setFocus(0, 0)
      } else if (e.shiftKey) {
        table.extendCellSelection(dir)
        const ranges = table.atoms.cellSelection.get()
        const last = ranges[ranges.length - 1]
        if (last) reveal(indexOf.get(last.focusRowId) ?? r, COLUMNS.findIndex((x) => x.id === last.focusColumnId))
      } else if (mod) {
        if (dir === 'up') setFocus(0, c)
        else if (dir === 'down') setFocus(rows - 1, c)
        else if (dir === 'left') setFocus(r, 0)
        else setFocus(r, COLUMNS.length - 1)
      } else {
        table.moveCellSelection(dir)
        const next = table.getFocusedCell()
        reveal(indexOf.get(next?.row.id ?? '') ?? r, COLUMNS.findIndex((x) => x.id === next?.column.id))
      }
      track('move', t0)
    }
    switch (e.key) {
      case 'ArrowUp':
        return move('up')
      case 'ArrowDown':
        return move('down')
      case 'ArrowLeft':
        return move('left')
      case 'ArrowRight':
        return move('right')
      case 'Tab': {
        const last = r === rows - 1 && c === COLUMNS.length - 1
        const first = r === 0 && c === 0
        if ((!e.shiftKey && last) || (e.shiftKey && first)) return // focus leaves the grid
        e.preventDefault()
        if (e.shiftKey) setFocus(c === 0 ? r - 1 : r, c === 0 ? COLUMNS.length - 1 : c - 1)
        else setFocus(c === COLUMNS.length - 1 ? r + 1 : r, c === COLUMNS.length - 1 ? 0 : c + 1)
        return
      }
      case 'Home':
        e.preventDefault()
        return mod ? setFocus(0, c) : setFocus(r, 0)
      case 'End':
        e.preventDefault()
        return mod ? setFocus(rows - 1, c) : setFocus(r, COLUMNS.length - 1)
      case 'PageDown':
        e.preventDefault()
        return setFocus(r + page, c)
      case 'PageUp':
        e.preventDefault()
        return setFocus(r - page, c)
      case 'Enter':
      case 'F2': {
        e.preventDefault()
        const id = view[r]
        const col = COLUMNS[c]
        if (!id || !col) return
        if (col.kind === 'checkbox') return api.current.toggle(id, t0)
        return startEdit(id, col.id, 'edit', t0)
      }
      case ' ': {
        const col = COLUMNS[c]
        if (col?.kind !== 'checkbox') break
        e.preventDefault()
        const rect = activeRect() ?? { r0: r, r1: r, c0: c, c1: c }
        const ids = view.slice(rect.r0, rect.r1 + 1)
        const all = ids.every((id) => store.get(id)?.inStock)
        apply(
          'Наличие',
          ids.map((id) => ({ id, cells: { inStock: !all } })),
        )
        track('toggle', t0)
        return
      }
      case 'Delete':
      case 'Backspace': {
        e.preventDefault()
        const rect = activeRect() ?? { r0: r, r1: r, c0: c, c1: c }
        const changes: CellChange[] = []
        for (let i = rect.r0; i <= rect.r1; i++) {
          const id = view[i]
          if (!id) continue
          const cells: Partial<Record<ColumnId, CellValue>> = {}
          for (let j = rect.c0; j <= rect.c1; j++) {
            const col = COLUMNS[j]
            if (col) cells[col.id] = emptyValue(col)
          }
          changes.push({ id, cells })
        }
        apply('Очистка', changes)
        track('clear', t0)
        return
      }
      case 'Escape':
        e.preventDefault()
        return setFocus(r, c)
      default:
        break
    }
    // Shortcuts by the physical key: with a Russian layout `key` is «ф» and «я».
    if (mod && e.code === 'KeyA') {
      e.preventDefault()
      table.selectAllCells()
      return
    }
    if (mod && e.code === 'KeyZ') {
      e.preventDefault()
      const undone = store.undo()
      if (undone) onNotice(`Отменено: ${undone.label.toLowerCase()}`)
      track('undo', t0)
      return
    }
    if (e.key.length === 1 && !mod && !e.altKey) {
      const id = view[r]
      const col = COLUMNS[c]
      if (!id || !col) return
      e.preventDefault()
      if (col.kind === 'checkbox') return
      if (col.kind === 'select') {
        const option = col.options?.find((o) => o.toLowerCase().startsWith(e.key.toLowerCase()))
        return startEdit(id, col.id, 'enter', t0, option ?? plainCell(col, store.get(id) as PriceRow))
      }
      startEdit(id, col.id, 'enter', t0, e.key)
    }
  }

  const onCopy = (e: ClipboardEvent) => {
    if (editingRef.current || !e.clipboardData) return
    const rect = activeRect()
    if (!rect) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', copyRange(store, view, COLUMNS, rect))
  }

  const onPaste = (e: ClipboardEvent) => {
    if (editingRef.current || !e.clipboardData) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    const t0 = e.timeStamp
    const rect = activeRect() ?? { r0: Math.max(0, focusIndex), r1: Math.max(0, focusIndex), c0: Math.max(0, focusCol), c1: Math.max(0, focusCol) }
    const matrix = parseTsv(text)
    const plan = planPaste(store, view, COLUMNS, matrix, rect)
    for (const insert of plan.inserts) store.placement.set(insert.row.id, null)
    const sent = store.applyLocal('Вставка', plan.changes, plan.inserts)
    spike.lastPaste = { ...plan, changes: plan.changes.length, inserts: plan.inserts.length, sent }
    onNotice(pasteMessage(plan))
    // Select what was pasted, as spreadsheets do.
    const rowsPasted = plan.filled ? rect.r1 - rect.r0 + 1 : matrix.length - plan.clippedRows
    const colsPasted = plan.filled ? rect.c1 - rect.c0 + 1 : Math.min(COLUMNS.length - rect.c0, Math.max(...matrix.map((l) => l.length)))
    afterPaint(() => {
      const ids = (spike.view as string[] | undefined) ?? view
      const a = ids[rect.r0]
      const b = ids[Math.min(ids.length - 1, rect.r0 + rowsPasted - 1)]
      const c0 = COLUMNS[rect.c0]
      const c1 = COLUMNS[Math.min(COLUMNS.length - 1, rect.c0 + colsPasted - 1)]
      if (a && b && c0 && c1) {
        table.selectCellRange({ anchorRowId: a, anchorColumnId: c0.id, focusRowId: b, focusColumnId: c1.id })
      }
    })
    track('paste', t0)
  }

  // Selection masks of the rows on screen: one string per row, so a row renders only when its
  // own cells change their look.
  const bounds = table.getCellSelectionBounds()
  const multi = bounds.length > 1 || bounds.some((b) => b.maxRowIndex > b.minRowIndex || b.maxColumnIndex > b.minColumnIndex)
  const selected = (i: number, j: number) =>
    multi && bounds.some((b) => i >= b.minRowIndex && i <= b.maxRowIndex && j + 1 >= b.minColumnIndex && j + 1 <= b.maxColumnIndex)
  const maskOf = (i: number): string => {
    if (!multi) return ''
    let out = ''
    for (let j = 0; j < COLUMNS.length; j++) {
      let bits = 0
      if (selected(i, j)) {
        bits = SEL
        if (!selected(i - 1, j)) bits |= TOP
        if (!selected(i, j + 1)) bits |= RIGHT
        if (!selected(i + 1, j)) bits |= BOTTOM
        if (!selected(i, j - 1)) bits |= LEFT
      }
      out += String.fromCharCode(97 + bits)
    }
    return out
  }

  const items = virtualizer.getVirtualItems()
  spike.view = view
  spike.rendered = items.length

  const painted = useRef(false)
  useLayoutEffect(() => {
    spike.commits++
    if (painted.current) return
    painted.current = true
    mark('table:committed')
    afterPaint(() => {
      mark('table:painted')
      spike.ready = true
    })
  })

  // Firefox sends copy and paste of a focused element that is not editable to <body> (the
  // target is not the grid), so they are taken on the document while the grid has the focus.
  const clipboard = useRef({ onCopy, onPaste })
  clipboard.current = { onCopy, onPaste }
  useEffect(() => {
    const inGrid = () => document.activeElement === scrollerRef.current
    const copy = (e: ClipboardEvent) => inGrid() && clipboard.current.onCopy(e)
    const paste = (e: ClipboardEvent) => inGrid() && clipboard.current.onPaste(e)
    document.addEventListener('copy', copy)
    document.addEventListener('paste', paste)
    return () => {
      document.removeEventListener('copy', copy)
      document.removeEventListener('paste', paste)
    }
  }, [])

  useEffect(() => {
    spike.grid = {
      focus: (rowIndex: number, colId: ColumnId) => {
        setFocus(rowIndex, COLUMNS.findIndex((c) => c.id === colId))
        focusGrid()
      },
      select: (r0: number, c0: ColumnId, r1: number, c1: ColumnId) => {
        const a = view[r0]
        const b = view[r1]
        if (a && b) table.selectCellRange({ anchorRowId: a, anchorColumnId: c0, focusRowId: b, focusColumnId: c1 })
        focusGrid()
      },
      focused: () => {
        const f = table.getFocusedCell()
        return f ? { rowId: f.row.id, colId: f.column.id, index: indexOf.get(f.row.id) ?? -1 } : null
      },
      editing: () => editingRef.current,
      edit: (rowIndex: number, colId: ColumnId) => {
        const id = view[rowIndex]
        if (!id) return
        table.setFocusedCell(id, colId)
        reveal(rowIndex, COLUMNS.findIndex((c) => c.id === colId))
        startEdit(id, colId, 'edit', performance.now())
      },
      selectedColumns: () => table.getCellSelectionColumnIds(),
      scroller: () => scrollerRef.current,
    }
  })

  const headers = table.getHeaderGroups()[0]?.headers ?? []

  return (
    <GridRoot
      ref={scrollerRef}
      role="grid"
      aria-label={label}
      aria-rowcount={view.length + 1}
      aria-colcount={COLUMNS.length + 1}
      aria-multiselectable="true"
      aria-activedescendant={focusRowId && focusColId && !editing ? cellDomId(focusRowId, focusColId) : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget && !table.getFocusedCell() && view.length > 0) setFocus(0, 0)
      }}
      data-grid=""
    >
      <div className="sizer" style={{ height: virtualizer.getTotalSize(), width: TOTAL_W }}>
        <div role="row" aria-rowindex={1} className="header" style={{ width: TOTAL_W }}>
          {headers.map((h, j) => {
            const sorted = h.column.getIsSorted()
            const order = sorting.length > 1 ? h.column.getSortIndex() : -1
            const col = COLUMNS[j - 1]
            return (
              <div
                key={h.id}
                role="columnheader"
                aria-colindex={j + 1}
                aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                className={`hcell${j <= 1 ? ' sticky' : ''}${col?.align === 'right' ? ' right' : ''}${col?.align === 'center' ? ' center' : ''}`}
                style={{ width: h.getSize(), left: j === 1 ? NUM_W : j === 0 ? 0 : undefined }}
                onClick={h.column.getCanSort() ? h.column.getToggleSortingHandler() : undefined}
                data-col={h.column.id}
              >
                <span className="label">{h.column.columnDef.header as ReactNode}</span>
                {sorted ? (
                  <span className="sort" aria-hidden="true">
                    {sorted === 'asc' ? '↑' : '↓'}
                    {order >= 0 ? order + 1 : ''}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
        {items.map((item) => {
          const id = view[item.index]
          if (!id) return null
          return (
            <GridRow
              key={id}
              id={id}
              index={item.index}
              top={item.start}
              mask={maskOf(item.index)}
              focusCol={item.index === focusIndex ? focusCol : -1}
              editing={editing && editing.rowId === id ? editing : null}
              api={api}
            />
          )
        })}
        {view.length === 0 ? <div className="empty">Ничего не нашлось</div> : null}
      </div>
    </GridRoot>
  )
}

interface GridRowProps {
  id: string
  index: number
  top: number
  mask: string
  focusCol: number
  editing: Editing | null
  api: React.RefObject<RowApi>
}

const GridRow = memo(function GridRow({ id, index, top, mask, focusCol, editing, api }: GridRowProps) {
  const store = api.current.store
  const row = useRow(store, id)
  if (!row) return null
  return (
    <div role="row" aria-rowindex={index + 2} className="row" style={{ transform: `translateY(${top}px)`, width: TOTAL_W }} data-row={id}>
      <div role="gridcell" aria-colindex={1} aria-readonly="true" className="cell num sticky" style={{ width: NUM_W, left: 0 }}>
        {index + 1}
      </div>
      {COLUMNS.map((col, j) => {
        const bits = mask ? mask.charCodeAt(j) - 97 : 0
        const isEditing = editing?.colId === col.id
        const cls = [
          'cell',
          col.kind,
          j === 0 ? 'sticky' : '',
          bits & SEL ? 'sel' : '',
          bits & TOP ? 'e-t' : '',
          bits & RIGHT ? 'e-r' : '',
          bits & BOTTOM ? 'e-b' : '',
          bits & LEFT ? 'e-l' : '',
          focusCol === j ? 'focus' : '',
          isEditing ? 'editing' : '',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div
            key={col.id}
            id={cellDomId(id, col.id)}
            role={col.id === 'name' ? 'rowheader' : 'gridcell'}
            aria-colindex={j + 2}
            aria-selected={bits & SEL || focusCol === j ? 'true' : 'false'}
            className={cls}
            style={{ width: col.width, left: j === 0 ? NUM_W : undefined }}
            data-col={col.id}
            onMouseDown={(e) => api.current.onCellMouseDown(id, col.id, e)}
            onMouseEnter={(e) => api.current.onCellMouseEnter(id, col.id, e)}
            onDoubleClick={(e) => api.current.onCellDoubleClick(id, col.id, e)}
          >
            {isEditing && editing ? (
              <Editor key={editing.seq} row={row} col={col} editing={editing} api={api} />
            ) : (
              <CellView row={row} col={col} api={api} />
            )}
          </div>
        )
      })}
    </div>
  )
})

function CellView({ row, col, api }: { row: PriceRow; col: ColumnSpec; api: React.RefObject<RowApi> }) {
  if (col.kind === 'checkbox') {
    const label = `${col.label}: ${row.name || 'без названия'}`
    if (api.current.checkbox === 'plain') {
      return (
        <span
          className={`flag${row.inStock ? ' on' : ''}`}
          role="checkbox"
          aria-checked={row.inStock}
          aria-label={label}
          onClick={(e) => api.current.toggle(row.id, e.timeStamp)}
        />
      )
    }
    return (
      <Checkbox
        size="small"
        disableRipple
        tabIndex={-1}
        checked={row.inStock}
        onMouseDown={(e) => e.preventDefault()}
        onChange={(e) => api.current.toggle(row.id, e.timeStamp)}
        slotProps={{ input: { 'aria-label': label } }}
      />
    )
  }
  if (col.id === 'name' && row.name === '') return <span className="txt placeholder">Без названия</span>
  if (col.kind === 'money') return <span className="txt">{row.price === '' ? '' : formatRubles(row.price)}</span>
  return <span className="txt">{displayCell(col, row)}</span>
}

function Editor({ row, col, editing, api }: { row: PriceRow; col: ColumnSpec; editing: Editing; api: React.RefObject<RowApi> }) {
  const [text, setText] = useState(editing.initial)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const done = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [])

  const finish = (dir: Direction | null, t0: number, value = text) => {
    if (done.current) return
    // The commit moves the focus to the grid, which blurs this input: mark it done first, so the
    // blur does not commit a second time (and put the selection back on this cell).
    done.current = true
    const reason = api.current.commit(row.id, col.id, value, dir, t0)
    if (reason) {
      done.current = false
      setError(reason)
      ref.current?.focus()
    }
  }

  if (col.kind === 'select') {
    return (
      <Select
        data-editor=""
        className="editor select"
        size="small"
        defaultOpen
        value={text}
        onClose={() => {
          if (!done.current) {
            done.current = true
            api.current.cancel()
          }
        }}
        input={<InputBase />}
        inputProps={{ 'aria-label': `${col.label}: ${row.name}` }}
        // The menu is a modal: it traps the focus and gives it back to the editor that is gone.
        // The grid takes the focus itself after a choice (RowApi.commit, RowApi.cancel).
        MenuProps={{ transitionDuration: 0, disableRestoreFocus: true }}
      >
        {/* A choice commits even when it is the value the editor opened with (a typed letter). */}
        <MenuItem value="" onClick={(e) => finish(null, e.timeStamp, '')}>
          <em>Без категории</em>
        </MenuItem>
        {col.options?.map((o) => (
          <MenuItem key={o} value={o} onClick={(e) => finish(null, e.timeStamp, o)}>
            {o}
          </MenuItem>
        ))}
      </Select>
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.stopPropagation()
    const t0 = e.timeStamp
    const enterMode = editing.mode === 'enter'
    if (e.key === 'Enter') {
      if (col.multiline && (e.altKey || e.shiftKey)) return
      e.preventDefault()
      return finish(e.shiftKey ? 'up' : 'down', t0)
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      return finish(e.shiftKey ? 'left' : 'right', t0)
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      done.current = true
      return api.current.cancel()
    }
    if (e.key === 'F2') {
      e.preventDefault()
      return api.current.setMode(enterMode ? 'edit' : 'enter')
    }
    if (enterMode && !col.multiline) {
      const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[
        e.key as 'ArrowUp'
      ]
      if (dir) {
        e.preventDefault()
        finish(dir, t0)
      }
    }
  }

  return (
    <div className={`editor${col.multiline ? ' multi' : ''}${error ? ' invalid' : ''}`} data-editor="">
      <InputBase
        inputRef={ref}
        value={text}
        multiline={col.multiline}
        maxRows={col.multiline ? 6 : undefined}
        onChange={(e) => {
          setText(e.target.value)
          if (error) setError(null)
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!done.current) finish(null, e.timeStamp)
        }}
        inputProps={{
          'aria-label': `${col.label}: ${row.name || 'без названия'}`,
          'aria-invalid': error ? 'true' : undefined,
          'aria-describedby': error ? `${cellDomId(row.id, col.id)}-error` : undefined,
          inputMode: col.kind === 'money' ? 'decimal' : undefined,
          enterKeyHint: 'done',
          spellCheck: col.kind === 'text',
        }}
        fullWidth
      />
      {error ? (
        <div className="error" id={`${cellDomId(row.id, col.id)}-error`} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

const GridRoot = styled('div')(({ theme }) => {
  const line = theme.palette.divider
  const accent = theme.palette.primary.main
  return {
    position: 'relative',
    overflow: 'auto',
    height: '100%',
    outline: 'none',
    background: theme.palette.background.paper,
    overscrollBehavior: 'contain',
    '--sel': accent,
    '& .sizer': { position: 'relative' },
    '& .header': {
      position: 'sticky',
      top: 0,
      zIndex: 3,
      display: 'flex',
      height: HEADER_H,
      background: theme.palette.background.default,
      borderBottom: `1px solid ${line}`,
    },
    '& .hcell': {
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '0 10px',
      fontSize: 13,
      fontWeight: 600,
      color: theme.palette.text.secondary,
      borderRight: `1px solid ${line}`,
      cursor: 'pointer',
      userSelect: 'none',
      whiteSpace: 'nowrap',
      background: theme.palette.background.default,
      '&.right': { justifyContent: 'flex-end' },
      '&.center': { justifyContent: 'center' },
      '& .sort': { color: accent, fontWeight: 700 },
    },
    // Two classes, so it wins over `.cell { position: relative }` declared below: with
    // `relative`, `left` would shift the cell instead of pinning it.
    '& .cell.sticky, & .hcell.sticky': { position: 'sticky', zIndex: 2 },
    '& .row': {
      position: 'absolute',
      top: 0,
      left: 0,
      display: 'flex',
      height: ROW_H,
      borderBottom: `1px solid ${line}`,
      background: theme.palette.background.paper,
      '&:hover .cell': { background: theme.palette.action.hover },
    },
    '& .cell': {
      flex: 'none',
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      padding: '0 10px',
      fontSize: 14,
      borderRight: `1px solid ${line}`,
      background: theme.palette.background.paper,
      cursor: 'cell',
      '--et': 0,
      '--er': 0,
      '--eb': 0,
      '--el': 0,
      '&.sel': {
        background: alpha(accent, 0.1),
        boxShadow:
          'inset 0 calc(var(--et) * 2px) 0 0 var(--sel), inset calc(var(--er) * -2px) 0 0 0 var(--sel), inset 0 calc(var(--eb) * -2px) 0 0 var(--sel), inset calc(var(--el) * 2px) 0 0 0 var(--sel)',
      },
      '&.e-t': { '--et': 1 },
      '&.e-r': { '--er': 1 },
      '&.e-b': { '--eb': 1 },
      '&.e-l': { '--el': 1 },
      '&.focus': { outline: `2px solid ${accent}`, outlineOffset: -2, zIndex: 1 },
      '&.money': { justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums' },
      '&.checkbox': { justifyContent: 'center', padding: 0 },
      '&.num': {
        justifyContent: 'flex-end',
        color: theme.palette.text.secondary,
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
        cursor: 'default',
      },
      '&.editing': { zIndex: 4, overflow: 'visible' },
    },
    '& .txt': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
    '& .placeholder': { color: theme.palette.text.disabled },
    '& .flag': {
      width: 18,
      height: 18,
      borderRadius: 4,
      border: `2px solid ${theme.palette.text.secondary}`,
      cursor: 'pointer',
      '&.on': { background: accent, borderColor: accent },
    },
    '& .editor': {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      padding: '0 8px',
      background: theme.palette.background.paper,
      boxShadow: `inset 0 0 0 2px ${accent}, 0 4px 12px ${alpha('#000', 0.18)}`,
      '& .MuiInputBase-root': { fontSize: 14 },
      '&.multi': { bottom: 'auto', minHeight: ROW_H, alignItems: 'flex-start', padding: '9px 8px' },
      '&.invalid': { boxShadow: `inset 0 0 0 2px ${theme.palette.error.main}` },
      '& .error': {
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: 2,
        padding: '4px 8px',
        borderRadius: 6,
        fontSize: 12,
        whiteSpace: 'nowrap',
        color: theme.palette.error.contrastText,
        background: theme.palette.error.main,
      },
    },
    '& .editor.select': { padding: '0 8px', '& .MuiSelect-select': { padding: 0 } },
    '& .money .editor input': { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
    '& .empty': {
      position: 'absolute',
      top: HEADER_H + 24,
      left: 24,
      color: theme.palette.text.secondary,
    },
  }
})
