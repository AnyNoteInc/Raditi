'use client'

import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch } from 'react'

import { useTRPCClient } from '@/trpc/client'

import { isNotFound } from './call-error'
import type { DialogFeed } from './chat-types'
import {
  feedReducer,
  initialFeedState,
  pollDelay,
  type FeedAction,
  type FeedState,
} from './feed-state'

/**
 * One reader of a dialog: a read at a time, and a read asked for during another follows it, so
 * a write of the client is never missed by a read that started before it. Answers stop being
 * dispatched once the screen is gone.
 */
export function createFeedReader(options: {
  query: (after: string) => Promise<DialogFeed>
  dispatch: Dispatch<FeedAction>
}) {
  let reading = false
  let again = false
  let alive = false
  // The cursor of the latest state: rows after it are asked for.
  let cursor = '0'
  async function read(): Promise<void> {
    if (reading) {
      again = true
      return
    }
    reading = true
    const after = cursor
    try {
      const answer = await options.query(after)
      if (alive) options.dispatch({ type: 'answer', answer, after })
    } catch (error) {
      if (alive) options.dispatch({ type: 'failed', notFound: isNotFound(error) })
    } finally {
      reading = false
      if (again && alive) {
        again = false
        void read()
      }
    }
  }
  return {
    read,
    follow: (state: FeedState) => {
      cursor = state.cursor
    },
    start: () => {
      alive = true
    },
    stop: () => {
      alive = false
    },
  }
}

/**
 * Reads a dialog: the head and the rows after the last one seen, again and again while the page
 * is shown (`pollDelay`). `refresh` reads at once — after the client has written something, or
 * pressed «Обновить».
 */
export function useDialogFeed(taskId: string): { state: FeedState; refresh: () => void } {
  const client = useTRPCClient()
  const [state, dispatch] = useReducer(feedReducer, initialFeedState)
  const latest = useRef(state)
  const [reader] = useState(() =>
    createFeedReader({ query: (after) => client.task.feed.query({ taskId, after }), dispatch }),
  )

  useEffect(() => {
    reader.start()
    return () => reader.stop()
  }, [reader])

  // Every answer or failure changes the state, and the next read is planned from it.
  useEffect(() => {
    latest.current = state
    reader.follow(state)
    const delay = pollDelay(state)
    if (delay === null) return
    // A hidden page is not read: it is read again as soon as it is shown.
    if (delay > 0 && document.visibilityState === 'hidden') return
    const timer = window.setTimeout(() => void reader.read(), delay)
    return () => window.clearTimeout(timer)
  }, [state, reader])

  useEffect(() => {
    const shown = () => {
      if (document.visibilityState === 'visible' && pollDelay(latest.current) !== null)
        void reader.read()
    }
    document.addEventListener('visibilitychange', shown)
    return () => document.removeEventListener('visibilitychange', shown)
  }, [reader])

  const refresh = useCallback(() => void reader.read(), [reader])
  return { state, refresh }
}
