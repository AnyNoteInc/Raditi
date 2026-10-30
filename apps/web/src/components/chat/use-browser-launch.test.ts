import { describe, expect, it } from 'vitest'

import type { BrowserHead } from './chat-types'
import { SESSION_ID } from './testing'
import {
  unseen,
  unwatched,
  watchedFromStart,
  watchLaunch,
  type LaunchWatch,
} from './use-browser-launch'

const OTHER_SESSION = '0199a3f2-0000-7000-8000-0000000000e2'

const session = (status: BrowserHead['status'], sessionId: string = SESSION_ID): BrowserHead => ({
  sessionId,
  status,
  controller: 'agent',
  help: null,
  closeReason: null,
})

type Answer = { browser: BrowserHead | null; shown?: boolean }

/** The answers in their order, from `start`: which of them launched the browser, and the watch. */
function read(start: LaunchWatch, ...answers: Answer[]) {
  let watch = start
  const launched = answers.map(({ browser, shown = true }) => {
    const next = watchLaunch(watch, browser, shown)
    watch = next.watch
    return next.launched
  })
  return { launched, watch }
}

describe('the launch of the browser (docs/plan/59, И2, И3)', () => {
  it('takes the first answer of a showing for the base and launches nothing by it', () => {
    expect(read(unwatched, { browser: session('ready') }).launched).toEqual([false])
    expect(read(unwatched, { browser: null }).launched).toEqual([false])
  })

  it('launches when a session turns ready after the base, once for it', () => {
    expect(
      read(
        unwatched,
        { browser: null },
        { browser: session('starting') },
        { browser: session('ready') },
        { browser: session('ready') },
      ).launched,
    ).toEqual([false, false, true, false])
  })

  it('launches nothing for a session the base already had ready, and a new one later', () => {
    expect(
      read(
        unwatched,
        { browser: session('ready') },
        { browser: session('ready') },
        { browser: session('closed') },
        { browser: session('starting', OTHER_SESSION) },
        { browser: session('ready', OTHER_SESSION) },
      ).launched,
    ).toEqual([false, false, false, false, true])
  })

  it('launches nothing for a session that fails or is lost before it is ready', () => {
    expect(
      read(
        unwatched,
        { browser: session('starting') },
        { browser: session('failed') },
        { browser: session('lost', OTHER_SESSION) },
      ).launched,
    ).toEqual([false, false, false])
  })

  it('takes an answer read while the page is hidden for no look, and the next one shown for the base', () => {
    expect(
      read(
        unwatched,
        { browser: session('starting') },
        { browser: session('ready'), shown: false },
        { browser: session('ready') },
        { browser: session('ready') },
      ).launched,
    ).toEqual([false, false, false, false])
  })

  it('takes the first answer after the page was out of sight for a base again', () => {
    const before = read(unwatched, { browser: session('starting') }).watch
    // The page went out of sight while nothing was read; it is shown again.
    const after = read(unseen(before), { browser: session('ready') }, { browser: session('ready') })
    expect(after.launched).toEqual([false, false])
    // Out of sight, a session got ready and then closed: the one after it still launches.
    expect(
      read(
        unseen(before),
        { browser: session('closed') },
        { browser: session('ready', OTHER_SESSION) },
      ).launched,
    ).toEqual([false, true])
  })

  it('watches a dialog the client has just started from before its browser', () => {
    expect(read(watchedFromStart, { browser: session('ready') }).launched).toEqual([true])
    expect(
      read(watchedFromStart, { browser: session('starting') }, { browser: session('ready') })
        .launched,
    ).toEqual([false, true])
    // Started and left at once: the answer read out of sight is no look.
    expect(
      read(
        watchedFromStart,
        { browser: session('ready'), shown: false },
        { browser: session('ready') },
      ).launched,
    ).toEqual([false, false])
  })

  it('keeps the same watch when nothing changes', () => {
    const { watch } = read(unwatched, { browser: session('ready') })
    expect(watchLaunch(watch, session('ready'), true).watch).toBe(watch)
    expect(watchLaunch(watch, null, true).watch).toBe(watch)
    const away = unseen(watch)
    expect(unseen(away)).toBe(away)
  })
})
