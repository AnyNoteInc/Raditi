'use client'

import { useEffect, useRef, useState } from 'react'

import { useTRPCClient } from '@/trpc/client'

import type { ActivityEvent, TurnActivityPage } from './chat-types'
import { feedPolling } from './feed-state'

/** «Ход работы» of one turn as the screen holds it. */
export interface ActivityState {
  events: readonly ActivityEvent[]
  /** A first answer has come. */
  read: boolean
  /** The latest read failed; the events read before stay. */
  failed: boolean
  /** The server holds more rows than it gave so far. */
  more: boolean
}

export const initialActivity: ActivityState = Object.freeze({
  events: [],
  read: false,
  failed: false,
  more: false,
})

/** The state after one answer: its events after those already there, each once. */
export function withActivity(state: ActivityState, page: TurnActivityPage): ActivityState {
  const seen = new Set(state.events.map((event) => event.id))
  const fresh = page.events.filter((event) => !seen.has(event.id))
  // Nothing new: the same state, so a screen polled every two seconds is not drawn again.
  if (fresh.length === 0 && state.read && !state.failed && state.more === page.more) return state
  return {
    events: fresh.length === 0 ? state.events : [...state.events, ...fresh],
    read: true,
    failed: false,
    more: page.more,
  }
}

/** A turn that has ended is read again after a failure this many times, a live one always. */
const ENDED_RETRIES = 3

/**
 * Reads «Ход работы» of a turn: at once, the next page straight after one with more, and — while
 * the turn is `live` — again every `feedPolling.working` ms; a failed read is repeated after a
 * pause that doubles up to `feedPolling.max`. A hidden page is not read while live. Returns the
 * stop: nothing is updated after it.
 */
export function startActivityReader(options: {
  query: (after: string) => Promise<TurnActivityPage>
  update: (change: (state: ActivityState) => ActivityState) => void
  /** The cursor the reader moves, kept across readers of the same turn. */
  cursor: { current: string }
  live: boolean
  hidden?: () => boolean
}): () => void {
  let alive = true
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const plan = (delay: number) => {
    timer = setTimeout(() => void read(), delay)
  }
  async function read(): Promise<void> {
    if (!alive) return
    if (options.live && options.hidden?.()) return plan(feedPolling.working)
    try {
      const page = await options.query(options.cursor.current)
      if (!alive) return
      failures = 0
      options.cursor.current = page.cursor
      options.update((state) => withActivity(state, page))
      if (page.more) return plan(0)
      if (options.live) plan(feedPolling.working)
    } catch {
      if (!alive) return
      failures += 1
      options.update((state) => (state.failed ? state : { ...state, failed: true }))
      if (options.live || failures < ENDED_RETRIES)
        plan(Math.min(feedPolling.working * 2 ** failures, feedPolling.max))
    }
  }
  void read()
  return () => {
    alive = false
    clearTimeout(timer)
  }
}

/**
 * «Ход работы» of a turn of a dialog, read from `task.activity`. One turn per mount: a screen
 * that shows another turn mounts it anew (a `key` of the turn).
 */
export function useTurnActivity(taskId: string, turn: number, live: boolean): ActivityState {
  const client = useTRPCClient()
  const [query] = useState(
    () => (after: string) => client.task.activity.query({ taskId, turn, after }),
  )
  const [state, setState] = useState(initialActivity)
  const cursor = useRef('0')
  useEffect(
    () =>
      startActivityReader({
        query,
        update: setState,
        cursor,
        live,
        hidden: () => document.visibilityState === 'hidden',
      }),
    [query, live],
  )
  return state
}
