import { describe, expect, it, vi } from 'vitest'

import { enqueueAgentTurn, enqueueAgentWaitingPasses, enqueueBrowserEnsure } from './chat-outbox.ts'
import type { Prisma } from './generated/prisma/client.ts'
import type { OutboxWriter } from './outbox.ts'

const taskId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const requestId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a62'

function fakeWriter(count = 1) {
  const createMany = vi.fn().mockResolvedValue({ count })
  const writer = {
    outboxEvent: { createMany },
    // The workspace of the task is on «Бизнес».
    $queryRaw: vi.fn(tierAnswers('business')),
  } as unknown as OutboxWriter & Pick<Prisma.TransactionClient, '$queryRaw'>
  const rows = () => createMany.mock.calls.map(([args]) => args.data[0])
  return { writer, rows }
}

/** What the queries of the tier answer (`agentTurnPriority`): the task's workspace on `slug`. */
const tierAnswers =
  (slug: string) =>
  async (query: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
    const sql = query.join('?')
    if (sql.includes('FROM tasks WHERE id')) return [{ workspaceId: taskId }]
    if (sql.includes('FROM subscriptions s JOIN plans p'))
      return [
        { status: 'active', slug, creditsPer5h: 70, creditsPerWeek: 210, maxConcurrentTurns: 2 },
      ]
    return []
  }

describe('enqueueAgentTurn', () => {
  it('writes the pass of a request to agent-turns with ids only', async () => {
    const { writer, rows } = fakeWriter()

    const written = await enqueueAgentTurn(writer, {
      taskId: taskId.toUpperCase(),
      attempt: 2,
      requestEventId: '41',
    })

    expect(written).toBe(true)
    expect(rows()).toEqual([
      {
        topic: 'agent-turns',
        type: 'turn.run',
        payload: { taskId, attempt: 2, requestEventId: '41', priority: 2 },
        dedupeKey: `turn.run:${taskId}:2:41`,
        availableAt: undefined,
      },
    ])
  })

  it('keeps a priority the job already carries, a repeat after a wait of the pool', async () => {
    const { writer, rows } = fakeWriter()
    await enqueueAgentTurn(writer, { taskId, attempt: 1, requestEventId: '8', priority: 1 })
    expect(rows()[0]?.payload).toMatchObject({ priority: 1 })
  })

  it('says false when the key already exists', async () => {
    const { writer } = fakeWriter(0)
    await expect(
      enqueueAgentTurn(writer, { taskId, attempt: 1, requestEventId: '7' }),
    ).resolves.toBe(false)
  })

  it('refuses a payload with anything but its ids before writing', async () => {
    const { writer, rows } = fakeWriter()
    await expect(
      enqueueAgentTurn(writer, {
        taskId,
        attempt: 1,
        requestEventId: '7',
        text: 'слова клиента',
      } as never),
    ).rejects.toThrow()
    expect(rows()).toEqual([])
  })
})

describe('enqueueBrowserEnsure', () => {
  it('keys the job by its session and window, on a queue of its own, in lower case', async () => {
    const { writer, rows } = fakeWriter()
    const sessionId = requestId.toUpperCase()

    await enqueueBrowserEnsure(writer, { taskId, sessionId }, { window: 7 })

    expect(rows()).toEqual([
      {
        topic: 'browser-sessions',
        type: 'browser.ensure',
        payload: { taskId, sessionId: requestId },
        dedupeKey: `browser.ensure:${requestId}:7`,
      },
    ])
  })
})

describe('enqueueAgentWaitingPasses', () => {
  const workspaceId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a66'

  // The tier is the only thing that sets the tariffs apart in the pool now (owner's answer of
  // 13.11.2026, Л8 removed): a woken pass keeps its place among the tiers, and BullMQ takes a job
  // without a priority before every one with it.
  it('puts the passes that wait for the agents back with the priority of their tier', async () => {
    const { writer, rows } = fakeWriter()
    const $queryRaw = vi
      .fn(tierAnswers('agency'))
      .mockResolvedValueOnce([{ id: taskId.toUpperCase(), attempt: 3, request_id: 41n }])
    const put = await enqueueAgentWaitingPasses({ ...writer, $queryRaw } as never, {
      workspaceId,
      limit: 8,
      tag: `pass-${taskId}-1-4`,
    })
    expect(put).toBe(1)
    expect(rows()).toEqual([
      {
        topic: 'agent-turns',
        type: 'turn.run',
        payload: { taskId, attempt: 3, requestEventId: '41', priority: 1 },
        dedupeKey: `turn.run:${taskId}:3:41:retry:pass-${taskId}-1-4`,
        availableAt: undefined,
      },
    ])
    const sql = ($queryRaw.mock.calls[0]![0] as unknown as string[]).join('?')
    expect(sql).toContain("t.status = 'queued' AND t.waiting = 'agents'")
  })
})
