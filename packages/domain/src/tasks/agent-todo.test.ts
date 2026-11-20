import { describe, expect, it } from 'vitest'

import { agentEventSchema } from '../ports/agent-driver.ts'
import { ENV_VALUE_MASK } from '../release/env-masking.ts'

import { hiddenContactText } from './client-feed-text.ts'

import {
  agentTodoLimits,
  agentTodoListSchema,
  chatTodoOf,
  chatTodoSchema,
  todoItemCount,
  todoListReadsRussian,
  todoPlatformWords,
  todoProgressOf,
  todoStepKey,
  todoTurnStatuses,
  todoUnfinished,
  type AgentTodoItem,
  type AgentTodoList,
  type TodoTurnStatus,
  type TurnTodoFacts,
} from './agent-todo.ts'

const item = (text: string, status: AgentTodoItem['status']): AgentTodoItem => ({ text, status })

const plan: AgentTodoList = {
  items: [
    item('Посмотрели текущую страницу', 'completed'),
    item('Собрали цены из прайса', 'completed'),
    item('Готовим текст страницы', 'in_progress'),
    item('Публикуем страницу', 'pending'),
    item('Проверяем адрес', 'cancelled'),
  ],
}
const finished: AgentTodoList = {
  items: [item('Готовим текст', 'completed'), item('Публикуем', 'completed')],
}

const turn = (
  no: number,
  status: TodoTurnStatus,
  list: AgentTodoList | null,
  rejected = false,
): TurnTodoFacts => ({ turn: no, status, rejected, list })

describe('the todo_list event', () => {
  it('is a common agent event with the bounds of a list', () => {
    expect(agentEventSchema.safeParse({ type: 'todo_list', ...plan }).success).toBe(true)
    expect(agentEventSchema.safeParse({ type: 'todo_list', items: [] }).success).toBe(true)
    const tooMany = Array.from({ length: agentTodoLimits.items + 1 }, (_, n) =>
      item(`Шаг ${n}`, 'pending'),
    )
    expect(agentEventSchema.safeParse({ type: 'todo_list', items: tooMany }).success).toBe(false)
    const long = item('я'.repeat(agentTodoLimits.text + 1), 'pending')
    expect(agentEventSchema.safeParse({ type: 'todo_list', items: [long] }).success).toBe(false)
  })

  it('refuses an empty item, a status of its own and a negative count left out', () => {
    expect(agentTodoListSchema.safeParse({ items: [item('', 'pending')] }).success).toBe(false)
    expect(agentTodoListSchema.safeParse({ items: [{ text: 'a', status: 'done' }] }).success).toBe(
      false,
    )
    expect(
      agentTodoListSchema.safeParse({ items: [], omitted: { completed: -1, other: 0 } }).success,
    ).toBe(false)
  })
})

describe('todoProgressOf', () => {
  it('counts the done ones out of the ones not cancelled and finds the item at work', () => {
    expect(todoProgressOf(plan)).toEqual({ done: 2, total: 4, current: 2, abandoned: false })
  })

  it('counts the items left out over the limit', () => {
    const cut: AgentTodoList = { ...plan, omitted: { completed: 20, other: 3 } }
    expect(todoProgressOf(cut)).toEqual({ done: 22, total: 27, current: 2, abandoned: false })
    expect(todoItemCount(cut)).toBe(28)
  })

  it('takes the first of two items at work and none when nothing is at work', () => {
    const two: AgentTodoList = {
      items: [item('а', 'in_progress'), item('б', 'in_progress'), item('в', 'pending')],
    }
    expect(todoProgressOf(two).current).toBe(0)
    expect(todoProgressOf(finished).current).toBeNull()
  })

  it('tells a list the agent cancelled whole', () => {
    const cancelled: AgentTodoList = { items: [item('а', 'cancelled'), item('б', 'cancelled')] }
    expect(todoProgressOf(cancelled)).toEqual({ done: 0, total: 0, current: null, abandoned: true })
    expect(todoProgressOf({ items: [] }).abandoned).toBe(false)
  })
})

