'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import {
  artifactColumnSchema,
  artifactKindSpecOf,
  tableCellText,
  tableCsv,
  tableOrder,
  type ArtifactCellAnchorInput,
  type ArtifactColumn,
  type ArtifactColumnType,
  type TableSort,
} from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import type { ArtifactBodyProps } from '../artifact-body-props'
import { ArtifactComments } from '../artifact-comments'
import { TableCards } from './table-cards'
import { TableGrid } from './table-grid'
import {
  layoutOf,
  newRowKey,
  readLayout,
  shownColumns,
  storeLayout,
  type ColumnLayout,
} from './table-model'
import { columnTypeTexts, tableTexts } from './table-texts'
import { useTable } from './use-table'

// «Таблица» (docs/plan/88-artifacts.md, §7.7, §7.13; slice 88.14; board C-table and spike 5): the
// grid by the width of its own area — at least 600 px, like «Документы»; narrower — cards. The
// order of rows is the cabinet's: sorting and the search apply when the person asks, and an edit,
// theirs or another's, moves no row — «Порядок не обновлён — обновить». The totals are the
// server's. «Скачать»: CSV here, Excel built by core (question 26).

/** The width of its own area below which the table is cards (§7.7). */
export const TABLE_CARDS_BELOW = 600
const XLSX_POLL_MS = 1000
const XLSX_POLLS = 60

