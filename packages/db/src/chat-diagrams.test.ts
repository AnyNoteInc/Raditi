import { describe, expect, it, vi } from 'vitest'

import { DIAGRAM_RETRY_MS } from './artifact-diagrams.ts'
import { readChatDiagram } from './chat-diagrams.ts'

// A diagram of the chat asked again after its window (docs/plan/91-chat-diagrams.md, Д5): a job
// that drew nothing must not leave the diagram undrawn for good.

const taskId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const workspaceId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
const userId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a62'

function fakeDb() {
  return {
    taskEvent: {
      findFirst: vi.fn(async () => ({
        payload: { message: '```mermaid\nflowchart LR\n  A --> B\n```' },
        task: { workspaceId },
      })),
    },
    chatDiagramRender: { findUnique: vi.fn(async () => null) },
    outboxEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
  }
}

const keysOf = (db: ReturnType<typeof fakeDb>) =>
  db.outboxEvent.createMany.mock.calls.map(
    (call) => (call as unknown as [{ data: { dedupeKey: string }[] }])[0].data[0]!.dedupeKey,
  )

describe('a diagram of the chat not drawn yet', () => {
  it('is asked once within a window and again after it', async () => {
    const db = fakeDb()
    const input = { taskId, row: '42', index: 0, userId }
    const at = new Date('2026-11-25T12:00:10.000Z')
    for (const now of [
      at,
      new Date(at.getTime() + 30_000),
      new Date(at.getTime() + DIAGRAM_RETRY_MS),
    ])
      expect(await readChatDiagram(db as never, { ...input, now })).toEqual({ state: 'drawing' })
    // The reader's access is part of the one query of the row.
    expect(db.taskEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          task: expect.objectContaining({ workspace: { members: { some: { userId } } } }),
        }),
      }),
    )
    const [first, second, third] = keysOf(db)
    expect(first).toBe(second)
    expect(third).not.toBe(first)
    expect(first).toMatch(new RegExp(`^chat\\.diagram:${workspaceId}:[0-9a-f]{64}:\\d+$`))
  })

  it('is NOT_FOUND for a chat the reader may not open, and asks nothing', async () => {
    const db = fakeDb()
    db.taskEvent.findFirst.mockResolvedValueOnce(null as never)
    await expect(
      readChatDiagram(db as never, { taskId, row: '42', index: 0, userId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(db.outboxEvent.createMany).not.toHaveBeenCalled()
  })
})