describe('todoUnfinished', () => {
  it('is true while an item is ahead, at work or left out of the tail', () => {
    expect(todoUnfinished(plan)).toBe(true)
    expect(todoUnfinished(finished)).toBe(false)
    expect(todoUnfinished({ ...finished, omitted: { completed: 0, other: 1 } })).toBe(true)
    expect(todoUnfinished({ items: [item('а', 'completed'), item('б', 'cancelled')] })).toBe(false)
  })
})

describe('todoListReadsRussian', () => {
  it('judges the whole list: one Russian item is enough, none — not Russian', () => {
    expect(todoListReadsRussian(plan.items)).toBe(true)
    expect(todoListReadsRussian([item('Update SEO', 'pending'), item('Обновить', 'pending')])).toBe(
      true,
    )
    expect(todoListReadsRussian([item('Read page', 'pending'), item('Deploy', 'pending')])).toBe(
      false,
    )
    expect(todoListReadsRussian([])).toBe(false)
  })

  it('does not count the words the platform put into an English list', () => {
    for (const word of todoPlatformWords)
      expect(
        todoListReadsRussian([
          item(`Open ${word} in the editor`, 'in_progress'),
          item('Update the header', 'pending'),
        ]),
      ).toBe(false)
    expect(
      todoListReadsRussian([item('Открыть [скрыто]', 'in_progress'), item('Deploy', 'pending')]),
    ).toBe(true)
  })

  it('knows every word the platform puts in', () => {
    expect(todoPlatformWords).toEqual([ENV_VALUE_MASK, ...Object.values(hiddenContactText)])
  })
})

describe('todoStepKey', () => {
  it('changes with the count done or the item at work, not with a rewrite of the rest', () => {
    const rewritten: AgentTodoList = {
      items: plan.items.map((entry, n) => (n === 3 ? item('Другая публикация', 'pending') : entry)),
    }
    expect(todoStepKey(rewritten)).toBe(todoStepKey(plan))
    const next: AgentTodoList = {
      items: plan.items.map((entry, n) =>
        n === 2 ? item(entry.text, 'completed') : n === 3 ? item(entry.text, 'in_progress') : entry,
      ),
    }
    expect(todoStepKey(next)).not.toBe(todoStepKey(plan))
    expect(todoStepKey(plan)).toBe('2/4:Готовим текст страницы')
  })
})

