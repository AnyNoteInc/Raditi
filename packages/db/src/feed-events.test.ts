import { describe, expect, it, vi } from 'vitest'

import { insertFeedEvent, type FeedWriter } from './feed-events.ts'

const taskId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'

function fakeWriter() {
  const create = vi.fn().mockResolvedValue({ id: 42n })
  const writer = { taskEvent: { create } } as unknown as FeedWriter
  return { writer, create }
}

describe('insertFeedEvent', () => {
  it('writes a visible feed row and returns its id', async () => {
    const { writer, create } = fakeWriter()

    const id = await insertFeedEvent(writer, {
      taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'first',
          requestId: taskId,
          authorId: taskId,
          text: 'Поменяйте телефон в шапке',
        },
      } as never,
    })

    expect(id).toBe(42n)
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId,
        turnId: null,
        type: 'feed.request',
        clientVisible: true,
      }),
      select: { id: true },
    })
  })

  it('refuses a row the write schema does not accept, before writing', async () => {
    const { writer, create } = fakeWriter()

    await expect(
      insertFeedEvent(writer, {
        taskId,
        row: { type: 'feed.request', payload: { v: 1, kind: 'first' } } as never,
      }),
    ).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a type outside the feed', async () => {
    const { writer, create } = fakeWriter()

    await expect(
      insertFeedEvent(writer, {
        taskId,
        row: { type: 'turn.output', payload: { v: 1 } } as never,
      }),
    ).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })
})
