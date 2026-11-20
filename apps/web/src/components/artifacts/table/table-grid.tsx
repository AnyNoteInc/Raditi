'use client'

import Box from '@mui/material/Box'
import Checkbox from '@mui/material/Checkbox'
import InputBase from '@mui/material/InputBase'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { alpha } from '@mui/material/styles'
import {
  parseTableCell,
  parseTsv,
  planTablePaste,
  tableCellPlain,
  tableCellText,
  tablePasteMessage,
  toTsv,
  type ArtifactCell,
  type ArtifactCells,
  type ArtifactColumn,
  type TableRect,
  type TableRow,
} from '@repo/domain/artifacts'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'

import { tableTexts } from './table-texts'
import type { TableState } from './use-table'

// The grid of a table on a wide screen (docs/plan/88-artifacts.md, §7.7; spike 5): rows drawn as
// they scroll into view (TanStack Virtual), the head and the pinned columns stay in place, the
// roles of a grid with the counts and the indices of rows. The keyboard is Excel's — by
// `KeyboardEvent.code`, so a Russian layout works the same: arrows and Tab, an edit starts by
// Enter, F2, a double click or typing, Esc cancels, Delete clears, Space flips a flag, Ctrl+Z takes
// back the person's own edit. Copy and paste are heard on the document: Firefox picks their target
// by the selection, and a grid without selected text gets them in `<body>`.

export const ROW_H = 40
const NUMBER_W = 56

const widthOf = (column: ArtifactColumn): number => {
  switch (column.type) {
    case 'money':
    case 'number':
      return 132
    case 'date':
      return 120
    case 'checkbox':
      return 112
    case 'select':
      return 160
    case 'link':
      return 240
    case 'image':
      return 120
    default:
      return 240
  }
}

const alignOf = (column: ArtifactColumn): 'left' | 'right' | 'center' =>
  column.type === 'money' || column.type === 'number'
    ? 'right'
    : column.type === 'checkbox'
      ? 'center'
      : 'left'

interface Cursor {
  r: number
  c: number
}

interface Editing {
  key: string
  column: ArtifactColumn
  initial: string
}

const cellId = (artifactId: string, row: string, column: string) =>
  `table-${artifactId}-${row}-${column}`

const rectOf = (anchor: Cursor, focus: Cursor): TableRect => ({
  r0: Math.min(anchor.r, focus.r),
  r1: Math.max(anchor.r, focus.r),
  c0: Math.min(anchor.c, focus.c),
  c1: Math.max(anchor.c, focus.c),
})

export interface TableGridProps {
  artifactId: string
  title: string
  state: TableState
  /** The columns shown, pinned ones first, and how many are pinned. */
  columns: ArtifactColumn[]
  pinned: number
  /** The keys of the rows in the order of the screen. */
  view: string[]
  totals: Record<string, string>
  onMessage: (text: string) => void
  onHeader: (column: ArtifactColumn, anchor: HTMLElement) => void
}

