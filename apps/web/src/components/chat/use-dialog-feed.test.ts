import { describe, expect, it, vi } from 'vitest'

import type { DialogFeed } from './chat-types'
import type { FeedAction } from './feed-state'
import { feedAnswer } from './testing'
import { createFeedReader } from './use-dialog-feed'

/** A query whose answers the test gives one by one. */
function controlledQuery() {
  const pending: Array<(answer: DialogFeed) => void> = []
  const query = vi.fn(
    (_after: string) =>
      new Promise<DialogFeed>((resolve) => {
        pending.push(resolve)
      }),
  )
  return { query, answer: (answer = feedAnswer()) => pending.shift()?.(answer) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the reader of a dialog', () => {
  it('reads one at a time, and a read asked for meanwhile follows the one in flight', async () => {
    const { query, answer } = controlledQuery()
    const dispatch = vi.fn<(action: FeedAction) => void>()
    const reader = createFeedReader({ query, dispatch })
    reader.start()
    void reader.read()
    void reader.read()
    void reader.read()
    expect(query).toHaveBeenCalledTimes(1)
    answer()
    await settle()
    // The writes of the client made during the first read are seen by the one after it.
    expect(query).toHaveBeenCalledTimes(2)
    answer()
    await settle()
    expect(query).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('asks for the rows after the cursor of the latest state', async () => {
    const { query, answer } = controlledQuery()
    const reader = createFeedReader({ query, dispatch: vi.fn() })
    reader.start()
    reader.follow({ cursor: '42' } as Parameters<typeof reader.follow>[0])
    void reader.read()
    expect(query).toHaveBeenCalledWith('42')
    answer()
    await settle()
  })

  it('dispatches nothing once the screen is gone, and tells a missing dialog', async () => {
    const dispatch = vi.fn<(action: FeedAction) => void>()
    const missing = Object.assign(new Error('Not found'), { data: { code: 'NOT_FOUND' } })
    const reader = createFeedReader({ query: () => Promise.reject(missing), dispatch })
    reader.start()
    await reader.read()
    expect(dispatch).toHaveBeenCalledWith({ type: 'failed', notFound: true })
    reader.stop()
    await reader.read()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
