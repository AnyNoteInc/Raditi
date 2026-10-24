import { describe, expect, it } from 'vitest'

import {
  compareRowIds,
  feedPolling,
  feedReducer,
  initialFeedState,
  mergeRows,
  pollDelay,
  showsRefresh,
  type FeedState,
} from './feed-state'
import { candidateHead, feedAnswer, requestRow, resultRow, stepRow } from './testing'

const answered = (state: FeedState, answer = feedAnswer(), after = state.cursor) =>
  feedReducer(state, { type: 'answer', answer, after })

describe('the rows of a dialog', () => {
  it('compares ids as numbers, not as text', () => {
    expect(compareRowIds('9', '10')).toBeLessThan(0)
    expect(compareRowIds('10', '9')).toBeGreaterThan(0)
    expect(compareRowIds('42', '42')).toBe(0)
  })

  it('merges by id: a row read again replaces its copy, the order is by id', () => {
    const first = requestRow('9')
    const again = { ...first, text: 'исправлено' } as typeof first
    const merged = mergeRows([first, stepRow('10', 1)], [again, stepRow('11', 1)])
    expect(merged.map((row) => row.id)).toEqual(['9', '10', '11'])
    expect(merged[0]).toBe(again)
  })
})

describe('feedReducer', () => {
  it('keeps the head and the rows of an answer and moves the cursor', () => {
    const state = answered(
      initialFeedState,
      feedAnswer({ events: [requestRow('5')], cursor: '5' }),
      '0',
    )
    expect(state.head?.task.status).toBe('queued')
    expect(state.rows.map((row) => row.id)).toEqual(['5'])
    expect(state.cursor).toBe('5')
    expect(state.now).toBe(false)
  })

  it('reads the next page at once while rows are left', () => {
    const state = answered(initialFeedState, feedAnswer({ cursor: '200', more: true }), '0')
    expect(state.now).toBe(true)
    expect(pollDelay(state)).toBe(0)
  })

  it('reads again from the start when the status changed, keeping what it has', () => {
    const first = answered(
      initialFeedState,
      feedAnswer({ events: [requestRow('5')], cursor: '5' }),
      '0',
    )
    const next = answered(
      first,
      feedAnswer({ status: 'running', events: [stepRow('6', 1)], cursor: '6' }),
      '5',
    )
    expect(next.cursor).toBe('0')
    expect(next.now).toBe(true)
    expect(next.rows.map((row) => row.id)).toEqual(['5', '6'])
    // The read from the start does not start another one.
    const reread = answered(next, feedAnswer({ status: 'running', cursor: '6' }), '0')
    expect(reread.cursor).toBe('6')
    expect(reread.now).toBe(false)
  })

  it('keeps the read from the start when a read from the old cursor answers after it was asked', () => {
    const first = answered(
      initialFeedState,
      feedAnswer({ events: [requestRow('5')], cursor: '5' }),
      '0',
    )
    const changed = answered(
      first,
      feedAnswer({ status: 'running', events: [stepRow('7', 1)], cursor: '7' }),
      '5',
    )
    expect(changed.cursor).toBe('0')
    // A read that had started from 5 before the state asked for the start answers now.
    const late = answered(
      changed,
      feedAnswer({ status: 'running', events: [stepRow('8', 1)], cursor: '8' }),
      '5',
    )
    expect(late.rows.map((row) => row.id)).toEqual(['5', '7', '8'])
    expect(late.cursor).toBe('0')
    expect(late.now).toBe(true)
    expect(pollDelay(late)).toBe(0)
    // The read from the start then lands the row committed late, with its lower id.
    const reread = answered(
      late,
      feedAnswer({ status: 'running', events: [requestRow('5'), stepRow('6', 1)], cursor: '8' }),
      '0',
    )
    expect(reread.rows.map((row) => row.id)).toEqual(['5', '6', '7', '8'])
    expect(reread.cursor).toBe('8')
    expect(reread.now).toBe(false)
  })

  it('counts failed reads and keeps the screen; a dialog not found stops the reads', () => {
    const shown = answered(
      initialFeedState,
      feedAnswer({ events: [requestRow('5')], cursor: '5' }),
      '0',
    )
    let state = feedReducer(shown, { type: 'failed', notFound: false })
    expect(state.failures).toBe(1)
    expect(state.rows).toHaveLength(1)
    state = feedReducer(feedReducer(state, { type: 'failed', notFound: false }), {
      type: 'failed',
      notFound: false,
    })
    expect(showsRefresh(state)).toBe(true)
    expect(answered(state).failures).toBe(0)
    const missing = feedReducer(shown, { type: 'failed', notFound: true })
    expect(missing.missing).toBe(true)
    expect(pollDelay(missing)).toBeNull()
  })
})