describe('chatTodoOf', () => {
  it('has no plan without a turn', () => {
    expect(chatTodoOf(null, null)).toBeNull()
  })

  it.each([
    ['pending', 'working'],
    ['running', 'working'],
    ['completed', 'ended'],
    ['cancelled', 'stopped'],
    ['failed', 'failed'],
    ['timed_out', 'failed'],
    ['lost', 'failed'],
  ] as const)('shows the list of the last turn %s as %s', (status, state) => {
    expect(chatTodoOf(turn(3, status, plan), turn(2, 'completed', finished))).toEqual({
      turn: 3,
      state,
      items: plan.items,
    })
  })

  it('covers every status of a turn', () => {
    expect([...todoTurnStatuses].sort()).toEqual(
      ['cancelled', 'completed', 'failed', 'lost', 'pending', 'running', 'timed_out'].sort(),
    )
  })

  // ТД17 (chat 01a1f7bc, 20.11.2026): the answer said all was done, two items stayed open.
  it('closes the plan of a turn that ended with the agent answer', () => {
    const answered = { ...turn(3, 'completed', plan), answered: true }
    expect(chatTodoOf(answered, null)).toEqual({
      turn: 3,
      state: 'ended',
      items: [
        item('Посмотрели текущую страницу', 'completed'),
        item('Собрали цены из прайса', 'completed'),
        item('Готовим текст страницы', 'completed'),
        item('Публикуем страницу', 'completed'),
        item('Проверяем адрес', 'cancelled'),
      ],
    })
    const cut = { ...answered, list: { ...plan, omitted: { completed: 1, other: 2 } } }
    expect(chatTodoOf(cut, null)?.omitted).toEqual({ completed: 3, other: 0 })
    // Nor is it carried into the next turn: the answer closed it.
    expect(chatTodoOf(turn(4, 'running', null), answered)).toBeNull()
  })

  it('keeps the list as the agent left it after a question, a stop, a failure or a refusal', () => {
    // A turn that ended with a question has no `feed.result`: not answered.
    expect(chatTodoOf(turn(3, 'completed', plan), null)?.items).toEqual(plan.items)
    expect(chatTodoOf(turn(4, 'running', null), turn(3, 'completed', plan))?.state).toBe('carried')
    for (const status of ['cancelled', 'failed', 'lost'] as const)
      expect(chatTodoOf({ ...turn(3, status, plan), answered: true }, null)?.items).toEqual(
        plan.items,
      )
    expect(
      chatTodoOf({ ...turn(3, 'completed', plan, true), answered: true }, null)?.items,
    ).toEqual(plan.items)
  })

  it('shows a refused turn as broken off, whatever its status', () => {
    expect(chatTodoOf(turn(3, 'completed', plan, true), null)?.state).toBe('failed')
  })

  it('keeps the count left out', () => {
    const cut: AgentTodoList = { ...plan, omitted: { completed: 4, other: 0 } }
    expect(chatTodoOf(turn(1, 'running', cut), null)).toEqual({
      turn: 1,
      state: 'working',
      items: plan.items,
      omitted: { completed: 4, other: 0 },
    })
  })

  it('shows no list of fewer than two items', () => {
    const one: AgentTodoList = { items: [item('Один шаг', 'in_progress')] }
    expect(chatTodoOf(turn(1, 'running', one), null)).toBeNull()
    expect(
      chatTodoOf(turn(1, 'running', { ...one, omitted: { completed: 1, other: 0 } }), null),
    ).not.toBeNull()
  })

  it('counts steps without the cancelled ones, yet shows a plan cancelled whole', () => {
    const oneStep: AgentTodoList = {
      items: [item('Старый шаг', 'cancelled'), item('Поменять телефон', 'in_progress')],
    }
    expect(chatTodoOf(turn(1, 'running', oneStep), null)).toBeNull()
    const cancelled: AgentTodoList = { items: [item('а', 'cancelled'), item('б', 'cancelled')] }
    expect(chatTodoOf(turn(1, 'completed', cancelled), null)?.state).toBe('ended')
    expect(chatTodoOf(turn(1, 'completed', { items: [item('а', 'cancelled')] }), null)).toBeNull()
  })

  it('carries the unfinished list of a turn that ended well into the turn at work', () => {
    expect(chatTodoOf(turn(4, 'running', null), turn(3, 'completed', plan))).toEqual({
      turn: 3,
      state: 'carried',
      items: plan.items,
    })
    expect(chatTodoOf(turn(4, 'pending', null), turn(3, 'completed', plan))?.state).toBe('carried')
  })

  it('carries nothing after a finished list, a broken turn or a refused result', () => {
    expect(chatTodoOf(turn(4, 'running', null), turn(3, 'completed', finished))).toBeNull()
    for (const status of ['failed', 'cancelled', 'timed_out', 'lost'] as const)
      expect(chatTodoOf(turn(4, 'running', null), turn(3, status, plan))).toBeNull()
    expect(chatTodoOf(turn(4, 'running', null), turn(3, 'completed', plan, true))).toBeNull()
    expect(chatTodoOf(turn(4, 'running', null), turn(3, 'completed', null))).toBeNull()
    expect(chatTodoOf(turn(1, 'running', null), null)).toBeNull()
  })

  it('takes the list away once a turn ended without one', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const)
      expect(chatTodoOf(turn(4, status, null), turn(3, 'completed', plan))).toBeNull()
  })

  it('has no plan when the turn at work emptied its list', () => {
    expect(chatTodoOf(turn(4, 'running', { items: [] }), turn(3, 'completed', plan))).toBeNull()
  })

  it('gives what its output schema takes', () => {
    const shown = chatTodoOf(
      turn(2, 'running', { ...plan, omitted: { completed: 1, other: 2 } }),
      null,
    )
    expect(chatTodoSchema.safeParse(shown).success).toBe(true)
    expect(chatTodoSchema.safeParse({ ...shown, extra: 1 }).success).toBe(false)
  })
})
