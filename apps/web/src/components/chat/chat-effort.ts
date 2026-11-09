'use client'

import { reasoningEffortSchema, type ReasoningEffort } from '@repo/domain'
import { useCallback, useSyncExternalStore } from 'react'

// The level of thinking this viewer chose last, kept in `localStorage` (owner's request of
// 09.11.2026: «если выбрали максимальный, значит максимальный и после перезагрузки страницы»).
// A new chat starts with it; a chat already started keeps its own level on the server. A blocked
// or empty storage means the default.

const KEY = 'raditi-chat-effort'
export const defaultEffort: ReasoningEffort = 'high'

const listeners = new Set<() => void>()
/** What this page holds where the storage throws: the choice lasts until the page closes. */
let held: ReasoningEffort | null = null

function read(): ReasoningEffort {
  if (held !== null) return held
  try {
    const parsed = reasoningEffortSchema.safeParse(window.localStorage.getItem(KEY))
    return parsed.success ? parsed.data : defaultEffort
  } catch {
    return defaultEffort
  }
}

/** Remembers the level for the next new chat of this browser. */
export function rememberEffort(effort: ReasoningEffort): void {
  try {
    window.localStorage.setItem(KEY, effort)
    held = null
  } catch {
    held = effort
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The remembered level and its setter; the server draws the default. */
export function useRememberedEffort(): [ReasoningEffort, (effort: ReasoningEffort) => void] {
  const effort = useSyncExternalStore(subscribe, read, () => defaultEffort)
  const choose = useCallback((next: ReasoningEffort) => rememberEffort(next), [])
  return [effort, choose]
}
