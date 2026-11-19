import {
  agentEventSchema,
  agentTodoLimits,
  isFeedText,
  todoProgressOf,
  type AgentEvent,
  type AgentTodoList,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { parseOpencodeEvent } from './opencode-events.ts'

// A `tool_use` row of `todowrite` as OpenCode 1.18.34 prints it (docs/plan/89-agent-todos.md, §2).
const todowrite = (state: Record<string, unknown>) =>
  parseOpencodeEvent(
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_test',
      part: { type: 'tool', tool: 'todowrite', callID: 'call_1', state },
    }),
  )
const written = (todos: unknown) => todowrite({ status: 'completed', input: { todos } })
const todo = (content: unknown, status: unknown = 'pending') => ({
  content,
  status,
  priority: 'medium',
})
/** The one list a row gave, after the shared schema. */
function listOf(events: AgentEvent[]): AgentTodoList {
  expect(events).toHaveLength(1)
  const [event] = events
  expect(agentEventSchema.safeParse(event).success).toBe(true)
  if (event?.type !== 'todo_list') throw new Error(`Not a list: ${JSON.stringify(event)}`)
  return event
}
const texts = (events: AgentEvent[]) => listOf(events).items.map((item) => item.text)

describe("the agent's to-do list (docs/plan/89-agent-todos.md, §5.2)", () => {
  it('reads the list of the input in its order, in place of the call', () => {
    const events = todowrite({
      status: 'completed',
      input: {
        todos: [
          todo('Посмотреть текущую страницу', 'completed'),
          todo('Подготовить текст страницы', 'in_progress'),
          todo('Опубликовать страницу'),
        ],
      },
      output: '[\n  {\n    "content": "…"\n  }\n]',
      title: '3 todos',
      metadata: { todos: [todo('Не этот список')], truncated: false },
    })
    expect(events).toEqual([
      {
        type: 'todo_list',
        items: [
          { text: 'Посмотреть текущую страницу', status: 'completed' },
          { text: 'Подготовить текст страницы', status: 'in_progress' },
          { text: 'Опубликовать страницу', status: 'pending' },
        ],
      },
    ])
    // Neither the priority nor the answer of the tool to the model goes on.
    expect(JSON.stringify(events)).not.toMatch(/priority|medium|todos|Не этот/)
  })

  it('takes the copy of the metadata when the input holds no list', () => {
    const fromMetadata = { metadata: { todos: [todo('Шаг из метаданных')], truncated: false } }
    for (const input of [undefined, {}, { todos: 'не список' }, { todos: { 0: todo('нет') } }])
      expect(texts(todowrite({ status: 'completed', input, ...fromMetadata }))).toEqual([
        'Шаг из метаданных',
      ])
  })

  it.each([
    ['completed', 'completed'],
    ['Complete', 'completed'],
    [' DONE ', 'completed'],
    ['finished', 'completed'],
    ['in_progress', 'in_progress'],
    ['In-Progress', 'in_progress'],
    ['active', 'in_progress'],
    ['blocked', 'in_progress'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['skipped', 'cancelled'],
    ['pending', 'pending'],
    ['waiting', 'pending'],
    ['', 'pending'],
    ['constructor', 'pending'],
    [42, 'pending'],
    [null, 'pending'],
    [undefined, 'pending'],
  ])('reads the status %j as %s', (status, expected) => {
    expect(listOf(written([todo('Шаг', status)])).items).toEqual([
      { text: 'Шаг', status: expected },
    ])
  })

  it('writes an item on one line, by the rules of the feed', () => {
    const marker = `[[raditi:phone:${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}]]`
    const shown = texts(
      written([
        todo('Собрать\nцены  из\r\nпрайса\tи   сверить'),
        todo('  \u0000До\u0000после  '),
        todo('Полови\ud83dна пары'),
        todo('\u202EНаправление\u2066 и\u200B \u200Bневидимое\uFEFF'),
        todo(`Позвонить ${marker}`),
        todo('Cafe\u0301 и NFC'),
      ]),
    )
    expect(shown).toEqual([
      'Собрать цены из прайса и сверить',
      'Допосле',
      'Половина пары',
      'Направление и невидимое',
      'Позвонить (телефон скрыт)',
      'Caf\u00e9 и NFC',
    ])
    for (const text of shown) expect(isFeedText(text)).toBe(true)
  })

  it('leaves out an item with nothing to read, and an entry that is not an item', () => {
    expect(
      texts(
        written([
          todo(''),
          todo('   \n\t'),
          todo('\u200B\u2060\uFEFF'),
          todo('\u0000'),
          todo(17),
          todo(null),
          { status: 'pending' },
          null,
          'Строка вместо пункта',
          7,
          ['Массив'],
          todo('Единственный пункт'),
        ]),
      ),
    ).toEqual(['Единственный пункт'])
  })

  it('keeps an item of the limit whole and cuts a longer one, never inside a pair', () => {
    const limit = agentTodoLimits.text
    expect(texts(written([todo('я'.repeat(limit))]))).toEqual(['я'.repeat(limit)])
    const [cut] = texts(written([todo('я'.repeat(limit + 100))]))
    expect(cut).toBe(`${'я'.repeat(limit - 1)}…`)
    // The 299th unit is the first half of a pair: the pair goes whole.
    const [pair] = texts(written([todo(`${'a'.repeat(limit - 2)}😀${'b'.repeat(10)}`)]))
    expect(pair).toBe(`${'a'.repeat(limit - 2)}…`)
    expect(pair!.isWellFormed()).toBe(true)
    // No space before the mark.
    const [spaced] = texts(written([todo(`${'a'.repeat(limit - 2)} ${'b'.repeat(10)}`)]))
    expect(spaced).toBe(`${'a'.repeat(limit - 2)}…`)
  })

  it('leaves completed items out from the head first, and counts them', () => {
    const items = [
      ...Array.from({ length: 20 }, (_, n) => todo(`Сделано ${n + 1}`, 'completed')),
      todo('Сейчас', 'in_progress'),
      ...Array.from({ length: 39 }, (_, n) => todo(`Впереди ${n + 1}`)),
    ]
    const list = listOf(written(items))
    expect(list.items).toHaveLength(agentTodoLimits.items)
    expect(list.omitted).toEqual({ completed: 10, other: 0 })
    expect(list.items[0]?.text).toBe('Сделано 11')
    expect(list.items.at(-1)?.text).toBe('Впереди 39')
    expect(todoProgressOf(list)).toMatchObject({ done: 20, total: 60, current: 10 })
  })

  it('cuts the tail when no completed item is left to leave out', () => {
    const list = listOf(written(Array.from({ length: 120 }, (_, n) => todo(`Шаг ${n + 1}`))))
    expect(list.items).toHaveLength(agentTodoLimits.items)
    expect(list.items.at(-1)?.text).toBe('Шаг 50')
    expect(list.omitted).toEqual({ completed: 0, other: 70 })
    expect(todoProgressOf(list)).toMatchObject({ done: 0, total: 120 })
  })

  it('leaves out every completed item before the tail, and counts no cancelled one there', () => {
    const list = listOf(
      written([
        ...Array.from({ length: 5 }, (_, n) => todo(`Сделано ${n + 1}`, 'done')),
        todo('Сейчас', 'in_progress'),
        ...Array.from({ length: 50 }, (_, n) => todo(`Впереди ${n + 1}`)),
        ...Array.from({ length: 4 }, (_, n) => todo(`Пропущено ${n + 1}`, 'skipped')),
      ]),
    )
    expect(list.items[0]).toEqual({ text: 'Сейчас', status: 'in_progress' })
    expect(list.items.at(-1)?.text).toBe('Впереди 49')
    expect(list.omitted).toEqual({ completed: 5, other: 1 })
    expect(todoProgressOf(list)).toMatchObject({ done: 5, total: 56, current: 0 })
  })

  it('counts only the items it read against the limit', () => {
    const list = listOf(
      written([
        ...Array.from({ length: 30 }, () => todo(' ')),
        ...Array.from({ length: 50 }, (_, n) => todo(`Шаг ${n + 1}`)),
      ]),
    )
    expect(list.items).toHaveLength(50)
    expect(list).not.toHaveProperty('omitted')
  })

  it('reads an empty list as no list', () => {
    expect(written([])).toEqual([{ type: 'todo_list', items: [] }])
  })

  it('leaves a call that failed, or holds no list, a call', () => {
    expect(
      todowrite({
        status: 'error',
        input: { todos: [todo('Шаг')] },
        error: 'Invalid input: todos.0.status',
      }),
    ).toEqual([{ type: 'tool_call', tool: 'todowrite', ok: false }])
    for (const state of [
      { status: 'completed', input: {} },
      { status: 'completed', input: { todos: 'не список' }, metadata: { truncated: false } },
      { status: 'completed' },
    ])
      expect(todowrite(state)).toEqual([{ type: 'tool_call', tool: 'todowrite', ok: true }])
    // Not finished yet: nothing, as with any other tool.
    expect(todowrite({ status: 'running', input: { todos: [todo('Шаг')] } })).toEqual([])
  })
})