/** The width of an element, followed as it changes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function ArtifactTable({
  artifact,
  onChanged,
  onAccessLost,
}: ArtifactBodyProps & { onAccessLost?: () => void }) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const state = useTable(artifact, onChanged)
  // Private notes to a cell (88.18д): the owner's, as the notes to a quote of a document.
  const canComment =
    artifact.role === 'owner' && artifactKindSpecOf(artifact.kind)?.notes === 'cell'
  const [activeCell, setActiveCell] = useState<{ row: string; column: string } | null>(null)
  const onActiveCell = useCallback(
    (cell: { row: string; column: string } | null) => setActiveCell(cell),
    [],
  )
  const [commentDraft, setCommentDraft] = useState<{
    anchor: ArtifactCellAnchorInput
    label: string
  } | null>(null)
  const noteToCell = () => {
    const row = state.rows.find((each) => each.key === activeCell?.row)
    const column = state.columns.find((each) => each.key === activeCell?.column)
    if (!row || !column) return
    const text = tableCellText(column, row.cells[column.key])
    setCommentDraft({
      anchor: { kind: 'cell', block: row.key, column: column.key, rev: row.rev },
      label: `${column.name}: ${text || 'пустая ячейка'}`,
    })
  }
  const { ref, width } = useWidth()
  const [stored, setStored] = useState<Partial<ColumnLayout> | null>(() =>
    typeof window === 'undefined' ? null : readLayout(artifact.id),
  )
  // The layout of the columns there are now: a new column shows, a removed one is forgotten.
  const layout = useMemo(() => layoutOf(state.columns, stored), [state.columns, stored])
  const changeLayout = (next: ColumnLayout) => {
    setStored(next)
    storeLayout(artifact.id, next)
  }
  const columns = useMemo(() => shownColumns(state.columns, layout), [state.columns, layout])
  const pinned = columns.filter((column) => layout.pinned.includes(column.key)).length

  // The order of the screen: computed when asked, kept after; new rows join at the end.
  const [sort, setSort] = useState<TableSort[]>([])
  const [search, setSearch] = useState('')
  const [order, setOrder] = useState<string[]>(() =>
    tableOrder({ rows: state.rows, columns: state.columns, sort: [], search: '' }),
  )
  const fresh = useMemo(
    () => tableOrder({ rows: state.rows, columns: state.columns, sort, search }),
    [state.rows, state.columns, sort, search],
  )
  const view = useMemo(() => {
    const known = new Set(state.rows.map((row) => row.key))
    const kept = order.filter((key) => known.has(key))
    const shown = new Set(kept)
    const searching = search.trim() !== ''
    // A new row joins at the end, unless a search is on and it does not match.
    const filtered = new Set(fresh)
    for (const row of state.rows)
      if (!shown.has(row.key) && !order.includes(row.key) && (!searching || filtered.has(row.key)))
        kept.push(row.key)
    return kept
  }, [order, state.rows, fresh, search])
  const stale = (sort.length > 0 || search.trim() !== '') && fresh.join('\n') !== view.join('\n')
  const apply = (nextSort: TableSort[], nextSearch: string) => {
    setSort(nextSort)
    setSearch(nextSearch)
    setOrder(
      tableOrder({ rows: state.rows, columns: state.columns, sort: nextSort, search: nextSearch }),
    )
  }

  const totals = useQuery({
    ...trpc.artifact.tableTotals.queryOptions({
      artifactId: artifact.id,
      rows: search.trim() === '' ? null : view,
    }),
    // The totals of the checked text: read again with the artifact.
    staleTime: 0,
  })
  useEffect(() => {
    void totals.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.seq])

  const [message, setMessage] = useState<string | null>(null)
  const [header, setHeader] = useState<{ column: ArtifactColumn; at: HTMLElement } | null>(null)
  const [columnsMenu, setColumnsMenu] = useState<HTMLElement | null>(null)
  const [downloadMenu, setDownloadMenu] = useState<HTMLElement | null>(null)
  const [dialog, setDialog] = useState<{ column: ArtifactColumn | null } | null>(null)
  const exportStart = useMutation(trpc.artifact.exportStart.mutationOptions())
  const [preparing, setPreparing] = useState(false)

  const cards = width !== null && width < TABLE_CARDS_BELOW

  const addRow = () =>
    void state.writeCells([], [{}]).catch(() => setMessage(tableTexts.saveFailed))

  const rowsInView = () => {
    const byKey = new Map(state.rows.map((row) => [row.key, row]))
    return view.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []))
  }

  const csv = () =>
    download(
      new Blob([tableCsv(state.columns, rowsInView())], {
        type: 'text/csv;charset=utf-8',
      }),
      `${artifact.title}.csv`,
    )

  const xlsx = async () => {
    setPreparing(true)
    try {
      const { exportId } = await exportStart.mutateAsync({ artifactId: artifact.id })
      for (let poll = 0; poll < XLSX_POLLS; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, XLSX_POLL_MS))
        const { state: done } = await client.artifact.exportStatus.query({ exportId })
        if (done === 'ready') {
          const link = document.createElement('a')
          link.href = `/api/artifact-exports/${exportId}`
          document.body.append(link)
          link.click()
          link.remove()
          return
        }
        if (done === 'failed') break
      }
      setMessage(tableTexts.xlsxFailed)
    } catch {
      setMessage(tableTexts.xlsxFailed)
    } finally {
      setPreparing(false)
    }
  }

  const moveColumn = (key: string, by: -1 | 1) => {
    const at = layout.order.indexOf(key)
    const to = at + by
    if (at < 0 || to < 0 || to >= layout.order.length) return
    const next = [...layout.order]
    next.splice(at, 1)
    next.splice(to, 0, key)
    changeLayout({ ...layout, order: next })
  }
  const toggle = (list: string[], key: string) =>
    list.includes(key) ? list.filter((each) => each !== key) : [...list, key]

  return (
    <Box
      ref={ref}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minHeight: 0, height: '100%' }}
    >
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          size="small"
          label={tableTexts.search}
          placeholder={tableTexts.searchPlaceholder}
          value={search}
          onChange={(event) => apply(sort, event.target.value)}
          sx={{ flex: '1 1 200px', maxWidth: 320 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <AppIcon name="search" size={16} />
                </InputAdornment>
              ),
            },
          }}
        />
        <TextField
          select
          size="small"
          label={tableTexts.sort}
          value={sort[0] ? `${sort[0].key}:${sort[0].desc ? 'desc' : 'asc'}` : ''}
          onChange={(event) => {
            const [key, direction] = event.target.value.split(':')
            apply(key ? [{ key, desc: direction === 'desc' }] : [], search)
          }}
          sx={{ minWidth: 200 }}
        >
          <MenuItem value="">{tableTexts.sortNone}</MenuItem>
          {state.columns.flatMap((column) => [
            <MenuItem key={`${column.key}:asc`} value={`${column.key}:asc`}>
              {tableTexts.sortAsc(column.name)}
            </MenuItem>,
            <MenuItem key={`${column.key}:desc`} value={`${column.key}:desc`}>
              {tableTexts.sortDesc(column.name)}
            </MenuItem>,
          ])}
        </TextField>
        {stale && (
          <Alert
            severity="info"
            sx={{ py: 0 }}
            action={
              <Button size="small" onClick={() => apply(sort, search)}>
                {tableTexts.restore}
              </Button>
            }
          >
            {tableTexts.stale}
          </Alert>
        )}
        <Box sx={{ flex: '1 1 0' }} />
        {!cards && (
          <Button
            variant="text"
            color="inherit"
            startIcon={<AppIcon name="layers" size={16} />}
            onClick={(event) => setColumnsMenu(event.currentTarget)}
          >
            {tableTexts.columns}
          </Button>
        )}
        {state.canEdit && (
          <Button variant="text" color="inherit" onClick={() => setDialog({ column: null })}>
            {tableTexts.addColumn}
          </Button>
        )}
        {state.canEdit && state.columns.length > 0 && (
          <Button variant="outlined" startIcon={<AppIcon name="plus" size={16} />} onClick={addRow}>
            {tableTexts.addRow}
          </Button>
        )}
        {canComment && !cards && (
          <Button variant="text" color="inherit" disabled={!activeCell} onClick={noteToCell}>
            Заметка к ячейке
          </Button>
        )}
        <Button
          variant="text"
          color="inherit"
          startIcon={<AppIcon name="download" size={16} />}
          disabled={preparing}
          onClick={(event) => setDownloadMenu(event.currentTarget)}
        >
          {preparing ? tableTexts.xlsxWaiting : tableTexts.download}
        </Button>
      </Stack>
      {canComment && (
        <ArtifactComments
          key={artifact.id}
          artifact={artifact}
          draft={commentDraft?.anchor ?? null}
          draftLabel={commentDraft?.label}
          onClose={() => setCommentDraft(null)}
          onChanged={onChanged}
          onAccessLost={onAccessLost ?? (() => {})}
        />
      )}
      {!state.canEdit && <Alert severity="info">{tableTexts.readOnly}</Alert>}
      {state.columns.length === 0 ? (
        <Alert severity="info">{tableTexts.noColumns}</Alert>
      ) : (
        <Box sx={{ flex: '1 1 auto', minHeight: 320, height: cards ? 'auto' : 'min(70vh, 720px)' }}>
          {cards ? (
            <TableCards title={artifact.title} state={state} view={view} onMessage={setMessage} />
          ) : (
            <TableGrid
              artifactId={artifact.id}
              title={artifact.title}
              state={state}
              columns={columns}
              pinned={pinned}
              view={view}
              totals={totals.data?.totals ?? {}}
              onMessage={setMessage}
              onHeader={(column, at) => setHeader({ column, at })}
              onActiveCell={canComment ? onActiveCell : undefined}
            />
          )}
        </Box>
      )}

      <Menu open={header !== null} anchorEl={header?.at ?? null} onClose={() => setHeader(null)}>
        {header && [
          <MenuItem
            key="asc"
            onClick={() => {
              apply([{ key: header.column.key, desc: false }], search)
              setHeader(null)
            }}
          >
            {tableTexts.sortAsc(header.column.name)}
          </MenuItem>,
          <MenuItem
            key="desc"
            onClick={() => {
              apply([{ key: header.column.key, desc: true }], search)
              setHeader(null)
            }}
          >
            {tableTexts.sortDesc(header.column.name)}
          </MenuItem>,
          <MenuItem
            key="hide"
            onClick={() => {
              changeLayout({ ...layout, hidden: toggle(layout.hidden, header.column.key) })
              setHeader(null)
            }}
          >
            {tableTexts.hideColumn}
          </MenuItem>,
          ...(state.canEdit
            ? [
                <MenuItem
                  key="rename"
                  onClick={() => {
                    setDialog({ column: header.column })
                    setHeader(null)
                  }}
                >
                  {tableTexts.renameColumn}
                </MenuItem>,
                <MenuItem
                  key="remove"
                  onClick={() => {
                    const key = header.column.key
                    setHeader(null)
                    void state
                      .writeColumns(state.columns.filter((column) => column.key !== key))
                      .catch(() => setMessage(tableTexts.saveFailed))
                  }}
                >
                  {tableTexts.removeColumn}
                </MenuItem>,
              ]
            : []),
        ]}
      </Menu>

      <Menu open={columnsMenu !== null} anchorEl={columnsMenu} onClose={() => setColumnsMenu(null)}>
        {layout.order.map((key) => {
          const column = state.columns.find((each) => each.key === key)
          if (!column) return null
          return (
            <MenuItem key={key} disableRipple sx={{ gap: 0.5 }}>
              <Checkbox
                size="small"
                checked={!layout.hidden.includes(key)}
                onChange={() => changeLayout({ ...layout, hidden: toggle(layout.hidden, key) })}
                slotProps={{ input: { 'aria-label': tableTexts.show(column.name) } }}
              />
              <ListItemText primary={column.name} />
              <Tooltip title={tableTexts.pin(column.name)}>
                <IconButton
                  size="small"
                  aria-label={tableTexts.pin(column.name)}
                  aria-pressed={layout.pinned.includes(key)}
                  onClick={() => changeLayout({ ...layout, pinned: toggle(layout.pinned, key) })}
                  color={layout.pinned.includes(key) ? 'primary' : 'default'}
                >
                  <AppIcon name="pin" size={14} />
                </IconButton>
              </Tooltip>
              <IconButton
                size="small"
                aria-label={tableTexts.up(column.name)}
                onClick={() => moveColumn(key, -1)}
              >
                <Box
                  component="span"
                  aria-hidden
                  sx={{ display: 'inline-flex', transform: 'rotate(180deg)' }}
                >
                  <AppIcon name="down" size={14} />
                </Box>
              </IconButton>
              <IconButton
                size="small"
                aria-label={tableTexts.down(column.name)}
                onClick={() => moveColumn(key, 1)}
              >
                <AppIcon name="down" size={14} />
              </IconButton>
            </MenuItem>
          )
        })}
      </Menu>

      <Menu
        open={downloadMenu !== null}
        anchorEl={downloadMenu}
        onClose={() => setDownloadMenu(null)}
      >
        <MenuItem
          onClick={() => {
            setDownloadMenu(null)
            csv()
          }}
        >
          {tableTexts.csv}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setDownloadMenu(null)
            void xlsx()
          }}
        >
          {tableTexts.xlsx}
        </MenuItem>
      </Menu>

      {dialog !== null && (
        <ColumnDialog
          column={dialog.column}
          taken={state.columns.map((column) => column.key)}
          onClose={() => setDialog(null)}
          onSave={(column) => {
            setDialog(null)
            const next =
              dialog.column === null
                ? [...state.columns, column]
                : state.columns.map((each) => (each.key === column.key ? column : each))
            void state.writeColumns(next).catch(() => setMessage(tableTexts.saveFailed))
          }}
        />
      )}

      <Snackbar
        open={message !== null}
        autoHideDuration={6000}
        onClose={() => setMessage(null)}
        message={message}
      />
    </Box>
  )
}

/** «Добавить столбец» and «Переименовать столбец»: a name, a kind, the options of a choice. */
function ColumnDialog({
  column,
  taken,
  onClose,
  onSave,
}: {
  column: ArtifactColumn | null
  taken: string[]
  onClose: () => void
  onSave: (column: ArtifactColumn) => void
}) {
  const [name, setName] = useState(column?.name ?? '')
  const [type, setType] = useState<ArtifactColumnType>(column?.type ?? 'text')
  const [options, setOptions] = useState((column?.options ?? []).join('\n'))
  const candidate = {
    key: column?.key ?? newRowKey().replace(/^r-/, 'c-'),
    name: name.trim(),
    type,
    ...(type === 'select'
      ? {
          options: options
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        }
      : {}),
  }
  const valid =
    artifactColumnSchema.safeParse(candidate).success &&
    (column !== null || !taken.includes(candidate.key))
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{column === null ? tableTexts.addColumn : tableTexts.renameColumn}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            autoFocus
            label={tableTexts.columnName}
            value={name}
            onChange={(event) => setName(event.target.value)}
            slotProps={{ htmlInput: { maxLength: 80 } }}
          />
          <TextField
            select
            label={tableTexts.columnType}
            value={type}
            disabled={column !== null}
            onChange={(event) => setType(event.target.value as ArtifactColumnType)}
          >
            {(Object.keys(columnTypeTexts) as (keyof typeof columnTypeTexts)[]).map((each) => (
              <MenuItem key={each} value={each}>
                {columnTypeTexts[each]}
              </MenuItem>
            ))}
          </TextField>
          {type === 'select' && (
            <TextField
              multiline
              minRows={3}
              label={tableTexts.columnOptions}
              value={options}
              onChange={(event) => setOptions(event.target.value)}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{tableTexts.cancel}</Button>
        <Button variant="contained" disabled={!valid} onClick={() => onSave(candidate)}>
          {tableTexts.save}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
