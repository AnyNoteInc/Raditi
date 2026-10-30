'use client'

import { useEffect, useRef, useState } from 'react'

import type { BrowserHead } from './chat-types'
import type { FeedHeadState } from './feed-state'
import { forgetNewDialog, isNewDialog } from './new-dialog-hint'

// The launch of the browser of a task while the client looks at its dialog (docs/plan/59-dialog-
// tools-panel.md, И2, И3): the one time the tools open by themselves. Each answer of the feed is
// measured against a base — the first answer the client saw, or the first one after the page had
// been out of sight: a session that turns `ready` after the base has started on the client's eyes.
// What the dialog does then (opens the browser once from `lg`, marks «+» below) is its reducer's.

/** What the next answers of a dialog are measured against. */
export interface LaunchWatch {
  /** The next answer seen on a shown page is the base: the client was not looking before it. */
  rebase: boolean
  /** The session the client has seen ready since the base; null — none. */
  ready: string | null
}

/** A dialog opened, or reloaded: its first answer is the base, whatever its browser does. */
export const unwatched: LaunchWatch = Object.freeze({ rebase: true, ready: null })

/**
 * A dialog the client has just started (`markNewDialog`): watched from before it had a browser,
 * so a session ready by its first answer has started on the client's eyes too.
 */
export const watchedFromStart: LaunchWatch = Object.freeze({ rebase: false, ready: null })

/** The page went out of sight: what happens meanwhile is not seen, the next answer is a base. */
export const unseen = (watch: LaunchWatch): LaunchWatch =>
  watch.rebase ? watch : { ...watch, rebase: true }

/**
 * One answer of the dialog against the watch: the watch after it, and whether the answer is the
 * launch — a session `ready` that the client had not seen ready since the base. An answer read
 * while the page is hidden is no one's look: the one after it is the base.
 */
export function watchLaunch(
  watch: LaunchWatch,
  browser: BrowserHead | null,
  shown: boolean,
): { watch: LaunchWatch; launched: boolean } {
  const ready = browser !== null && browser.status === 'ready' ? browser.sessionId : null
  if (!shown) return { watch: unseen(watch), launched: false }
  if (watch.rebase) return { watch: { rebase: false, ready }, launched: false }
  if (ready === null || ready === watch.ready) return { watch, launched: false }
  return { watch: { rebase: false, ready }, launched: true }
}

/**
 * Calls `onLaunch` when the browser of the task starts while the client looks at the dialog.
 * Every answer is read once, as it comes; the reducer of the tools keeps the opening to one.
 */
export function useBrowserLaunch(
  head: FeedHeadState | null,
  {
    taskId,
    enabled,
    onLaunch,
  }: {
    taskId: string
    /** A task in the browser the cabinet can show: nothing else launches. */
    enabled: boolean
    onLaunch: () => void
  },
) {
  // Read at the first render, not taken: a render React does twice (Strict Mode) or throws away
  // reads it again. It goes once the first answer is in.
  const [start] = useState(() => (isNewDialog(taskId) ? watchedFromStart : unwatched))
  const watch = useRef(start)
  // The answer read last: a render that brings no new one reads nothing.
  const read = useRef<FeedHeadState | null>(null)

  useEffect(() => {
    const away = () => {
      if (document.visibilityState === 'hidden') watch.current = unseen(watch.current)
    }
    document.addEventListener('visibilitychange', away)
    return () => document.removeEventListener('visibilitychange', away)
  }, [])

  useEffect(() => {
    if (head === null || head === read.current) return
    // The start of the dialog has told its first showing what it had to: a reload is no start.
    if (read.current === null) forgetNewDialog(taskId)
    read.current = head
    const next = watchLaunch(watch.current, head.browser, document.visibilityState !== 'hidden')
    watch.current = next.watch
    if (next.launched && enabled) onLaunch()
  }, [head, enabled, onLaunch, taskId])
}
