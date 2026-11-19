import { type ColumnId, columnById, fold, kopecks, type PriceRow } from './model'
import type { RowStore } from './store'

export type Sorting = Array<{ id: string; desc: boolean }>
export type Stock = 'all' | 'yes' | 'no'

export interface Filters {
  search: string
  categories: readonly string[]
  stock: Stock
}

export const NO_FILTERS: Filters = { search: '', categories: [], stock: 'all' }

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })
const searchText = new WeakMap<PriceRow, string>()

function haystack(row: PriceRow): string {
  let text = searchText.get(row)
  if (text === undefined) {
    text = fold(`${row.name}\n${row.category}\n${row.unit}\n${row.note}`)
    searchText.set(row, text)
  }
  return text
}

export function matches(row: PriceRow, filters: Filters, words: string[]): boolean {
  if (filters.stock === 'yes' && !row.inStock) return false
  if (filters.stock === 'no' && row.inStock) return false
  if (filters.categories.length > 0 && !filters.categories.includes(row.category)) return false
  if (words.length === 0) return true
  const text = haystack(row)
  return words.every((w) => text.includes(w))
}

function compare(id: ColumnId, a: PriceRow, b: PriceRow): number {
  const column = columnById.get(id)
  if (!column) return 0
  switch (column.kind) {
    case 'money': {
      const x = kopecks(a.price)
      const y = kopecks(b.price)
      if (x === y) return 0
      if (x === null) return 1
      if (y === null) return -1
      return x < y ? -1 : 1
    }
    case 'checkbox':
      return Number(b.inStock) - Number(a.inStock)
    default:
      return collator.compare(a[id] as string, b[id] as string)
  }
}

/**
 * The order of rows on screen: filtered and sorted once, when the person asks. Edits after that
 * do not move rows (a row that no longer matches stays until the next sort or filter), so the
 * cursor and the rows around it stay where the person left them, also when others edit.
 */
export function computeView(store: RowStore, sorting: Sorting, filters: Filters): string[] {
  const words = fold(filters.search).split(/\s+/).filter(Boolean)
  const position = new Map<string, number>()
  const ids: string[] = []
  store.order.forEach((id, index) => {
    const row = store.get(id)
    if (!row || !matches(row, filters, words)) return
    position.set(id, index)
    ids.push(id)
  })
  if (sorting.length === 0) return ids
  const rows = new Map(ids.map((id) => [id, store.get(id) as PriceRow]))
  return ids.sort((x, y) => {
    const a = rows.get(x) as PriceRow
    const b = rows.get(y) as PriceRow
    for (const s of sorting) {
      const r = compare(s.id as ColumnId, a, b)
      if (r !== 0) {
        // An empty price stays at the end in both directions.
        if (s.id === 'price' && (a.price === '' || b.price === '')) return r
        return s.desc ? -r : r
      }
    }
    return (position.get(x) ?? 0) - (position.get(y) ?? 0)
  })
}

/** Does an edit of these columns make the order on screen out of date? */
export function touchesView(columns: Iterable<string>, sorting: Sorting, filters: Filters): boolean {
  const ids = new Set(columns)
  if (sorting.some((s) => ids.has(s.id))) return true
  if (filters.stock !== 'all' && ids.has('inStock')) return true
  if (filters.categories.length > 0 && ids.has('category')) return true
  if (filters.search.trim() !== '' && ['name', 'category', 'unit', 'note'].some((c) => ids.has(c))) return true
  return false
}
