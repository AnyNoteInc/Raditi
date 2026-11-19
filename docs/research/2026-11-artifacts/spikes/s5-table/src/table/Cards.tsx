import { styled } from '@mui/material/styles'
import Switch from '@mui/material/Switch'
import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { afterPaint, mark, spike, track } from '../instrument'
import { formatRubles } from './model'
import type { RowStore } from './store'
import { useRow } from './useRow'

export const CARD_H = 76
const GAP = 8

export interface CardsProps {
  store: RowStore
  view: string[]
  label: string
  bottomInset: number
  onOpen(id: string, t0: number): void
}

/**
 * The phone form of the table: a card per row, the two things a price list changes most often
 * (the price and «В наличии») on the card itself, everything else in a sheet from below.
 */
export function Cards({ store, view, label, bottomInset, onOpen }: CardsProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => CARD_H + GAP,
    overscan: 6,
    paddingStart: GAP,
    paddingEnd: bottomInset,
    getItemKey: (i) => view[i] ?? i,
  })
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
  useEffect(() => {
    spike.cards = { scroller: () => scrollerRef.current, scrollToIndex: (i: number) => virtualizer.scrollToIndex(i) }
  })

  return (
    <CardsRoot ref={scrollerRef} data-cards="">
      <div role="list" aria-label={label} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((item) => {
          const id = view[item.index]
          if (!id) return null
          return <Card key={id} id={id} index={item.index} count={view.length} top={item.start} store={store} onOpen={onOpen} />
        })}
      </div>
      {view.length === 0 ? <div className="empty">Ничего не нашлось</div> : null}
    </CardsRoot>
  )
}

interface CardProps {
  id: string
  index: number
  count: number
  top: number
  store: RowStore
  onOpen(id: string, t0: number): void
}

const Card = memo(function Card({ id, index, count, top, store, onOpen }: CardProps) {
  const row = useRow(store, id)
  if (!row) return null
  const meta = [row.category, row.unit, row.note].filter(Boolean).join(' · ')
  return (
    <div role="listitem" aria-setsize={count} aria-posinset={index + 1} className="card" style={{ transform: `translateY(${top}px)` }} data-row={id}>
      <button type="button" className="main" onClick={(e) => onOpen(id, e.timeStamp)} aria-label={`${row.name || 'Без названия'}, ${row.price === '' ? 'без цены' : `${formatRubles(row.price)} ₽`}. Изменить`}>
        <span className="name">{row.name || 'Без названия'}</span>
        <span className="price">{row.price === '' ? '—' : `${formatRubles(row.price)} ₽`}</span>
        <span className="meta">{meta}</span>
      </button>
      <label className="stock">
        <span className="stockLabel">{row.inStock ? 'Есть' : 'Нет'}</span>
        <Switch
          checked={row.inStock}
          onChange={(e) => {
            store.applyLocal('Наличие', [{ id, cells: { inStock: !row.inStock } }])
            track('toggle', e.timeStamp)
          }}
          slotProps={{ input: { 'aria-label': `В наличии: ${row.name || 'без названия'}` } }}
        />
      </label>
    </div>
  )
})

const CardsRoot = styled('div')(({ theme }) => ({
  position: 'relative',
  height: '100%',
  overflow: 'auto',
  overscrollBehavior: 'contain',
  WebkitOverflowScrolling: 'touch',
  padding: '0 12px',
  '& .card': {
    position: 'absolute',
    top: 0,
    left: 12,
    right: 12,
    height: CARD_H,
    display: 'flex',
    alignItems: 'stretch',
    borderRadius: 14,
    background: theme.palette.background.paper,
    boxShadow: `0 0 0 1px ${theme.palette.divider}`,
    overflow: 'hidden',
  },
  '& .main': {
    flex: 1,
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gridTemplateRows: 'auto auto',
    alignContent: 'center',
    columnGap: 12,
    rowGap: 4,
    padding: '0 4px 0 14px',
    border: 0,
    background: 'transparent',
    textAlign: 'left',
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
    '&:active': { background: theme.palette.action.hover },
  },
  '& .name': { fontWeight: 600, fontSize: 15, lineHeight: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  '& .price': { fontWeight: 600, fontSize: 15, lineHeight: '20px', fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
  '& .meta': {
    gridColumn: '1 / -1',
    fontSize: 13,
    lineHeight: '18px',
    color: theme.palette.text.secondary,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '& .stock': {
    flex: 'none',
    width: 76,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    borderLeft: `1px solid ${theme.palette.divider}`,
    cursor: 'pointer',
  },
  '& .stockLabel': { fontSize: 11, lineHeight: '14px', color: theme.palette.text.secondary },
  '& .empty': { padding: 24, color: theme.palette.text.secondary },
}))
