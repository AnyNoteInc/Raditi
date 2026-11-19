// @vitest-environment jsdom
import type { AgentTodoItem, ChatTodo } from '@repo/domain/tasks/agent-todo'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TodoCard, TodoList, todoHeadOf, TodoStrip, todoStripShows } from './todo-card'

// «План работы» (docs/plan/87-agent-todos.md, §6): the card beside the chat, the line over the
// field and the list they share.

const item = (text: string, status: AgentTodoItem['status']): AgentTodoItem => ({ text, status })

/** The plan of the price list: two steps done, one at work, two ahead. */
const steps: AgentTodoItem[] = [
  item('Посмотрели текущую страницу', 'completed'),
  item('Собрали цены из прайса', 'completed'),
  item('Готовим текст страницы', 'in_progress'),
  item('Публикуем страницу', 'pending'),
  item('Проверяем адрес', 'pending'),
]

/** A plan of ten steps: more than the card shows without scrolling its list. */
const long: AgentTodoItem[] = Array.from({ length: 10 }, (_, index) =>
  item(
    `Шаг работы номер ${index + 1}`,
    index < 3 ? 'completed' : index === 3 ? 'in_progress' : 'pending',
  ),
)

const plan = (patch: Partial<ChatTodo> = {}): ChatTodo => ({
  turn: 3,
  state: 'working',
  items: steps,
  ...patch,
})

let chats = 0
/** A chat of its own for each card: the client's choice to fold one is kept for the page. */
const nextTaskId = () => `0199a3f2-0000-7000-8000-${String((chats += 1)).padStart(12, '0')}`

function showCard(todo: ChatTodo, waiting = false, taskId = nextTaskId()) {
  const view = render(<TodoCard taskId={taskId} todo={todo} waiting={waiting} />)
  return { ...view, taskId, card: () => screen.getByRole('region', { name: /План работы/ }) }
}

/** Words on the card, not those its live region says. */
const shown = (text: string) => screen.getByText(text, { ignore: '[role="status"], script, style' })
const items = () => screen.getAllByRole('listitem')
const labels = () => items().map((line) => line.getAttribute('aria-label'))
const toggle = () => screen.getByRole('button', { name: /план работы$/ })

describe('the head of the card by the state of the plan', () => {
  it.each([
    ['working', false, 'План работы', 'Сделано 2 из 5', false],
    ['carried', false, 'С прошлого раза', 'Сделано 2 из 5', false],
    ['ended', true, 'Ждём вашего ответа', 'Сделано 2 из 5', false],
    ['ended', false, 'План работы', 'Сделано 2 из 5', false],
    ['stopped', false, 'Остановлено', 'Сделано 2 из 5', false],
    ['failed', false, 'Работа прервалась', 'Сделано 2 из 5', false],
  ] as const)('%s (waiting %s): «%s · %s»', (state, waiting, label, count, collapsed) => {
    expect(todoHeadOf(plan({ state }), waiting)).toEqual({ label, count, collapsed, items: true })
  })

  it('folds a plan done to its end into one line', () => {
    const done = steps.map((step) => ({ ...step, status: 'completed' as const }))
    expect(todoHeadOf(plan({ state: 'ended', items: done }), true)).toEqual({
      label: 'План выполнен',
      count: '5 из 5',
      collapsed: true,
      items: true,
    })
  })

  it('says a plan the agent cancelled whole is cancelled, folded and with no count', () => {
    const cancelled = steps.map((step) => ({ ...step, status: 'cancelled' as const }))
    expect(todoHeadOf(plan({ items: cancelled }), false)).toEqual({
      label: 'Агент отменил этот план',
      count: null,
      collapsed: true,
      items: true,
    })
  })

  it('counts by step, without the words, a list with no Russian word (ТД11)', () => {
    const english = [
      item('Read the page', 'completed'),
      item('Collect prices', 'completed'),
      item('Write the text', 'in_progress'),
      item('Publish', 'pending'),
      item('Check', 'pending'),
    ]
    expect(todoHeadOf(plan({ items: english }), false)).toEqual({
      label: 'План работы',
      count: 'Шаг 3 из 5',
      collapsed: false,
      items: false,
    })
  })
})

