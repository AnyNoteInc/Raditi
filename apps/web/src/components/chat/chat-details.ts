'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'

// Two choices of this viewer in this browser (docs/plan/61-chats-first.md, §5.14), kept in
// `localStorage`; a blocked or empty storage means the default.
// «Подробности работы» (`/details`): finished turns show «Ход работы» open.
// «Размышления агента» (`/thinking`, К32): «Ход работы» shows what the model thought, and the line
// of a finished turn stands open, or the choice would show nothing. Until the viewer chooses, a
// turn at work shows its thoughts and a finished one does not (docs/spec.md §20, РА7); once they
// chose, the choice holds for both (owner's request of 19.11.2026: `/thinking` did nothing to be
// seen while the agent worked). The switch turns over what the page shows now: while a turn at
// work stands on it, the first press hides its thoughts (owner's answer of 19.11.2026).

/** What is stored: `on`, `off`, or nothing chosen yet. */
type Stored = 'on' | 'off' | 'unset'

const chosenOn = (stored: Stored) => stored === 'on'

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

  /**
   * The choice and its switch: on only when chosen; the server draws the default. The switch turns
   * over what `seen` says the page shows of the stored choice now.
   */
  return function useChoice(seen: (stored: Stored) => boolean = chosenOn): {
    stored: Stored
    on: boolean
    toggle: () => boolean
  } {
    const stored = useSyncExternalStore(subscribe, read, () => 'unset' as const)
    const toggle = useCallback(() => {
      const next = !seen(read())
      write(next)
      return next
    }, [seen])
    return { stored, on: stored === 'on', toggle }
  }
}

// The turns at work this page shows (`useTurnAtWorkShown`): while one stands, `/thinking` and its
// switch speak of its thoughts.
let turnsAtWork = 0
const turnListeners = new Set<() => void>()

function subscribeTurns(listener: () => void) {
  turnListeners.add(listener)
  return () => {
    turnListeners.delete(listener)
  }
}

function countTurns(by: number) {
  turnsAtWork += by
  for (const listener of turnListeners) listener()
}

const aTurnAtWork = () => turnsAtWork > 0

/** What the page shows of the thoughts: a turn at work shows them unless hidden (РА7). */
const thoughtsSeen = (stored: Stored) => (aTurnAtWork() ? stored !== 'off' : stored === 'on')

/** A turn at work the page shows while `live` holds — «Ход работы» of the turn going now. */
export function useTurnAtWorkShown(live: boolean): void {
  useEffect(() => {
    if (!live) return
    countTurns(1)
    return () => countTurns(-1)
  }, [live])
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
  /** What the page shows now — of the turn at work while one stands, else of finished ones. */
  shown: boolean
  /** Turns over `shown`. */
  toggle: () => boolean
} {
  const { stored, on, toggle } = useThinking(thoughtsSeen)
  const atWork = useSyncExternalStore(subscribeTurns, aTurnAtWork, () => false)
  const live = stored !== 'off'
  return { thinking: on, live, shown: atWork ? live : on, toggle }
}
