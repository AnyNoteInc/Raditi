'use client'

import { useCallback, useSyncExternalStore } from 'react'

// Two choices of this viewer in this browser (docs/plan/61-chats-first.md, §5.14), kept in
// `localStorage`; a blocked or empty storage means the default, off.
// «Подробности работы» (`/details`): finished turns show «Ход работы» open.
// «Размышления агента» (`/thinking`, К32): «Ход работы» shows what the model thought, and the line
// of a finished turn stands open, or the choice would show nothing.

function viewerChoice(key: string) {
  const listeners = new Set<() => void>()
  /** What this page holds where the storage throws: the choice lasts until the page closes. */
  let held: boolean | null = null

  function read(): boolean {
    if (held !== null) return held
    try {
      return window.localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  }

  function write(next: boolean) {
    try {
      window.localStorage.setItem(key, next ? '1' : '0')
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
  return function useChoice(): { on: boolean; toggle: () => boolean } {
    const on = useSyncExternalStore(subscribe, read, () => false)
    const toggle = useCallback(() => {
      const next = !read()
      write(next)
      return next
    }, [])
    return { on, toggle }
  }
}

const useDetails = viewerChoice('raditi-chat-details')
const useThinking = viewerChoice('raditi-chat-thinking')

export function useChatDetails(): { details: boolean; toggle: () => boolean } {
  const { on, toggle } = useDetails()
  return { details: on, toggle }
}

export function useChatThinking(): { thinking: boolean; toggle: () => boolean } {
  const { on, toggle } = useThinking()
  return { thinking: on, toggle }
}
