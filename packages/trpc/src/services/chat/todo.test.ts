import type { PrismaClient } from '@repo/db'
import { describe, expect, it, vi } from 'vitest'

import { chatTodo } from './todo.ts'

const userId = '0199a3f2-0000-7000-8000-0000000000a1'
const taskId = '0199a3f2-0000-7000-8000-0000000000b1'

/** A row of readChatTodo: one counted turn and the last `todo_list` event it wrote. */
type TurnRow = { turn_no: number; status: string; rejected: boolean; list: unknown }

function setup(rows: TurnRow[], options: { task?: boolean } = {}) {
  const db = {
    task: { findFirst: vi.fn(async () => (options.task === false ? null : { id: taskId })) },
    $queryRaw: vi.fn(async () => rows),
  }
  const read = () =>
    chatTodo(db as unknown as Pick<PrismaClient, 'task' | '$queryRaw'>, { userId, taskId })
  return { db, read }
}

const plan = [
  { text: 'Найти шапку сайта', status: 'completed' },
  { text: 'Поменять телефон', status: 'in_progress' },
  { text: 'Проверить страницу', status: 'pending' },
] as const
const todo = (items: readonly unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'todo_list',
  items,
  ...extra,
})

// «План работы» beside the chat (docs/plan/87-agent-todos.md, §5.3): who may read it, and what
// of the journal facts reaches the page.
describe('chatTodo', () => {
  it('reads the plan of a chat of the user, and only then the journal', async () => {
    const { db, read } = setup([])
    expect(await read()).toBeNull()
    expect(db.task.findFirst.mock.calls[0]).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          id: taskId,
          deletedAt: null,
          workspace: { members: { some: { userId } } },
        }),
      }),
    ])
    expect(db.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('answers someone else’s chat as one that does not exist, before the journal', async () => {
    const { db, read } = setup([], { task: false })
    await expect(read()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('gives the list of the turn at work, and what the driver left out', async () => {
    const { read } = setup([
      {
        turn_no: 3,
        status: 'running',
        rejected: false,
        list: todo(plan, { omitted: { completed: 2, other: 0 } }),
      },
    ])
    expect(await read()).toEqual({
      turn: 3,
      state: 'working',
      items: plan,
      omitted: { completed: 2, other: 0 },
    })
  })

  it('carries the unfinished list of a turn that ended well into the turn at work', async () => {
    const { read } = setup([
      { turn_no: 2, status: 'pending', rejected: false, list: null },
      { turn_no: 1, status: 'completed', rejected: false, list: todo(plan) },
    ])
    expect(await read()).toEqual({ turn: 1, state: 'carried', items: plan })
  })

  it.each([
    ['completed', false, 'ended'],
    ['cancelled', false, 'stopped'],
    ['failed', false, 'failed'],
    ['lost', false, 'failed'],
    ['completed', true, 'failed'],
  ] as const)('tells a turn that is %s (refused: %s) as %s', async (status, rejected, state) => {
    const { read } = setup([{ turn_no: 4, status, rejected, list: todo(plan) }])
    expect(await read()).toMatchObject({ turn: 4, state })
  })

  it('shows no plan of one item, and none of a list that does not read', async () => {
    expect(
      await setup([
        { turn_no: 1, status: 'running', rejected: false, list: todo(plan.slice(0, 1)) },
      ]).read(),
    ).toBeNull()
    expect(
      await setup([
        {
          turn_no: 1,
          status: 'running',
          rejected: false,
          list: todo([{ text: 'Шаг', status: 'waiting' }, ...plan]),
        },
      ]).read(),
    ).toBeNull()
  })

  it('keeps of an item only its words and its status', async () => {
    const { read } = setup([
      {
        turn_no: 1,
        status: 'running',
        rejected: false,
        list: todo(plan.map((item) => ({ ...item, id: 'x1', priority: 'high' }))),
      },
    ])
    expect(await read()).toEqual({ turn: 1, state: 'working', items: plan })
  })
})