describe('«План работы» beside the chat', () => {
  it('is a section named by its heading, the items in the agent order with their state', () => {
    const { card } = showCard(plan())
    expect(within(card()).getByRole('heading', { level: 2, name: 'План работы' })).toBeVisible()
    expect(shown('Сделано 2 из 5')).toBeVisible()
    expect(within(card()).getByRole('list').tagName).toBe('OL')
    expect(labels()).toEqual([
      'Посмотрели текущую страницу, сделано',
      'Собрали цены из прайса, сделано',
      'Готовим текст страницы, сейчас',
      'Публикуем страницу, впереди',
      'Проверяем адрес, впереди',
    ])
  })

  it('marks the item at work: a breathing dot, «Сейчас», the current step; done ones struck', () => {
    showCard(plan())
    const [first, , atWork, ahead] = items()
    expect(atWork).toHaveAttribute('aria-current', 'step')
    expect(atWork!.getAttribute('data-todo-item')).toBe('now')
    expect(within(atWork!).getByText('Сейчас')).toBeVisible()
    expect(atWork!.querySelector('[data-todo-mark="now"]')).not.toBeNull()
    expect(getComputedStyle(within(first!).getByText(steps[0]!.text)).textDecoration).toBe(
      'line-through',
    )
    expect(getComputedStyle(within(ahead!).getByText(steps[3]!.text)).textDecoration).toBe('none')
    expect(items().filter((line) => line.hasAttribute('aria-current'))).toHaveLength(1)
  })

  it('lets only the first of two items at work breathe', () => {
    const two = [item('Пишем текст', 'in_progress'), item('Ищем фото', 'in_progress')]
    showCard(plan({ items: two }))
    const [first, second] = items()
    expect(first!.getAttribute('data-todo-item')).toBe('now')
    expect(second!.getAttribute('data-todo-item')).toBe('busy')
    expect(second).not.toHaveAttribute('aria-current')
    expect(second!.getAttribute('aria-label')).toBe('Ищем фото, сейчас')
  })

  it('never says an unfinished item is done once the work has left it: a pause, «не закончено»', () => {
    for (const state of ['stopped', 'failed', 'carried', 'ended'] as const) {
      const { unmount } = showCard(plan({ state }))
      const atWork = items()[2]!
      expect(atWork.getAttribute('data-todo-item')).toBe('paused')
      expect(atWork.getAttribute('aria-label')).toBe('Готовим текст страницы, не закончено')
      expect(within(atWork).getByText('не закончено')).toBeVisible()
      expect(atWork).not.toHaveAttribute('aria-current')
      expect(screen.queryByText('Сейчас')).toBeNull()
      unmount()
    }
  })

  it('strikes a skipped item through with a dash, and does not count it', () => {
    const skipped = [...steps.slice(0, 3), item('Публикуем страницу', 'cancelled'), steps[4]!]
    showCard(plan({ items: skipped }))
    expect(items()[3]!.getAttribute('aria-label')).toBe('Публикуем страницу, пропущено')
    expect(shown('Сделано 2 из 4')).toBeVisible()
  })

  it('names what a long list left out, and counts it', () => {
    showCard(plan({ omitted: { completed: 12, other: 3 } }))
    expect(screen.getByText('12 выполненных шагов не показаны')).toBeVisible()
    expect(screen.getByText('и ещё 3 шага')).toBeVisible()
    expect(shown('Сделано 14 из 20')).toBeVisible()
    // The notes are no items of the list.
    expect(items()).toHaveLength(5)
  })

  it.each([
    [1, '1 выполненный шаг не показан', 'и ещё 1 шаг'],
    [2, '2 выполненных шага не показаны', 'и ещё 2 шага'],
    [21, '21 выполненный шаг не показан', 'и ещё 21 шаг'],
  ])('agrees the notes with %i', (count, done, rest) => {
    render(
      <TodoList
        list={{ items: steps, omitted: { completed: count, other: count } }}
        mode="working"
      />,
    )
    expect(screen.getByText(done)).toBeTruthy()
    expect(screen.getByText(rest)).toBeTruthy()
  })

  it('shows a list with no Russian word by its count alone', () => {
    const english = [item('Read the page', 'completed'), item('Write the text', 'in_progress')]
    const { card } = showCard(plan({ items: english }))
    expect(card()).toHaveAccessibleName('План работы')
    expect(shown('Шаг 2 из 2')).toBeVisible()
    expect(screen.queryByText('Read the page')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('folds and opens by its own button, and keeps the choice for the plan of that turn', () => {
    const { taskId, unmount } = showCard(plan())
    const button = toggle()
    expect(button).toHaveAccessibleName('Свернуть план работы')
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const list = document.getElementById(button.getAttribute('aria-controls')!)!
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(button)
    expect(toggle()).toHaveAccessibleName('Развернуть план работы')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(list).not.toBeVisible()
    unmount()
    // The same plan again — the chat opened once more, a new read of it: still folded.
    const again = showCard(plan(), false, taskId)
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    again.unmount()
    // The plan of the next turn starts as its state says.
    showCard(plan({ turn: 4 }), false, taskId)
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  })

  it('starts a plan done to its end folded, «План выполнен · 5 из 5», and opens on a press', () => {
    const done = steps.map((step) => ({ ...step, status: 'completed' as const }))
    const { card } = showCard(plan({ state: 'ended', items: done }))
    expect(within(card()).getByRole('heading', { name: 'План работы: План выполнен' })).toBeTruthy()
    expect(shown('5 из 5')).toBeVisible()
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle())
    expect(screen.getAllByRole('listitem')[0]).toBeVisible()
  })

  it('says whose state a state in place of the title is', () => {
    const { card } = showCard(plan({ state: 'stopped' }))
    expect(card()).toHaveAccessibleName('План работы: Остановлено')
  })

  it('says the count as it changes, and nothing for a rewrite of the same count', () => {
    const taskId = nextTaskId()
    const { rerender } = render(<TodoCard taskId={taskId} todo={plan()} waiting={false} />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Сделано 2 из 5')
    const node = status.firstChild
    const rewritten = [
      ...steps.slice(0, 3),
      item('Публикуем страницу на сайте', 'pending'),
      steps[4]!,
    ]
    rerender(<TodoCard taskId={taskId} todo={plan({ items: rewritten })} waiting={false} />)
    expect(screen.getByRole('status').firstChild).toBe(node)
    expect(screen.getByRole('status')).toHaveTextContent('Сделано 2 из 5')
    const further = [
      ...steps.slice(0, 2),
      item('Готовим текст страницы', 'completed'),
      ...steps.slice(3),
    ]
    rerender(<TodoCard taskId={taskId} todo={plan({ items: further })} waiting={false} />)
    expect(screen.getByRole('status')).toHaveTextContent('Сделано 3 из 5')
  })

  it('says nothing new when the turn that finished its plan ends: «5 из 5» is the head alone', () => {
    const taskId = nextTaskId()
    const done = steps.map((step) => ({ ...step, status: 'completed' as const }))
    const { rerender } = render(
      <TodoCard taskId={taskId} todo={plan({ items: done })} waiting={false} />,
    )
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Сделано 5 из 5')
    const node = status.firstChild
    rerender(<TodoCard taskId={taskId} todo={plan({ state: 'ended', items: done })} waiting />)
    expect(shown('5 из 5')).toBeVisible()
    expect(screen.getByRole('status').textContent).toBe('Сделано 5 из 5')
    expect(screen.getByRole('status').firstChild).toBe(node)
  })

  it('counts by step in its live region a list with no Russian word, and says nothing of a cancelled one', () => {
    const english = [item('Read the page', 'completed'), item('Write the text', 'in_progress')]
    const { unmount } = showCard(plan({ items: english }))
    expect(screen.getByRole('status').textContent).toBe('Шаг 2 из 2')
    unmount()
    showCard(plan({ items: steps.map((step) => ({ ...step, status: 'cancelled' as const })) }))
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('lets the keyboard reach and scroll a long list: a region of its own name', () => {
    showCard(plan({ items: long }))
    const list = screen.getByRole('region', { name: 'Шаги плана работы' })
    expect(list).toHaveAttribute('tabindex', '0')
    expect(list.id).toBe(toggle().getAttribute('aria-controls'))
    expect(within(list).getAllByRole('listitem')).toHaveLength(10)
    expect(getComputedStyle(list).overflowY).toBe('auto')
    list.focus()
    expect(list).toHaveFocus()
    // Folded, the list is out of the order of the keyboard, and its name is no more.
    fireEvent.click(toggle())
    expect(screen.queryByRole('region', { name: 'Шаги плана работы' })).toBeNull()
  })
})

describe('«План работы» over the field', () => {
  const strip = () => screen.getByRole('region', { name: 'План работы' })
  const line = () => within(strip()).getByRole('button')

  it('is one line while the agent works: the count and the item at work', () => {
    render(<TodoStrip todo={plan()} />)
    expect(line()).toHaveTextContent('Сделано 2 из 5 · Сейчас: Готовим текст страницы')
    expect(strip().querySelector('[data-todo-mark="now"]')).not.toBeNull()
  })

  it('starts folded, opens upwards into the list by a press, and folds again by Esc', () => {
    render(<TodoStrip todo={plan()} />)
    expect(line()).toHaveAttribute('aria-expanded', 'false')
    const list = document.getElementById(line().getAttribute('aria-controls')!)!
    expect(list).not.toBeVisible()
    // The list stands above the line, which stays over the field.
    expect(list.compareDocumentPosition(line()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(line())
    expect(line()).toHaveAttribute('aria-expanded', 'true')
    expect(list).toBeVisible()
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    fireEvent.keyDown(line(), { key: 'Escape' })
    expect(line()).toHaveAttribute('aria-expanded', 'false')
  })

  it('starts the list of a later turn folded without dropping the focus from the line', () => {
    const view = render(<TodoStrip todo={plan({ state: 'carried', turn: 3 })} />)
    fireEvent.click(line())
    const list = document.getElementById(line().getAttribute('aria-controls')!)!
    list.focus()
    expect(list).toHaveFocus()
    view.rerender(<TodoStrip todo={plan({ state: 'working', turn: 4 })} />)
    expect(line()).toHaveAttribute('aria-expanded', 'false')
    expect(line()).toHaveFocus()
    fireEvent.click(line())
    expect(line()).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows the plan an earlier turn left while this one has written none', () => {
    render(<TodoStrip todo={plan({ state: 'carried' })} />)
    expect(line()).toHaveTextContent('С прошлого раза · сделано 2 из 5')
    expect(strip().querySelector('[data-todo-mark="paused"]')).not.toBeNull()
  })

  it.each(['ended', 'stopped', 'failed'] as const)('is not there once the work is %s', (state) => {
    expect(todoStripShows(plan({ state }))).toBe(false)
    render(<TodoStrip todo={plan({ state })} />)
    expect(screen.queryByRole('region')).toBeNull()
  })

  it.each(['working', 'carried'] as const)(
    'stands over the field while the plan is %s',
    (state) => {
      expect(todoStripShows(plan({ state }))).toBe(true)
    },
  )

  it('lets the keyboard reach the open list, and Esc in it gives the focus back to the line', () => {
    render(<TodoStrip todo={plan({ items: long })} />)
    fireEvent.click(line())
    const list = within(strip()).getByRole('region', { name: 'Шаги плана работы' })
    expect(list).toHaveAttribute('tabindex', '0')
    expect(list.id).toBe(line().getAttribute('aria-controls'))
    expect(within(list).getAllByRole('listitem')).toHaveLength(10)
    list.focus()
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(line()).toHaveFocus()
    expect(line()).toHaveAttribute('aria-expanded', 'false')
    expect(list).not.toBeVisible()
    // Esc on the line itself folds it and leaves the focus there.
    fireEvent.click(line())
    fireEvent.keyDown(line(), { key: 'Escape' })
    expect(line()).toHaveFocus()
    expect(line()).toHaveAttribute('aria-expanded', 'false')
  })

  it('counts by step a list with no Russian word, and opens nothing', () => {
    const english = [item('Read the page', 'completed'), item('Write the text', 'in_progress')]
    render(<TodoStrip todo={plan({ items: english })} />)
    expect(strip()).toHaveTextContent('Шаг 2 из 2')
    expect(screen.queryByText(/Write the text/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
