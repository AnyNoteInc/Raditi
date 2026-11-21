'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Drawer from '@mui/material/Drawer'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import {
  parseTableCell,
  tableCellPlain,
  tableCellText,
  type ArtifactCells,
  type ArtifactColumn,
  type TableRow,
} from '@repo/domain/artifacts'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef, useState } from 'react'

import { cardColumnsOf } from './table-model'
import { tableTexts } from './table-texts'
import type { TableState } from './use-table'

// The table in a narrow area (docs/plan/88-artifacts.md, §7.7; spike 5): a card a row — its name,
// its sum, its choice and unit, the switch of its flag —, the rest of the row in a sheet from
// below, with its heading, the sum typed on the digits of the phone (`inputmode="decimal"`).

const CARD_H = 76
const GAP = 8

export function TableCards({
  title,
  state,
  view,
  onMessage,
}: {
  title: string
  state: TableState
  view: string[]
  onMessage: (text: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const byKey = useMemo(() => new Map(state.rows.map((row) => [row.key, row])), [state.rows])
  const card = useMemo(() => cardColumnsOf(state.columns), [state.columns])
  const [open, setOpen] = useState<string | null>(null)
  // TanStack Virtual returns fresh functions each render: the compiler leaves this component be.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => CARD_H + GAP,
    // Before the first measure (and where nothing is measured, as in tests): a screenful of rows.
    initialRect: { width: 1000, height: 640 },
    overscan: 6,
    paddingStart: GAP,
    getItemKey: (index) => view[index] ?? index,
  })
  const items = virtualizer.getVirtualItems()
  return (
    <Box
      ref={scroller}
      sx={{ position: 'relative', height: '100%', minHeight: 320, overflow: 'auto' }}
    >
      <Box
        role="list"
        aria-label={tableTexts.cards(title)}
        sx={{ position: 'relative', height: virtualizer.getTotalSize() }}
      >
        {items.map((item) => {
          const key = view[item.index]
          const row = key === undefined ? undefined : byKey.get(key)
          if (!row) return null
          const name =
            (card.name ? tableCellText(card.name, row.cells[card.name.key]) : '') ||
            tableTexts.untitledRow
          const money = card.money ? tableCellText(card.money, row.cells[card.money.key]) : ''
          const price = money === '' ? tableTexts.noPrice : `${money} ₽`
          const meta = [card.choice, card.unit]
            .flatMap((column) => (column ? [tableCellText(column, row.cells[column.key])] : []))
            .filter(Boolean)
            .join(' · ')
          return (
            <Box
              key={row.key}
              role="listitem"
              aria-setsize={view.length}
              aria-posinset={item.index + 1}
              data-row={row.key}
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: CARD_H,
                transform: `translateY(${item.start}px)`,
                display: 'flex',
                borderRadius: '14px',
                border: 1,
                borderColor: state.held.has(row.key) ? 'warning.main' : 'divider',
                bgcolor: 'background.paper',
                overflow: 'hidden',
              }}
            >
              <Box
                component="button"
                type="button"
                onClick={() => setOpen(row.key)}
                // The name of the button is its visible text (WCAG 2.5.3), the way to change it last.
                aria-label={tableTexts.openRow(name, price)}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  alignContent: 'center',
                  columnGap: 1.5,
                  rowGap: 0.5,
                  px: 1.75,
                  border: 0,
                  bgcolor: 'transparent',
                  textAlign: 'left',
                  font: 'inherit',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <Box
                  component="span"
                  sx={{
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {name}
                </Box>
                <Box component="span" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {money === '' ? '—' : `${money} ₽`}
                </Box>
                <Box
                  component="span"
                  sx={{
                    gridColumn: '1 / -1',
                    fontSize: 13,
                    color: 'text.secondary',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {meta}
                </Box>
              </Box>
              {card.flag && (
                <Box
                  component="label"
                  sx={{
                    flex: 'none',
                    width: 76,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderLeft: 1,
                    borderColor: 'divider',
                  }}
                >
                  <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.2 }}>
                    {card.flag.name}
                  </Typography>
                  <Switch
                    checked={row.cells[card.flag.key] === true}
                    disabled={!state.canEdit}
                    onChange={() => {
                      const flag = card.flag!
                      void state
                        .writeCells([
                          { key: row.key, cells: { [flag.key]: !(row.cells[flag.key] === true) } },
                        ])
                        .then((result) => result.skipped.length > 0 && onMessage(tableTexts.held))
                        .catch(() => onMessage(tableTexts.saveFailed))
                    }}
                    slotProps={{ input: { 'aria-label': `${card.flag.name}: ${name}` } }}
                  />
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
      {view.length === 0 && (
        <Box sx={{ p: 3, color: 'text.secondary' }}>
          {state.rows.length === 0 ? tableTexts.empty : tableTexts.nothingFound}
        </Box>
      )}
      <RowSheet
        key={open ?? ''}
        state={state}
        row={open === null ? null : (byKey.get(open) ?? null)}
        nameColumn={card.name}
        onClose={() => setOpen(null)}
        onMessage={onMessage}
      />
    </Box>
  )
}

/** A row on a phone: a sheet from below with every field of the row (spike 5). */
function RowSheet({
  state,
  row,
  nameColumn,
  onClose,
  onMessage,
}: {
  state: TableState
  row: TableRow | null
  nameColumn: ArtifactColumn | null
  onClose: () => void
  onMessage: (text: string) => void
}) {
  // The draft of the row as it opened (the sheet is keyed by the row): a change of this row by
  // someone else keeps the draft.
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() => {
    const next: Record<string, string | boolean> = {}
    if (row)
      for (const column of state.columns)
        next[column.key] =
          column.type === 'checkbox'
            ? row.cells[column.key] === true
            : tableCellPlain(column, row.cells[column.key])
    return next
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  if (!row) return <Drawer anchor="bottom" open={false} onClose={onClose} />
  const name =
    (nameColumn ? tableCellText(nameColumn, row.cells[nameColumn.key]) : '') ||
    tableTexts.untitledRow
  const headingId = `table-sheet-${row.key}`

  const save = async () => {
    const cells: ArtifactCells = {}
    const found: Record<string, string> = {}
    for (const column of state.columns) {
      if (column.type === 'image') continue
      const value = draft[column.key]
      if (column.type === 'checkbox') {
        cells[column.key] = value === true
        continue
      }
      const parsed = parseTableCell(column, typeof value === 'string' ? value : '')
      if (parsed.ok) cells[column.key] = parsed.value
      else found[column.key] = parsed.reason
    }
    if (Object.keys(found).length > 0) {
      setErrors(found)
      return
    }
    const changed: ArtifactCells = {}
    for (const [column, value] of Object.entries(cells))
      if ((row.cells[column] ?? null) !== value) changed[column] = value
    try {
      const result = await state.writeCells([{ key: row.key, cells: changed }])
      if (result.skipped.length > 0) onMessage(tableTexts.held)
      onClose()
    } catch {
      onMessage(tableTexts.saveFailed)
    }
  }

  return (
    <Drawer
      anchor="bottom"
      open
      onClose={onClose}
      slotProps={{
        paper: {
          role: 'dialog',
          'aria-labelledby': headingId,
          sx: { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '90dvh' },
        },
      }}
    >
      <Stack spacing={2} sx={{ p: 2, pb: 'max(16px, env(safe-area-inset-bottom))' }}>
        <Typography id={headingId} component="h2" sx={{ fontSize: 18, fontWeight: 650 }}>
          {tableTexts.rowOf(name)}
        </Typography>
        {state.held.has(row.key) && <Alert severity="warning">{tableTexts.held}</Alert>}
        {state.columns.map((column) =>
          column.type === 'image' ? null : column.type === 'checkbox' ? (
            <FormControlLabel
              key={column.key}
              label={column.name}
              control={
                <Switch
                  checked={draft[column.key] === true}
                  disabled={!state.canEdit}
                  onChange={(event) => setDraft({ ...draft, [column.key]: event.target.checked })}
                />
              }
            />
          ) : (
            <TextField
              key={column.key}
              label={column.name}
              select={column.type === 'select'}
              disabled={!state.canEdit}
              multiline={column.type === 'text'}
              maxRows={6}
              value={(draft[column.key] as string | undefined) ?? ''}
              error={errors[column.key] !== undefined}
              helperText={errors[column.key]}
              onChange={(event) => setDraft({ ...draft, [column.key]: event.target.value })}
              slotProps={{
                htmlInput: {
                  inputMode:
                    column.type === 'money' || column.type === 'number'
                      ? 'decimal'
                      : column.type === 'link'
                        ? 'url'
                        : undefined,
                },
              }}
            >
              {column.type === 'select'
                ? ['', ...(column.options ?? [])].map((option) => (
                    <MenuItem key={option} value={option}>
                      {option === '' ? '—' : option}
                    </MenuItem>
                  ))
                : null}
            </TextField>
          ),
        )}
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between' }}>
          {state.canEdit ? (
            <Button
              color="error"
              onClick={() => {
                void state.deleteRows([row.key]).catch(() => onMessage(tableTexts.saveFailed))
                onClose()
              }}
            >
              {tableTexts.removeRow}
            </Button>
          ) : (
            <span />
          )}
          <Stack direction="row" spacing={1}>
            <Button onClick={onClose}>{tableTexts.cancel}</Button>
            {state.canEdit && (
              <Button variant="contained" onClick={() => void save()}>
                {tableTexts.save}
              </Button>
            )}
          </Stack>
        </Stack>
      </Stack>
    </Drawer>
  )
}
