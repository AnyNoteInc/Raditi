import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { spike, track } from '../instrument'
import type { Totals } from '../server/stub'
import { Cards } from './Cards'
import { downloadCsv, downloadXlsx } from './export'
import { Grid } from './Grid'
import { PlusIcon } from './icons'
import { formatRubles, LIMITS, type PriceRow } from './model'
import { RowSheet } from './RowSheet'
import type { RowStore } from './store'
import { Toolbar } from './Toolbar'
import { computeView, type Filters, NO_FILTERS, type Sorting, touchesView } from './view'

export interface PriceTableProps {
  store: RowStore
  title: string
  mode: 'auto' | 'grid' | 'cards'
  checkbox: 'mui' | 'plain'
  subscribeTotals(listener: (t: Totals) => void): () => void
}

/** The same 600 px as `useWide(root, 600)` of the «Документы» pane in the cabinet. */
const NARROW = 600

/** Narrow by the width of the table's own box, not of the screen: the pane next to a chat is narrow too. */
function useNarrow(ref: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setNarrow(el.clientWidth < NARROW)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return narrow
}

/** Rows that appeared or went away, without moving the others. */
function reconcile(view: string[], store: RowStore): string[] {
  const inView = new Set(view)
  const next = view.filter((id) => store.rows.has(id))
  for (const id of store.order) {
    if (inView.has(id)) continue
    const after = store.placement.get(id)
    store.placement.delete(id)
    const at = after ? next.indexOf(after) : -1
    if (at >= 0) next.splice(at + 1, 0, id)
    else next.push(id)
  }
  return next
}

export function PriceTable({ store, title, mode, checkbox, subscribeTotals }: PriceTableProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const autoNarrow = useNarrow(boxRef)
  const narrow = mode === 'auto' ? autoNarrow : mode === 'cards'
  const [sorting, setSorting] = useState<Sorting>([])
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [view, setView] = useState<string[]>(() => computeView(store, [], NO_FILTERS))
  const [stale, setStale] = useState(false)
  const [totals, setTotals] = useState<Totals | null>(null)
  const [message, setMessage] = useState('')
  const [sheetRow, setSheetRow] = useState<string | null>(null)
  const ordering = useRef({ sorting, filters })
  ordering.current = { sorting, filters }

  useEffect(() => subscribeTotals(setTotals), [subscribeTotals])
  useEffect(() => store.subscribeShape(() => setView((v) => reconcile(v, store))), [store])
  useEffect(
    () =>
      store.onCells((changes) => {
        const { sorting: s, filters: f } = ordering.current
        const columns = new Set(changes.flatMap((c) => Object.keys(c.cells)))
        if (touchesView(columns, s, f)) setStale(true)
      }),
    [store],
  )

  const reorder = useCallback(
    (nextSorting: Sorting, nextFilters: Filters, name: string, t0: number) => {
      const started = performance.now()
      const next = computeView(store, nextSorting, nextFilters)
      spike.lastViewMs = performance.now() - started
      setSorting(nextSorting)
      setFilters(nextFilters)
      setView(next)
      setStale(false)
      track(name, t0)
    },
    [store],
  )

  const onNotice = useCallback((text: string) => {
    setMessage(text)
    spike.notices.push(text)
  }, [])

  const addRow = () => {
    if (store.rows.size >= LIMITS.rows) {
      onNotice(`В таблице не больше ${LIMITS.rows.toLocaleString('ru-RU')} строк`)
      return
    }
    const focused = (spike.grid as { focused(): { rowId: string } | null } | undefined)?.focused()
    const after = focused?.rowId ?? store.order.at(-1) ?? null
    const row: PriceRow = { id: store.newRowId(), name: '', category: '', unit: 'шт', price: '', inStock: true, note: '' }
    store.placement.set(row.id, after)
    store.applyLocal('Новая строка', [], [{ after, row }])
    requestAnimationFrame(() => {
      const ids = spike.view as string[]
      const index = ids.indexOf(row.id)
      if (narrow) setSheetRow(row.id)
      else (spike.grid as { edit(i: number, c: string): void } | undefined)?.edit(index, 'name')
    })
  }

  const download = async (kind: 'csv' | 'xlsx') => {
    const rows = view.map((id) => store.get(id)).filter((r): r is PriceRow => Boolean(r))
    if (kind === 'csv') {
      downloadCsv(rows, title)
      return
    }
    try {
      const ms = await downloadXlsx(rows, title)
      spike.lastXlsxMs = ms
    } catch (error) {
      spike.lastXlsxError = String(error)
      onNotice('Не получилось собрать файл Excel. Скачайте CSV или попробуйте ещё раз.')
    }
  }

  const totalsLine = totals
    ? `Строк: ${totals.rows.toLocaleString('ru-RU')} · в наличии: ${totals.inStock.toLocaleString('ru-RU')}${totals.average ? ` · средняя цена ${formatRubles(totals.average)} ₽` : ''}`
    : 'Считаем итоги…'

  return (
    <Box ref={boxRef} sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Toolbar
        narrow={narrow}
        title={title}
        count={view.length}
        total={store.rows.size}
        stale={stale}
        filters={filters}
        sorting={sorting}
        onRefresh={(t0) => reorder(sorting, filters, 'refresh', t0)}
        onFilters={(next, t0) => reorder(sorting, next, 'filter', t0)}
        onSorting={(next, t0) => reorder(next, filters, 'sort', t0)}
        onDownload={download}
      />
      <Box sx={{ flex: 1, minHeight: 0, borderTop: 1, borderColor: 'divider' }}>
        {narrow ? (
          <Cards store={store} view={view} label={title} bottomInset={88} onOpen={(id, t0) => { setSheetRow(id); track('sheetOpen', t0) }} />
        ) : (
          <Grid
            store={store}
            view={view}
            sorting={sorting}
            onSorting={(next, t0) => reorder(next, filters, 'sort', t0)}
            onNotice={onNotice}
            checkbox={checkbox}
            label={title}
          />
        )}
      </Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: narrow ? 1.5 : 2,
          py: 1,
          borderTop: 1,
          borderColor: 'divider',
          ...(narrow ? { position: 'fixed', left: 0, right: 0, bottom: 0, bgcolor: 'background.paper', pb: 'calc(8px + env(safe-area-inset-bottom))' } : {}),
        }}
      >
        <Button startIcon={<PlusIcon fontSize="small" />} onClick={addRow} size="small" sx={{ minHeight: 44 }} data-add-row="">
          Строка
        </Button>
        <Typography variant="caption" color="text.secondary" data-totals="" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {totalsLine}
        </Typography>
        <Typography variant="caption" role="status" aria-live="polite" sx={{ ml: 'auto', minWidth: 0 }} noWrap={!narrow} data-message="">
          {message}
        </Typography>
      </Box>
      {narrow ? <RowSheet store={store} rowId={sheetRow} onClose={() => setSheetRow(null)} /> : null}
    </Box>
  )
}
