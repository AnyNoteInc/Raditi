import { randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { feedBrowser } from './browser.ts'

// The browser block of the head of a feed: what the cabinet is told of the session of a task.

const taskId = randomUUID()
const sessionId = randomUUID()

function session(row: Record<string, unknown> = {}) {
  const findFirst = vi.fn().mockResolvedValue({
    id: sessionId,
    status: 'ready',
    controller: 'agent',
    helpReason: null,
    helpMessage: null,
    closeReason: null,
    ...row,
  })
  return { tx: { browserSession: { findFirst } } as never, findFirst }
}

describe('feedBrowser', () => {
  it('reads nothing for a task that does not need a browser', async () => {
    const { tx, findFirst } = session()
    await expect(feedBrowser(tx, { id: taskId, needsBrowser: false })).resolves.toBeNull()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('tells the latest session of the task: who drives it and what the agent asked', async () => {
    const { tx, findFirst } = session({
      controller: 'user',
      helpReason: 'login',
      helpMessage: 'Войдите​ в админку\r\nсайта',
    })
    await expect(feedBrowser(tx, { id: taskId, needsBrowser: true })).resolves.toEqual({
      sessionId,
      status: 'ready',
      controller: 'user',
      // As the feed shows the agent's words: no invisible characters, one kind of line break.
      help: { reason: 'login', message: 'Войдите в админку\nсайта' },
      closeReason: null,
    })
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    )
  })

  it('tells why a session closed, and leaves out what this code does not know', async () => {
    const closed = session({ status: 'closed', closeReason: 'idle' })
    await expect(feedBrowser(closed.tx, { id: taskId, needsBrowser: true })).resolves.toMatchObject(
      { status: 'closed', closeReason: 'idle', help: null },
    )
    const newer = session({ status: 'lost', closeReason: 'migrated', helpReason: 'telepathy' })
    await expect(feedBrowser(newer.tx, { id: taskId, needsBrowser: true })).resolves.toMatchObject({
      status: 'lost',
      closeReason: null,
      help: null,
    })
    const blank = session({ helpReason: 'other', helpMessage: '​' })
    await expect(feedBrowser(blank.tx, { id: taskId, needsBrowser: true })).resolves.toMatchObject({
      help: { reason: 'other', message: null },
    })
  })

  it('is null before the first pass opened a session', async () => {
    const { tx, findFirst } = session()
    findFirst.mockResolvedValue(null)
    await expect(feedBrowser(tx, { id: taskId, needsBrowser: true })).resolves.toBeNull()
  })
})