export function TableGrid({
  artifactId,
  title,
  state,
  columns,
  pinned,
  view,
  totals,
  onMessage,
  onHeader,
}: TableGridProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<Cursor>({ r: 0, c: 0 })
  const [focus, setFocus] = useState<Cursor>({ r: 0, c: 0 })
  const [editing, setEditingState] = useState<Editing | null>(null)
  // What is edited now, read by the blur that follows a cancel or a commit: one ends it once.
  const editingNow = useRef<Editing | null>(null)
  const setEditing = (next: Editing | null) => {
    editingNow.current = next
    setEditingState(next)
  }
  const [draft, setDraft] = useState('')
  const [choice, setChoice] = useState<{
    key: string
    column: ArtifactColumn
    at: HTMLElement
  } | null>(null)
  const byKey = useMemo(() => new Map(state.rows.map((row) => [row.key, row])), [state.rows])
  const rect = rectOf(anchor, focus)
  // TanStack Virtual returns fresh functions each render: the compiler leaves this component be.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    // Before the first measure (and where nothing is measured, as in tests): a screenful of rows.
    initialRect: { width: 1000, height: 640 },
    overscan: 12,
    getItemKey: (index) => view[index] ?? index,
  })
  const offsets = useMemo(() => {
    const list: number[] = []
    let x = NUMBER_W
    for (const column of columns) {
      list.push(x)
      x += widthOf(column)
    }
    return { list, total: x }
  }, [columns])

  const clamp = useCallback(
    (cursor: Cursor): Cursor => ({
      r: Math.max(0, Math.min(view.length - 1, cursor.r)),
      c: Math.max(0, Math.min(columns.length - 1, cursor.c)),
    }),
    [columns.length, view.length],
  )
  const moveTo = (cursor: Cursor, extend = false) => {
    const next = clamp(cursor)
    setFocus(next)
    if (!extend) setAnchor(next)
    virtualizer.scrollToIndex(next.r, { align: 'auto' })
  }
  const focusGrid = () => grid.current?.focus({ preventScroll: true })

  const commit = async (key: string, column: ArtifactColumn, raw: string) => {
    const parsed = parseTableCell(column, raw)
    if (!parsed.ok) {
      onMessage(parsed.reason)
      return
    }
    const current = byKey.get(key)?.cells[column.key] ?? null
    if (current === parsed.value) return
    await writeOne(key, { [column.key]: parsed.value })
  }
  const writeOne = async (key: string, cells: ArtifactCells) => {
    try {
      const result = await state.writeCells([{ key, cells }])
      if (result.skipped.length > 0) onMessage(tableTexts.held)
    } catch {
      onMessage(tableTexts.saveFailed)
    }
  }

  const startEdit = (initial?: string) => {
    if (!state.canEdit) return
    const key = view[focus.r]
    const column = columns[focus.c]
    if (key === undefined || !column) return
    if (state.held.has(key)) {
      onMessage(tableTexts.held)
      return
    }
    if (column.type === 'checkbox') {
      void writeOne(key, { [column.key]: !(byKey.get(key)?.cells[column.key] === true) })
      return
    }
    if (column.type === 'image') return
    if (column.type === 'select') {
      const at = document.getElementById(cellId(artifactId, key, column.key))
      if (at) setChoice({ key, column, at })
      return
    }
    const value = tableCellPlain(column, byKey.get(key)?.cells[column.key])
    setEditing({ key, column, initial: value })
    setDraft(initial ?? value)
  }

  const finishEdit = async (move: Cursor | null) => {
    const current = editingNow.current
    if (!current) return
    const { key, column } = current
    setEditing(null)
    focusGrid()
    if (move) moveTo(move)
    await commit(key, column, draft)
  }

  const clearSelection = () => {
    if (!state.canEdit) return
    const changes: { key: string; cells: ArtifactCells }[] = []
    for (let r = rect.r0; r <= rect.r1; r += 1) {
      const key = view[r]
      if (key === undefined || state.held.has(key)) continue
      const cells: ArtifactCells = {}
      for (let c = rect.c0; c <= rect.c1; c += 1) {
        const column = columns[c]
        if (column && column.type !== 'image') cells[column.key] = null
      }
      changes.push({ key, cells })
    }
    void state.writeCells(changes).catch(() => onMessage(tableTexts.saveFailed))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.code === 'KeyZ') {
      event.preventDefault()
      void state.undoLast().then((done) => done && onMessage(tableTexts.undone))
      return
    }
    const step = (dr: number, dc: number) => {
      event.preventDefault()
      moveTo({ r: focus.r + dr, c: focus.c + dc }, event.shiftKey)
    }
    switch (event.code) {
      case 'ArrowUp':
        return step(-1, 0)
      case 'ArrowDown':
        return step(1, 0)
      case 'ArrowLeft':
        return step(0, -1)
      case 'ArrowRight':
        return step(0, 1)
      case 'Tab':
        event.preventDefault()
        moveTo({ r: focus.r, c: focus.c + (event.shiftKey ? -1 : 1) })
        return
      case 'PageDown':
        return step(10, 0)
      case 'PageUp':
        return step(-10, 0)
      case 'Home':
        return step(0, -columns.length)
      case 'End':
        return step(0, columns.length)
      case 'Enter':
      case 'NumpadEnter':
      case 'F2':
        event.preventDefault()
        startEdit()
        return
      case 'Space':
        if (columns[focus.c]?.type === 'checkbox') {
          event.preventDefault()
          startEdit()
        }
        return
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        clearSelection()
        return
    }
    if (!mod && !event.altKey && event.key.length === 1) {
      event.preventDefault()
      startEdit(event.key)
    }
  }

  // Copy and paste on the document while the grid holds the focus (Firefox sends them to <body>).
  const onCopy = useEffectEvent((event: ClipboardEvent) => {
    if (editing || !grid.current?.contains(document.activeElement)) return
    const matrix: string[][] = []
    for (let r = rect.r0; r <= rect.r1; r += 1) {
      const row = byKey.get(view[r] ?? '')
      if (!row) continue
      const line: string[] = []
      for (let c = rect.c0; c <= rect.c1; c += 1) {
        const column = columns[c]
        if (column) line.push(tableCellPlain(column, row.cells[column.key]))
      }
      matrix.push(line)
    }
    event.clipboardData?.setData('text/plain', toTsv(matrix))
    event.preventDefault()
  })
  const onPaste = useEffectEvent((event: ClipboardEvent) => {
    if (editing || !state.canEdit || !grid.current?.contains(document.activeElement)) return
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text === '') return
    event.preventDefault()
    const plan = planTablePaste({
      view,
      columns,
      matrix: parseTsv(text),
      rect,
      rowCount: state.rows.length,
    })
    void state
      .writeCells(
        plan.changes.filter((change) => !state.held.has(change.key)),
        plan.inserts,
      )
      .then((result) => {
        const held = plan.changes.filter((change) => state.held.has(change.key)).map((c) => c.key)
        const skipped = [...held, ...result.skipped]
        onMessage(
          [tablePasteMessage(plan), skipped.length > 0 ? tableTexts.skipped(namesOf(skipped)) : '']
            .filter(Boolean)
            .join(' · '),
        )
      })
      .catch(() => onMessage(tableTexts.saveFailed))
  })
  useEffect(() => {
    const copy = (event: ClipboardEvent) => onCopy(event)
    const paste = (event: ClipboardEvent) => onPaste(event)
    document.addEventListener('copy', copy)
    document.addEventListener('paste', paste)
    return () => {
      document.removeEventListener('copy', copy)
      document.removeEventListener('paste', paste)
    }
  }, [])

  const nameColumn = columns.find((column) => column.type === 'text')
  const namesOf = (keys: readonly string[]) =>
    keys
      .slice(0, 3)
      .map((key) => {
        const text = nameColumn
          ? tableCellText(nameColumn, byKey.get(key)?.cells[nameColumn.key])
          : ''
        return `«${text || tableTexts.untitledRow}»`
      })
      .join(', ') + (keys.length > 3 ? ` и ещё ${keys.length - 3}` : '')

  const items = virtualizer.getVirtualItems()
  const activeKey = view[focus.r]
  const activeColumn = columns[focus.c]
  const sticky = (index: number) => index < pinned
  const hasTotals = Object.keys(totals).length > 0

  return (
    <Box
      ref={scroller}
      sx={{
        position: 'relative',
        overflow: 'auto',
        height: '100%',
        minHeight: 240,
        border: 1,
        borderColor: 'divider',
        borderRadius: '12px',
        bgcolor: 'background.paper',
      }}
    >
      <Box
        ref={grid}
        role="grid"
        tabIndex={0}
        aria-label={tableTexts.grid(title)}
        aria-rowcount={view.length + 1 + (hasTotals ? 1 : 0)}
        aria-colcount={columns.length + 1}
        aria-multiselectable
        aria-readonly={!state.canEdit}
        aria-activedescendant={
          activeKey !== undefined && activeColumn
            ? cellId(artifactId, activeKey, activeColumn.key)
            : undefined
        }
        onKeyDown={onKeyDown}
        sx={{
          position: 'relative',
          width: offsets.total,
          minWidth: '100%',
          outline: 'none',
          '&:focus-visible [data-active="true"]': { outline: 2, outlineColor: 'primary.main' },
        }}
      >
        <Box
          role="row"
          aria-rowindex={1}
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 3,
            display: 'flex',
            height: ROW_H,
            bgcolor: 'background.paper',
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Box
            role="columnheader"
            aria-colindex={1}
            sx={{
              ...cellSx(NUMBER_W, 'right'),
              position: 'sticky',
              left: 0,
              zIndex: 4,
              bgcolor: 'background.paper',
              color: 'text.secondary',
            }}
          >
            {tableTexts.number}
          </Box>
          {columns.map((column, index) => (
            <Box
              key={column.key}
              role="columnheader"
              aria-colindex={index + 2}
              component="button"
              type="button"
              onClick={(event) => onHeader(column, event.currentTarget as HTMLElement)}
              sx={{
                ...cellSx(widthOf(column), alignOf(column)),
                font: 'inherit',
                fontWeight: 600,
                border: 0,
                cursor: 'pointer',
                bgcolor: 'background.paper',
                color: 'text.primary',
                ...(sticky(index)
                  ? { position: 'sticky', left: offsets.list[index], zIndex: 4 }
                  : {}),
              }}
            >
              {column.name}
            </Box>
          ))}
        </Box>
        <Box sx={{ position: 'relative', height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const key = view[item.index]
            const row = key === undefined ? undefined : byKey.get(key)
            if (key === undefined || !row) return null
            return (
              <GridRow
                key={key}
                artifactId={artifactId}
                row={row}
                index={item.index}
                top={item.start}
                columns={columns}
                offsets={offsets.list}
                pinned={pinned}
                held={state.held.has(key)}
                rect={rect}
                focus={focus}
                editing={editing?.key === key ? editing : null}
                draft={draft}
                onDraft={setDraft}
                onFinish={(move) => void finishEdit(move)}
                onCancel={() => {
                  setEditing(null)
                  focusGrid()
                }}
                onMouseDown={(c, extend) => {
                  if (editing) void finishEdit(null)
                  moveTo({ r: item.index, c }, extend)
                  focusGrid()
                }}
                onDoubleClick={() => startEdit()}
                onToggle={(column) => {
                  if (!state.canEdit) return
                  moveTo({ r: item.index, c: columns.indexOf(column) })
                  void writeOne(key, { [column.key]: !(row.cells[column.key] === true) })
                }}
              />
            )
          })}
        </Box>
        {hasTotals && (
          <Box
            role="row"
            aria-rowindex={view.length + 2}
            sx={{
              position: 'sticky',
              bottom: 0,
              zIndex: 3,
              display: 'flex',
              height: ROW_H,
              bgcolor: 'background.paper',
              borderTop: 1,
              borderColor: 'divider',
              fontWeight: 600,
            }}
          >
            <Box
              role="rowheader"
              aria-colindex={1}
              sx={{
                ...cellSx(NUMBER_W, 'right'),
                position: 'sticky',
                left: 0,
                bgcolor: 'background.paper',
              }}
            >
              {tableTexts.total}
            </Box>
            {columns.map((column, index) => (
              <Box
                key={column.key}
                role="gridcell"
                aria-colindex={index + 2}
                sx={{
                  ...cellSx(widthOf(column), alignOf(column)),
                  bgcolor: 'background.paper',
                  ...(sticky(index) ? { position: 'sticky', left: offsets.list[index] } : {}),
                }}
              >
                {totals[column.key] === undefined
                  ? ''
                  : tableCellText(
                      column,
                      column.type === 'money' ? totals[column.key]! : Number(totals[column.key]),
                    )}
              </Box>
            ))}
          </Box>
        )}
      </Box>
      {view.length === 0 && (
        <Box sx={{ p: 3, color: 'text.secondary' }}>
          {state.rows.length === 0 ? tableTexts.empty : tableTexts.nothingFound}
        </Box>
      )}
      <Menu
        open={choice !== null}
        anchorEl={choice?.at ?? null}
        onClose={() => {
          setChoice(null)
          focusGrid()
        }}
        // Focus back to the grid after the menu of a choice (spike 5): the keyboard goes on there.
        slotProps={{ transition: { onExited: focusGrid } }}
      >
        {choice !== null && (
          <MenuItem
            onClick={() => {
              void writeOne(choice.key, { [choice.column.key]: null })
              setChoice(null)
            }}
          >
            —
          </MenuItem>
        )}
        {(choice?.column.options ?? []).map((option) => (
          <MenuItem
            key={option}
            selected={byKey.get(choice?.key ?? '')?.cells[choice?.column.key ?? ''] === option}
            onClick={() => {
              if (choice) void writeOne(choice.key, { [choice.column.key]: option })
              setChoice(null)
            }}
          >
            {option}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  )
}

const cellSx = (width: number, align: 'left' | 'right' | 'center') => ({
  flex: 'none',
  width,
  height: ROW_H,
  px: 1.5,
  display: 'flex',
  alignItems: 'center',
  justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
  overflow: 'hidden',
  whiteSpace: 'nowrap' as const,
  textOverflow: 'ellipsis',
  fontVariantNumeric: align === 'right' ? 'tabular-nums' : undefined,
  borderRight: 1,
  borderColor: 'divider',
  fontSize: 14,
})

function GridRow({
  artifactId,
  row,
  index,
  top,
  columns,
  offsets,
  pinned,
  held,
  rect,
  focus,
  editing,
  draft,
  onDraft,
  onFinish,
  onCancel,
  onMouseDown,
  onDoubleClick,
  onToggle,
}: {
  artifactId: string
  row: TableRow
  index: number
  top: number
  columns: ArtifactColumn[]
  offsets: number[]
  pinned: number
  held: boolean
  rect: TableRect
  focus: Cursor
  editing: Editing | null
  draft: string
  onDraft: (text: string) => void
  onFinish: (move: Cursor | null) => void
  onCancel: () => void
  onMouseDown: (column: number, extend: boolean) => void
  onDoubleClick: () => void
  onToggle: (column: ArtifactColumn) => void
}) {
  const inRows = index >= rect.r0 && index <= rect.r1
  return (
    <Box
      role="row"
      aria-rowindex={index + 2}
      data-row={row.key}
      sx={{
        position: 'absolute',
        top: 0,
        left: 0,
        display: 'flex',
        height: ROW_H,
        transform: `translateY(${top}px)`,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: held ? (theme) => alpha(theme.palette.warning.main, 0.08) : 'background.paper',
      }}
    >
      <Box
        role="rowheader"
        aria-colindex={1}
        sx={{
          ...cellSx(NUMBER_W, 'right'),
          position: 'sticky',
          left: 0,
          zIndex: 2,
          bgcolor: 'inherit',
          color: 'text.secondary',
        }}
        title={held ? tableTexts.held : undefined}
      >
        {index + 1}
      </Box>
      {columns.map((column, c) => {
        const selected = inRows && c >= rect.c0 && c <= rect.c1
        const active = focus.r === index && focus.c === c
        const value: ArtifactCell | undefined = row.cells[column.key]
        const isEditing = editing?.column.key === column.key
        return (
          <Box
            key={column.key}
            id={cellId(artifactId, row.key, column.key)}
            role="gridcell"
            aria-colindex={c + 2}
            aria-selected={selected}
            data-active={active}
            onMouseDown={(event) => {
              if (isEditing) return
              event.preventDefault()
              onMouseDown(c, event.shiftKey)
            }}
            onDoubleClick={onDoubleClick}
            sx={{
              ...cellSx(widthOf(column), alignOf(column)),
              position: c < pinned ? 'sticky' : 'relative',
              left: c < pinned ? offsets[c] : undefined,
              zIndex: c < pinned ? 1 : undefined,
              bgcolor: selected
                ? (theme) => alpha(theme.palette.primary.main, active ? 0.16 : 0.08)
                : 'background.paper',
              outline: active ? 2 : 0,
              outlineOffset: -2,
              outlineColor: 'primary.main',
              outlineStyle: active ? 'solid' : 'none',
              cursor: 'cell',
            }}
          >
            {isEditing ? (
              <InputBase
                autoFocus
                fullWidth
                value={draft}
                onChange={(event) => onDraft(event.target.value)}
                onBlur={() => onFinish(null)}
                inputProps={{
                  'aria-label': column.name,
                  inputMode:
                    column.type === 'money' || column.type === 'number' ? 'decimal' : undefined,
                  style: { textAlign: alignOf(column) },
                }}
                onKeyDown={(event) => {
                  if (event.code === 'Escape') {
                    event.preventDefault()
                    onCancel()
                  } else if (event.code === 'Enter' || event.code === 'NumpadEnter') {
                    event.preventDefault()
                    onFinish({ r: index + 1, c })
                  } else if (event.code === 'Tab') {
                    event.preventDefault()
                    onFinish({ r: index, c: c + (event.shiftKey ? -1 : 1) })
                  }
                }}
                sx={{ fontSize: 14 }}
              />
            ) : column.type === 'checkbox' ? (
              <Checkbox
                size="small"
                checked={value === true}
                tabIndex={-1}
                onMouseDown={(event) => event.stopPropagation()}
                onChange={() => onToggle(column)}
                slotProps={{ input: { 'aria-label': column.name } }}
              />
            ) : (
              tableCellText(column, value)
            )}
          </Box>
        )
      })}
    </Box>
  )
}
