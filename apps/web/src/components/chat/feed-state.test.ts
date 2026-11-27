import { describe, expect, it } from 'vitest'

import {
  compareRowIds,
  feedPolling,
  feedReducer,
  initialFeedState,
  mergeRows,
  pollDelay,
  sameJson,
  showsRefresh,
  type FeedState,
} from './feed-state'
import { feedAnswer, requestRow, resultRow, stepRow } from './testing'

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
  it('keeps the very head and rows when a read brings nothing new (P33.3)', () => {
    const first = answered(
      initialFeedState,
      feedAnswer({ events: [requestRow('5')], cursor: '5' }),
      '0',
    )
    const again = answered(first, feedAnswer({ cursor: '5' }))
    expect(again.head).toBe(first.head)
    expect(again.rows).toBe(first.rows)
    // A new state all the same: the next read is planned from it.
    expect(again).not.toBe(first)

    const changed = answered(again, feedAnswer({ cursor: '5', status: 'running' }))
    expect(changed.head).not.toBe(first.head)
    expect(changed.head?.task.status).toBe('running')
  })

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

  it('keeps its cursor when the status changes: a late row comes with the next read', () => {
    const first = answered(
      initialFeedState,
      feedAnswer({ events: [requestRow('5')], cursor: '5.100' }),
      '0',
    )
    const next = answered(
      first,
      feedAnswer({ status: 'running', events: [stepRow('7', 1)], cursor: '7.101' }),
      '5.100',
    )
    expect(next.cursor).toBe('7.101')
    expect(next.now).toBe(false)
    expect(pollDelay(next)).toBe(feedPolling.working)
    // The row of a transaction open at the last read, with its lower id, and a row given again.
    const late = answered(
      next,
      feedAnswer({
        status: 'running',
        events: [stepRow('6', 1), stepRow('7', 1)],
        cursor: '7.102',
      }),
      '7.101',
    )
    expect(late.rows.map((row) => row.id)).toEqual(['5', '6', '7'])
    expect(late.cursor).toBe('7.102')
  })

  it('takes the cursor of a read only when it started from the cursor of the state', () => {
    const first = answered(
      initialFeedState,
      feedAnswer({ events: [requestRow('5')], cursor: '5.1' }),
      '0',
    )
    const newer = answered(first, feedAnswer({ events: [stepRow('8', 1)], cursor: '8.2' }), '5.1')
    // A read that had started from 5 answers after the one from 8.
    const late = answered(newer, feedAnswer({ events: [stepRow('7', 1)], cursor: '7.1' }), '5.1')
    expect(late.rows.map((row) => row.id)).toEqual(['5', '7', '8'])
    expect(late.cursor).toBe('8.2')
  })

  it('reads every row from the first one when the server starts the reader over', () => {
    const opened = answered(
      initialFeedState,
      feedAnswer({ events: [requestRow('50')], cursor: '50.9' }),
      '0',
    )
    const over = answered(
      opened,
      feedAnswer({ events: [requestRow('1')], cursor: '0', more: true }),
      '50.9',
    )
    expect(over.cursor).toBe('0')
    expect(over.now).toBe(true)
    expect(pollDelay(over)).toBe(0)
    expect(over.rows.map((row) => row.id)).toEqual(['1', '50'])
    // A start over that answers a read the state has left since changes no cursor.
    const newer = answered(opened, feedAnswer({ cursor: '51.9' }), '50.9')
    const stale = answered(newer, feedAnswer({ cursor: '0', more: true }), '50.9')
    expect(stale.cursor).toBe('51.9')
  })

  it('merges rows in the order of their ids, a row read again in place of its copy', () => {
    const known = [requestRow('5'), stepRow('7', 1), resultRow('9', 1)]
    expect(mergeRows(known, []).map((row) => row.id)).toEqual(['5', '7', '9'])
    expect(mergeRows(known, [stepRow('11', 2), requestRow('10')]).map((row) => row.id)).toEqual([
      '5',
      '7',
      '9',
      '10',
      '11',
    ])
    const again = { ...stepRow('7', 1), at: '2026-11-18T10:00:00.000Z' }
    const merged = mergeRows(known, [resultRow('12', 1), again, requestRow('6')])
    expect(merged.map((row) => row.id)).toEqual(['5', '6', '7', '9', '12'])
    expect(merged[2]).toBe(again)
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

  it('polls only as the fallback while the stream of signals is up', () => {
    expect(pollDelay(at({ status: 'running' }), true)).toBe(feedPolling.signalled.working)
    expect(pollDelay(at({ status: 'awaiting_user' }), true)).toBe(feedPolling.signalled.waiting)
    // A page of rows left is read at once all the same.
    expect(pollDelay(answered(initialFeedState, feedAnswer({ more: true }), '0'), true)).toBe(0)
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

describe('sameJson', () => {
  it('compares values read from JSON by their contents', () => {
    expect(sameJson({ a: [1, { b: 'x' }], c: null }, { c: null, a: [1, { b: 'x' }] })).toBe(true)
    expect(sameJson({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false)
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(sameJson({ a: null }, { a: {} })).toBe(false)
    expect(sameJson([], {})).toBe(false)
    expect(sameJson('1', 1)).toBe(false)
  })
})
