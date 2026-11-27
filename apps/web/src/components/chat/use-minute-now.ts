'use client'

import { useSyncExternalStore } from 'react'

// One clock of the minute for the whole page (docs/plan/96-review-fixes.md, P33.3): the times of
// the rows («14:30», «вчера, 14:30») change with the minute and never between two of its ticks, so
// every row reads the same Date, and a row is drawn again only when the minute turns.

const MINUTE_MS = 60_000

let current = new Date()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null

function tick() {
  current = new Date()
  for (const listener of listeners) listener()
  // To the start of the next minute, so that «14:30» turns as the clock does.
  timer = setTimeout(tick, MINUTE_MS - (current.getTime() % MINUTE_MS))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === null) {
    // The first reader after a pause takes the time of now, not of the last tick.
    current = new Date()
    timer = setTimeout(tick, MINUTE_MS - (current.getTime() % MINUTE_MS))
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}

/**
 * Without readers — on the server, before the first subscription — no tick runs: a time older
 * than a minute is taken anew, so that a page rendered now never says the time of the start.
 */
function snapshot(): Date {
  if (timer === null && Date.now() - current.getTime() >= MINUTE_MS) current = new Date()
  return current
}

/** The time of now, the same Date for every reader until the minute turns. */
export function useMinuteNow(): Date {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
