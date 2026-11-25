import { describe, expect, it, vi } from 'vitest'

import { ChatDiagram } from './chat-diagram.ts'

// A diagram of an answer in the chat (docs/plan/91-chat-diagrams.md, Д3–Д5).

const taskId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const workspaceId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
const message =
  'Вот так:\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```plantuml\nAlice -> Bob\n```'

function dbWith(text: string | null, kept: unknown = null) {
  return {
    taskEvent: {
      findFirst: vi.fn(async () =>
        text === null ? null : { payload: { message: text }, task: { workspaceId } },
      ),
    },
    chatDiagramRender: {
      findUnique: vi.fn(async () => kept),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
  }
}

const drawn = {
  ok: true as const,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  width: 1,
  height: 1,
  type: 'plantuml',
}

describe('a diagram of the chat drawn by core', () => {
  it('draws the diagram at its place in the answer, by its engine, and keeps it', async () => {
    const db = dbWith(message)
    const draw = vi.fn(async () => drawn)
    await new ChatDiagram({ db: db as never, draw }).run({ taskId, row: '42', index: 1 })
    expect(draw).toHaveBeenCalledWith({ workspaceId, source: 'Alice -> Bob', engine: 'plantuml' })
    expect(db.taskEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 42n, taskId, clientVisible: true }),
      }),
    )
    const saved = db.chatDiagramRender.createMany.mock.calls[0] as unknown as [
      { data: { engine: string; workspaceId: string }[] },
    ]
    expect(saved[0].data[0]).toMatchObject({ engine: 'plantuml', workspaceId, ok: true })
  })

  it('does nothing for a kept picture, a row gone, a place with no diagram, or without a worker', async () => {
    const draw = vi.fn()
    const job = { taskId, row: '42', index: 0 }
    await new ChatDiagram({ db: dbWith(message, { ok: true }) as never, draw }).run(job)
    await new ChatDiagram({ db: dbWith(null) as never, draw }).run(job)
    await new ChatDiagram({ db: dbWith(message) as never, draw }).run({ ...job, index: 2 })
    await new ChatDiagram({ db: dbWith(message) as never, draw: null }).run(job)
    expect(draw).not.toHaveBeenCalled()
  })
})
