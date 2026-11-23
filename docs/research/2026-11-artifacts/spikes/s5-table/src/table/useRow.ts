import { useCallback, useSyncExternalStore } from 'react'
import type { PriceRow } from './model'
import type { RowStore } from './store'

/** The latest values of one row; renders only when this row changes. */
export function useRow(store: RowStore, id: string): PriceRow | undefined {
  const subscribe = useCallback((listener: () => void) => store.subscribeRow(id, listener), [store, id])
  return useSyncExternalStore(subscribe, () => store.get(id))
}
