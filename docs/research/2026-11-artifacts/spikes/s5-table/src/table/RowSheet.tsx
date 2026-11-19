import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Drawer from '@mui/material/Drawer'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useEffect, useState } from 'react'
import { track } from '../instrument'
import { type CellValue, type ColumnId, columnById, parseCell, plainCell, type PriceRow } from './model'
import type { RowStore } from './store'

export interface RowSheetProps {
  store: RowStore
  rowId: string | null
  onClose(): void
}

type Draft = Record<Exclude<ColumnId, 'inStock'>, string> & { inStock: boolean }

function draftOf(row: PriceRow): Draft {
  const text = (id: Exclude<ColumnId, 'inStock'>) => plainCell(columnById.get(id)!, row)
  return {
    name: text('name'),
    category: text('category'),
    unit: text('unit'),
    price: text('price'),
    note: text('note'),
    inStock: row.inStock,
  }
}

/** Editing a row on a phone: a sheet from below with every field of the row. */
export function RowSheet({ store, rowId, onClose }: RowSheetProps) {
  const row = rowId ? store.get(rowId) : undefined
  const [draft, setDraft] = useState<Draft | null>(null)
  const [errors, setErrors] = useState<Partial<Record<ColumnId, string>>>({})

  useEffect(() => {
    setDraft(row ? draftOf(row) : null)
    setErrors({})
    // Only when another row is opened: a change of this row by someone else keeps the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId])

  const save = (t0: number) => {
    if (!row || !draft) return
    const cells: Partial<Record<ColumnId, CellValue>> = {}
    const found: Partial<Record<ColumnId, string>> = {}
    for (const id of ['name', 'category', 'unit', 'price', 'note'] as const) {
      const parsed = parseCell(columnById.get(id)!, draft[id])
      if (parsed.ok) cells[id] = parsed.value
      else found[id] = parsed.reason
    }
    cells.inStock = draft.inStock
    if (Object.keys(found).length > 0) {
      setErrors(found)
      return
    }
    store.applyLocal('Правка', [{ id: row.id, cells }])
    track('sheetSave', t0)
    onClose()
  }

  const field = (id: Exclude<ColumnId, 'inStock' | 'category'>, extra: object = {}) => (
    <TextField
      label={columnById.get(id)!.label}
      value={draft?.[id] ?? ''}
      onChange={(e) => setDraft((d) => (d ? { ...d, [id]: e.target.value } : d))}
      error={Boolean(errors[id])}
      helperText={errors[id]}
      fullWidth
      size="small"
      {...extra}
    />
  )

  return (
    <Drawer
      anchor="bottom"
      open={Boolean(row && draft)}
      onClose={onClose}
      transitionDuration={{ enter: 160, exit: 120 }}
      slotProps={{ paper: { sx: { borderRadius: '16px 16px 0 0', maxHeight: '90dvh' }, 'data-sheet': '' } as object }}
    >
      {row && draft ? (
        <Box component="form" onSubmit={(e) => { e.preventDefault(); save(e.timeStamp) }} sx={{ p: 2, pb: 'calc(16px + env(safe-area-inset-bottom))' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
            Строка {store.order.indexOf(row.id) + 1}
          </Typography>
          <Stack spacing={1.5}>
            {field('name')}
            <TextField
              select
              label="Категория"
              value={draft.category}
              onChange={(e) => setDraft((d) => (d ? { ...d, category: e.target.value } : d))}
              slotProps={{ select: { native: true } }}
              size="small"
              fullWidth
            >
              <option value="">Без категории</option>
              {columnById.get('category')!.options!.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </TextField>
            <Stack direction="row" spacing={1.5}>
              {field('unit')}
              {field('price', {
                slotProps: { htmlInput: { inputMode: 'decimal', enterKeyHint: 'done', 'data-field': 'price' } },
                autoFocus: true,
              })}
            </Stack>
            <FormControlLabel
              control={<Switch checked={draft.inStock} onChange={(e) => setDraft((d) => (d ? { ...d, inStock: e.target.checked } : d))} />}
              label="В наличии"
            />
            {field('note', { multiline: true, maxRows: 4 })}
          </Stack>
          <Stack direction="row" spacing={1} sx={{ mt: 2, justifyContent: 'flex-end' }}>
            <Button onClick={onClose} sx={{ minHeight: 44 }}>
              Отмена
            </Button>
            <Button type="submit" variant="contained" sx={{ minHeight: 44 }}>
              Сохранить
            </Button>
          </Stack>
        </Box>
      ) : null}
    </Drawer>
  )
}
