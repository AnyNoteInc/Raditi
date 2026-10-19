import { describe, expect, it, vi } from 'vitest'

import type { OutboxWriter } from './outbox.ts'
import { enqueueCandidateRebase, enqueueTurnCancel } from './task-commands-outbox.ts'

const taskId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'

function fakeWriter(count = 1) {
  const createMany = vi.fn().mockResolvedValue({ count })
  const writer = { outboxEvent: { createMany } } as unknown as OutboxWriter
  const rows = () => createMany.mock.calls.map(([args]) => args.data[0])
  return { writer, rows }
}

describe('the commands of a dialog on agent-turns', () => {
  it('writes the stop of a pass with ids only, keyed by the press', async () => {
    const { writer, rows } = fakeWriter()

    expect(
      await enqueueTurnCancel(writer, { taskId: taskId.toUpperCase(), requestEventId: '41' }),
    ).toBe(true)
    await enqueueTurnCancel(writer, { taskId, requestEventId: '42' })

    expect(rows()).toEqual([
      {
        topic: 'agent-turns',
        type: 'turn.cancel',
        payload: { taskId, requestEventId: '41' },
        dedupeKey: `turn.cancel:${taskId}:41`,
        availableAt: undefined,
      },
      {
        topic: 'agent-turns',
        type: 'turn.cancel',
        payload: { taskId, requestEventId: '42' },
        dedupeKey: `turn.cancel:${taskId}:42`,
        availableAt: undefined,
      },
    ])
  })

  it('writes «Обновить» as candidate.rebase and says false for a key that exists', async () => {
    const { writer, rows } = fakeWriter(0)

    expect(await enqueueCandidateRebase(writer, { taskId, requestEventId: '7' })).toBe(false)
    expect(rows()).toEqual([
      {
        topic: 'agent-turns',
        type: 'candidate.rebase',
        payload: { taskId, requestEventId: '7' },
        dedupeKey: `candidate.rebase:${taskId}:7`,
        availableAt: undefined,
      },
    ])
  })

  it('refuses a payload with anything but its ids before writing', async () => {
    const { writer, rows } = fakeWriter()
    await expect(
      enqueueTurnCancel(writer, { taskId, requestEventId: '7', by: 'customer' } as never),
    ).rejects.toThrow()
    await expect(enqueueCandidateRebase(writer, { taskId, requestEventId: 'x' })).rejects.toThrow()
    expect(rows()).toEqual([])
  })
})
