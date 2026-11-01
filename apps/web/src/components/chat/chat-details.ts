'use client'

import { useCallback, useSyncExternalStore } from 'react'

// «Подробности работы» (`/details`, docs/plan/61-chats-first.md, §5.14): whether finished turns show
// «Ход работы» open. A convenience of this viewer in this browser, so it is kept in `localStorage`;
// a blocked or empty storage means the default, closed.

const DETAILS_KEY = 'raditi-chat-details'

const listeners = new Set<() => void>()
/** What this page holds where the storage throws: the choice lasts until the page closes. */
let held: boolean | null = null

function read(): boolean {
  if (held !== null) return held
  try {
    return window.localStorage.getItem(DETAILS_KEY) === '1'
  } catch {
    return false
  }
}

function write(next: boolean) {
  try {
    window.localStorage.setItem(DETAILS_KEY, next ? '1' : '0')
    held = null
  } catch {
    held = next
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The choice and its switch; the server draws the default. */
export function useChatDetails(): { details: boolean; toggle: () => boolean } {
  const details = useSyncExternalStore(subscribe, read, () => false)
  const toggle = useCallback(() => {
    const next = !read()
    write(next)
    return next
  }, [])
  return { details, toggle }
}