describe('pollDelay', () => {
  const at = (patch: Parameters<typeof feedAnswer>[0]) =>
    answered(initialFeedState, feedAnswer(patch), '0')

  it('reads at once on the first mount', () => {
    expect(pollDelay(initialFeedState)).toBe(0)
  })

  it('reads every 2 s while someone works on the dialog', () => {
    for (const status of ['queued', 'preparing', 'running', 'deploying', 'verifying'] as const)
      expect(pollDelay(at({ status }))).toBe(feedPolling.working)
  })

  it('reads every 15 s while the dialog waits for the client', () => {
    expect(pollDelay(at({ status: 'awaiting_user' }))).toBe(feedPolling.waiting)
    expect(pollDelay(at({ status: 'awaiting_approval', candidate: candidateHead }))).toBe(15_000)
  })

  it('counts the build of the preview as work', () => {
    const preview = {
      status: 'building' as const,
      unavailableReason: null,
      origin: null,
      revision: 1,
      dirty: false,
    }
    expect(pollDelay(at({ status: 'awaiting_approval', preview }))).toBe(2_000)
  })

  it('counts an open browser of the task as work while the task waits', () => {
    const browser = {
      sessionId: '0199a3f2-0000-7000-8000-0000000000e1',
      status: 'ready' as const,
      controller: 'user' as const,
      help: null,
      closeReason: null,
    }
    expect(pollDelay(at({ status: 'awaiting_user', browser }))).toBe(feedPolling.working)
    expect(
      pollDelay(at({ status: 'awaiting_user', browser: { ...browser, status: 'closed' } })),
    ).toBe(feedPolling.waiting)
  })

  it('stops at the end of a dialog', () => {
    for (const status of ['done', 'failed', 'cancelled', 'rolled_back'] as const)
      expect(pollDelay(at({ status }))).toBeNull()
  })

  it('backs off after failures, up to 30 s', () => {
    let state = at({ status: 'running', events: [resultRow('7', 1)], cursor: '7' })
    const delays: (number | null)[] = []
    for (let index = 0; index < 5; index += 1) {
      state = feedReducer(state, { type: 'failed', notFound: false })
      delays.push(pollDelay(state))
    }
    expect(delays).toEqual([4_000, 8_000, 16_000, 30_000, 30_000])
    const waiting = feedReducer(at({ status: 'awaiting_user' }), {
      type: 'failed',
      notFound: false,
    })
    expect(pollDelay(waiting)).toBe(30_000)
  })
})

describe('a closed dialog whose release is undone', () => {
  it('is read every 2 s while the undo goes on, and no more once it ended', () => {
    const run = {
      id: '0199a3f2-0000-7000-8000-0000000000e1',
      status: 'deploying' as const,
      step: null,
      version: 'v1.4.1',
      outcome: null,
    }
    const undo = {
      releaseId: '0199a3f2-0000-7000-8000-0000000000d1',
      version: 'v1.4.0',
      installedNow: true,
      until: new Date(),
      run,
    }
    const state = (patch: Parameters<typeof feedAnswer>[0]) => ({
      ...feedReducer(initialFeedState, { type: 'answer', answer: feedAnswer(patch), after: '0' }),
      now: false,
    })
    expect(pollDelay(state({ status: 'done', undo }))).toBe(feedPolling.working)
    expect(
      pollDelay(
        state({
          status: 'done',
          undo: { ...undo, run: { ...run, status: 'installed', outcome: 'installed' } },
        }),
      ),
    ).toBeNull()
  })
})
