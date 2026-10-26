import type { PrismaClient } from '@repo/db'
import { describe, expect, it, vi } from 'vitest'

import { activityLimits, readTurnActivity, shownActivity } from './activity.ts'

const userId = '0199a3f2-0000-7000-8000-0000000000a1'
const taskId = '0199a3f2-0000-7000-8000-0000000000b1'

type Row = { id: bigint; payload: unknown }

function setup(rows: Row[], options: { task?: boolean } = {}) {
  const db = {
    task: { findFirst: vi.fn(async () => (options.task === false ? null : { id: taskId })) },
    taskEvent: {
      findMany: vi.fn(async ({ take }: { take: number }) => rows.slice(0, take)),
    },
  }
  const read = (after = '0') =>
    readTurnActivity(db as unknown as Pick<PrismaClient, 'task' | 'taskEvent'>, {
      userId,
      taskId,
      turn: 2,
      after,
    })
  return { db, read }
}

const output = (id: bigint, events: unknown[]): Row => ({
  id,
  payload: { turn: 2, phase: 'output', cursor: { stdout: 1, stderr: 0 }, events },
})

describe('readTurnActivity', () => {
  it('reads the turn rows of the journal after the cursor, for a member of the task', async () => {
    const { db, read } = setup([])
    await read('41')
    expect(db.task.findFirst.mock.calls[0]).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          id: taskId,
          workspace: { members: { some: { userId } } },
        }),
      }),
    ])
    expect(db.taskEvent.findMany.mock.calls[0]).toEqual([
      expect.objectContaining({
        where: {
          taskId,
          type: 'turn.output',
          id: { gt: 41n },
          payload: { path: ['turn'], equals: 2 },
        },
        orderBy: { id: 'asc' },
      }),
    ])
  })

  it('answers someone else’s task as one that does not exist', async () => {
    await expect(setup([], { task: false }).read()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('gives messages, commands, tool calls, files and questions, and nothing else', async () => {
    const { read } = setup([
      output(7n, [
        { type: 'started', nativeSessionId: 'ses_1' },
        { type: 'message', text: 'Смотрю тему сайта.' },
        { type: 'command', command: 'ls wp-content/themes', exitCode: 0 },
        { type: 'tool_call', tool: 'raditi_site_info', ok: true },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
      ]),
      output(9n, [
        { type: 'file_change', path: 'wp-content/themes/a/style.css', change: 'update' },
        { type: 'command', command: 'php -l x.php', exitCode: 255 },
        { type: 'tool_call', tool: 'raditi_wp_rest', ok: false },
        { type: 'question', text: 'Какой цвет?', options: ['Синий'] },
        { type: 'failed', reason: 'provider said 500' },
        { type: 'completed' },
      ]),
    ])
    expect(await read()).toEqual({
      events: [
        { id: '7:1', type: 'message', text: 'Смотрю тему сайта.' },
        { id: '7:2', type: 'command', command: 'ls wp-content/themes', exitCode: 0 },
        { id: '7:3', type: 'tool_call', tool: 'raditi_site_info', ok: true },
        { id: '9:0', type: 'file_change', path: 'wp-content/themes/a/style.css', change: 'update' },
        { id: '9:1', type: 'command', command: 'php -l x.php', exitCode: 255 },
        { id: '9:2', type: 'tool_call', tool: 'raditi_wp_rest', ok: false },
        { id: '9:3', type: 'question', text: 'Какой цвет?', options: ['Синий'] },
      ],
      cursor: '9',
      more: false,
    })
  })

  it('passes over an event that does not read and a row without events, and moves past them', async () => {
    const { read } = setup([
      output(3n, [{ type: 'message', text: 42 }, { type: 'command' }]),
      { id: 4n, payload: null },
      output(5n, [{ type: 'message', text: 'Готово.' }]),
    ])
    expect(await read()).toEqual({
      events: [{ id: '5:0', type: 'message', text: 'Готово.' }],
      cursor: '5',
      more: false,
    })
  })

  it('keeps the cursor where it was when there is nothing new', async () => {
    expect(await setup([]).read('12')).toEqual({ events: [], cursor: '12', more: false })
  })

  it('ends a page at its row limit and after the row that fills it', async () => {
    const many = Array.from({ length: activityLimits.rows + 1 }, (_, index) =>
      output(BigInt(index + 1), [{ type: 'message', text: `шаг ${index}` }]),
    )
    const page = await setup(many).read()
    expect(page.events).toHaveLength(activityLimits.rows)
    expect(page.cursor).toBe(String(activityLimits.rows))
    expect(page.more).toBe(true)

    const full = Array.from({ length: activityLimits.events }, () => ({
      type: 'command',
      command: 'true',
      exitCode: 0,
    }))
    const filled = await setup([
      output(1n, full),
      output(2n, [{ type: 'message', text: 'дальше' }]),
    ]).read()
    expect(filled.events).toHaveLength(activityLimits.events)
    expect(filled).toMatchObject({ cursor: '1', more: true })

    const long = 'а'.repeat(activityLimits.text)
    const wordy = await setup([
      output(1n, [{ type: 'message', text: long.slice(0, 20_000) }]),
      ...Array.from({ length: 20 }, (_, index) =>
        output(BigInt(index + 2), [{ type: 'message', text: long.slice(0, 20_000) }]),
      ),
    ]).read()
    expect(wordy.more).toBe(true)
    expect(wordy.events.length).toBeLessThan(21)
  })
})

describe('shownActivity', () => {
  it('does not repeat the turn’s result object as words of the agent', () => {
    expect(
      shownActivity({
        type: 'message',
        text: '{"summary":"x","client_message":"Готово","change_type":"none"}',
      }),
    ).toBeNull()
    expect(shownActivity({ type: 'message', text: '   ' })).toBeNull()
    expect(shownActivity({ type: 'message', text: 'Проверяю.' })).toEqual({
      type: 'message',
      text: 'Проверяю.',
    })
  })
})
