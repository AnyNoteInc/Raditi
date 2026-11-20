import type { AgentTodoItem } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import { readChatTodo } from './agent-todo.ts'
import type { PrismaClient, TurnStatus } from './generated/prisma/client.ts'

const databaseUrl = process.env.DATABASE_URL

describe('readChatTodo without a database', () => {
  it('asks once and answers a chat without turns with no facts', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([])
    expect(
      await readChatTodo({ $queryRaw } as never, '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'),
    ).toEqual({ latest: null, previous: null })
    expect($queryRaw).toHaveBeenCalledTimes(1)
  })
})

// The plan of the agent beside the chat (docs/plan/89-agent-todos.md, ТД4, §5.3): the last list
// of the last two counted turns, read from the journal through task_events_todo_list_idx.
describe.skipIf(!databaseUrl)('PostgreSQL: the plan of the agent in the journal (plan 89)', () => {
  let schema: MigratedSchema
  let db: PrismaClient
  const workspaces: string[] = []
  const image = `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`

  beforeAll(async () => {
    // A turn needs the `opencode` row of agent_drivers: in a schema of its own the test neither
    // depends on the seeds of the database it was given nor leaves that row in it.
    schema = await createMigratedSchema(databaseUrl ?? '', 'agent_todo')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
    await db.agentDriver.upsert({
      where: { id: 'opencode' },
      update: {},
      create: { id: 'opencode', image, capabilities: {}, enabled: true },
    })
  }, 60_000)
  afterEach(async () => {
    const ids = workspaces.splice(0)
    await db.task.deleteMany({ where: { workspaceId: { in: ids } } })
    await db.workspace.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  }, 60_000)

  async function chat() {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic plan verification', dataClass: 'synthetic' },
    })
    workspaces.push(workspace.id)
    const task = await db.task.create({
      data: { workspaceId: workspace.id, status: 'running', modelClass: 'standard' },
    })
    return task.id
  }

  async function turn(
    taskId: string,
    turnNo: number,
    status: TurnStatus,
    marks: { rejected?: boolean; undone?: boolean } = {},
  ) {
    const row = await db.taskTurn.create({
      data: {
        taskId,
        turnNo,
        status,
        driverId: 'opencode',
        image,
        rejectedAt: marks.rejected === true ? new Date() : null,
        undoneAt: marks.undone === true ? new Date() : null,
      },
    })
    return row.id
  }

  /** A batch of the agent's output, as the journal of core writes it. */
  const output = (taskId: string, turnId: string, turnNo: number, events: unknown[]) =>
    db.taskEvent.create({
      data: {
        taskId,
        turnId,
        type: 'turn.output',
        clientVisible: false,
        payload: { turn: turnNo, phase: 'output', events } as never,
      },
    })

  const items = (...texts: string[]): AgentTodoItem[] =>
    texts.map((text, index) => ({ text, status: index === 0 ? 'in_progress' : 'pending' }))
  const todo = (list: AgentTodoItem[], extra: Record<string, unknown> = {}) => ({
    type: 'todo_list',
    items: list,
    ...extra,
  })

  it('answers a chat without turns with no facts', async () => {
    expect(await readChatTodo(db, await chat())).toEqual({ latest: null, previous: null })
  })

  it('takes the list of the newest row, and of a row its last list', async () => {
    const taskId = await chat()
    const id = await turn(taskId, 1, 'running')
    await output(taskId, id, 1, [
      todo(items('Найти шапку', 'Поменять телефон')),
      { type: 'message', text: 'Смотрю шапку.' },
    ])
    await output(taskId, id, 1, [
      todo(items('Первый', 'Второй')),
      { type: 'command', command: 'ls', exitCode: 0 },
      todo(items('Поменять телефон', 'Проверить сайт'), { omitted: { completed: 1, other: 0 } }),
      { type: 'message', text: 'Меняю.' },
    ])
    // A later batch without a list does not take the list away.
    await output(taskId, id, 1, [{ type: 'message', text: 'Проверяю.' }])

    expect(await readChatTodo(db, taskId)).toEqual({
      latest: {
        turn: 1,
        status: 'running',
        rejected: false,
        list: {
          items: items('Поменять телефон', 'Проверить сайт'),
          omitted: { completed: 1, other: 0 },
        },
      },
      previous: null,
    })
  })

  it('gives the turn before with its own list, and the status and the refusal of each', async () => {
    const taskId = await chat()
    const first = await turn(taskId, 1, 'completed', { rejected: true })
    await output(taskId, first, 1, [todo(items('Найти', 'Сделать'))])
    await turn(taskId, 2, 'pending')

    expect(await readChatTodo(db, taskId)).toEqual({
      latest: { turn: 2, status: 'pending', rejected: false, list: null },
      previous: {
        turn: 1,
        status: 'completed',
        rejected: true,
        list: { items: items('Найти', 'Сделать') },
      },
    })
  })

  it('counts only the last two turns that are not undone', async () => {
    const taskId = await chat()
    const first = await turn(taskId, 1, 'completed')
    await output(taskId, first, 1, [todo(items('Первый ход', 'Его шаг'))])
    const second = await turn(taskId, 2, 'cancelled')
    await output(taskId, second, 2, [todo(items('Второй ход', 'Его шаг'))])
    const third = await turn(taskId, 3, 'completed', { undone: true })
    await output(taskId, third, 3, [todo(items('Отменённый ход', 'Его шаг'))])

    const facts = await readChatTodo(db, taskId)
    expect(facts.latest).toMatchObject({ turn: 2, status: 'cancelled' })
    expect(facts.latest?.list?.items[0]?.text).toBe('Второй ход')
    expect(facts.previous).toMatchObject({ turn: 1, status: 'completed' })
    expect(facts.previous?.list?.items[0]?.text).toBe('Первый ход')
  })

  it('gives a turn without a list as one without, and never the list of another turn', async () => {
    const taskId = await chat()
    const first = await turn(taskId, 1, 'completed')
    await output(taskId, first, 1, [todo(items('Найти', 'Сделать'))])
    const second = await turn(taskId, 2, 'failed')
    await output(taskId, second, 2, [{ type: 'tool_call', tool: 'todowrite', ok: false }])

    const facts = await readChatTodo(db, taskId)
    expect(facts.latest).toEqual({ turn: 2, status: 'failed', rejected: false, list: null })
    expect(facts.previous?.list).not.toBeNull()
  })

  it('reads an emptied list as a list, and an event that does not read as none', async () => {
    const taskId = await chat()
    const first = await turn(taskId, 1, 'completed')
    await output(taskId, first, 1, [todo([])])
    const second = await turn(taskId, 2, 'running')
    // The last event of the row is the one read: an item with an unknown status breaks it.
    await output(taskId, second, 2, [
      todo(items('Найти', 'Сделать')),
      { type: 'todo_list', items: [{ text: 'Найти', status: 'waiting' }] },
    ])

    expect(await readChatTodo(db, taskId)).toEqual({
      latest: { turn: 2, status: 'running', rejected: false, list: null },
      previous: { turn: 1, status: 'completed', rejected: false, list: { items: [] } },
    })
  })

  it('reads the rows of a turn through the partial index: the predicate is the index’s', async () => {
    const taskId = await chat()
    const id = await turn(taskId, 1, 'running')
    await output(taskId, id, 1, [todo(items('Найти', 'Сделать'))])
    // The very statement of readChatTodo, planned as on a large table: a predicate that differs
    // from the index's by a cast or a parameter would leave the planner the plain turn_id index.
    let statement = ''
    let values: unknown[] = []
    await readChatTodo(
      {
        $queryRaw: async (strings: TemplateStringsArray, ...given: unknown[]) => {
          statement = strings.reduce((text, part, index) => `${text}$${index}${part}`)
          values = given
          return []
        },
      } as never,
      taskId,
    )
    await schema.db.query('SET enable_seqscan = off')
    try {
      const plan = await schema.db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement}`, values)
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'task_events_todo_list_idx',
      )
    } finally {
      await schema.db.query('RESET enable_seqscan')
    }
  })
})
