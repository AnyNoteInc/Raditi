import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TurnActivityPage } from './chat-types'
import { feedPolling } from './feed-state'
import {
  initialActivity,
  startActivityReader,
  withActivity,
  type ActivityState,
} from './use-turn-activity'

const page = (patch: Partial<TurnActivityPage> = {}): TurnActivityPage => ({
  events: [],
  cursor: '0',
  more: false,
  ...patch,
})

const message = (id: string, text = id) => ({ id, type: 'message' as const, text })

function reader(answers: Array<TurnActivityPage | Error>, live: boolean) {
  let state: ActivityState = initialActivity
  const cursor = { current: '0' }
  const query = vi.fn(async (_after: string) => {
    const answer = answers.shift() ?? page({ cursor: cursor.current })
    if (answer instanceof Error) throw answer
    return answer
  })
  const stop = startActivityReader({
    query,
    update: (change) => {
      state = change(state)
    },
    cursor,
    live,
  })
  return { query, stop, cursor, state: () => state }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('withActivity', () => {
  it('adds the events of an answer after those there, each once', () => {
    const first = withActivity(initialActivity, page({ events: [message('1:0')], cursor: '1' }))
    const again = withActivity(
      first,
      page({ events: [message('1:0'), message('2:0')], cursor: '2', more: true }),
    )
    expect(again).toEqual({
      events: [message('1:0'), message('2:0')],
      read: true,
      failed: false,
      more: true,
    })
  })
})

describe('the reader of «Ход работы»', () => {
  it('reads a finished turn page after page and then stops', async () => {
    const { query, state } = reader(
      [
        page({ events: [message('3:0')], cursor: '3', more: true }),
        page({ events: [message('5:0')], cursor: '5' }),
      ],
      false,
    )
    await vi.runAllTimersAsync()
    expect(query.mock.calls.map(([after]) => after)).toEqual(['0', '3'])
    expect(state().events.map((event) => event.id)).toEqual(['3:0', '5:0'])
  })

  it('reads a live turn again every two seconds from its cursor', async () => {
    const { query, stop } = reader([page({ events: [message('4:0')], cursor: '4' })], true)
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(feedPolling.working)
    expect(query).toHaveBeenCalledTimes(2)
    expect(query).toHaveBeenLastCalledWith('4')
    stop()
    await vi.advanceTimersByTimeAsync(feedPolling.working * 3)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('keeps what it read when a read fails, and gives a finished turn three tries', async () => {
    const failure = new Error('offline')
    const { query, state } = reader(
      [page({ events: [message('2:0')], cursor: '2', more: true }), failure, failure, failure],
      false,
    )
    await vi.runAllTimersAsync()
    expect(query).toHaveBeenCalledTimes(4)
    expect(state()).toMatchObject({ failed: true, events: [message('2:0')] })
  })

  it('updates nothing after it is stopped', async () => {
    let resolve: (answer: TurnActivityPage) => void = () => {}
    const update = vi.fn()
    const stop = startActivityReader({
      query: () => new Promise((done) => (resolve = done)),
      update,
      cursor: { current: '0' },
      live: true,
    })
    stop()
    resolve(page({ events: [message('1:0')], cursor: '1' }))
    await vi.runAllTimersAsync()
    expect(update).not.toHaveBeenCalled()
  })
})
