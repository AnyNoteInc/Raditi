'use client'

import { useCallback, useSyncExternalStore } from 'react'

// Two choices of this viewer in this browser (docs/plan/61-chats-first.md, §5.14), kept in
// `localStorage`; a blocked or empty storage means the default.
// «Подробности работы» (`/details`): finished turns show «Ход работы» open.
// «Размышления агента» (`/thinking`, К32): «Ход работы» shows what the model thought, and the line
// of a finished turn stands open, or the choice would show nothing. Until the viewer chooses, a
// turn at work shows its thoughts and a finished one does not (docs/spec.md §20, РА7); once they
// chose, the choice holds for both (owner's request of 19.11.2026: `/thinking` did nothing to be
// seen while the agent worked).

/** What is stored: `on`, `off`, or nothing chosen yet. */
type Stored = 'on' | 'off' | 'unset'

function viewerChoice(key: string) {
  const listeners = new Set<() => void>()
  /** What this page holds where the storage throws: the choice lasts until the page closes. */
  let held: Stored | null = null

  function read(): Stored {
    if (held !== null) return held
    try {
      const value = window.localStorage.getItem(key)
      return value === '1' ? 'on' : value === '0' ? 'off' : 'unset'
    } catch {
      return 'unset'
    }
  }

  function write(next: boolean) {
    try {
      window.localStorage.setItem(key, next ? '1' : '0')
      held = null
    } catch {
      held = next ? 'on' : 'off'
    }
    for (const listener of listeners) listener()
  }

  function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /** The choice and its switch: on only when chosen; the server draws the default. */
  return function useChoice(): { stored: Stored; on: boolean; toggle: () => boolean } {
    const stored = useSyncExternalStore(subscribe, read, () => 'unset' as const)
    const toggle = useCallback(() => {
      const next = read() !== 'on'
      write(next)
      return next
    }, [])
    return { stored, on: stored === 'on', toggle }
  }
}

const useDetails = viewerChoice('raditi-chat-details')
const useThinking = viewerChoice('raditi-chat-thinking')

export function useChatDetails(): { details: boolean; toggle: () => boolean } {
  const { on, toggle } = useDetails()
  return { details: on, toggle }
}

export function useChatThinking(): {
  /** Finished turns show what the model thought: the viewer asked for it. */
  thinking: boolean
  /** A turn at work shows it: unless the viewer asked to hide it. */
  live: boolean
  toggle: () => boolean
} {
  const { stored, on, toggle } = useThinking()
  return { thinking: on, live: stored !== 'off', toggle }
}
