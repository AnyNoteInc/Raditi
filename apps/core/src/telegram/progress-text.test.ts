import { describe, expect, it } from 'vitest'

import { activityLine, elapsedText, progressBar, progressText } from './progress-text.ts'

describe('the message of the work of the agent', () => {
  it('moves the bar one step a tick, along and back', () => {
    expect([0, 1, 5, 6, 10, 11].map(progressBar)).toEqual([
      '▰▱▱▱▱▱',
      '▱▰▱▱▱▱',
      '▱▱▱▱▱▰',
      '▱▱▱▱▰▱',
      '▰▱▱▱▱▱',
      '▱▰▱▱▱▱',
    ])
  })

  it('says how long the agent works and what it does now, in the words of the client', () => {
    expect(elapsedText(5_400)).toBe('5 с')
    expect(elapsedText(65_000)).toBe('1 мин 05 с')
    expect(activityLine({ type: 'tool_call', tool: 'raditi_web_open', ok: true })).toBe(
      'Открывает страницу',
    )
    expect(
      activityLine({ type: 'command', command: 'grep -rn  "price"   .', exitCode: null }),
    ).toBe('Выполняет команду: grep -rn "price" .')
    expect(activityLine({ type: 'file_change', path: 'style.css', change: 'update' })).toBe(
      'Правит файл style.css',
    )
    expect(progressText({ tick: 0, status: 'queued', event: null, elapsedMs: 2_000 })).toBe(
      '▰▱▱▱▱▱  Агент работает · 2 с\nВ очереди: агент скоро возьмётся за работу',
    )
    expect(progressText({ tick: 2, status: 'running', event: null, elapsedMs: 0 })).toBe(
      '▱▱▰▱▱▱  Агент работает · 0 с\nРазбирается в задаче',
    )
  })
})

describe('the plan of the work in the message (docs/plan/89-agent-todos.md, ТД9, ТД11)', () => {
  type Item = { text: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }
  const plan = (items: Item[], omitted?: { completed: number; other: number }) =>
    activityLine({ type: 'todo_list', items, ...(omitted ? { omitted } : {}) })

  it('says what is done and what the agent does now', () => {
    expect(
      plan([
        { text: 'Посмотрели текущую страницу', status: 'completed' },
        { text: 'Собрали цены из прайса', status: 'completed' },
        { text: 'Готовим  текст\nстраницы', status: 'in_progress' },
        { text: 'Публикуем страницу', status: 'pending' },
        { text: 'Лишний шаг', status: 'cancelled' },
        { text: 'Проверяем адрес', status: 'pending' },
      ]),
    ).toBe('План: сделано 2 из 5 · сейчас: Готовим текст страницы')
    // The items the driver left out count too.
    expect(
      plan(
        [
          { text: 'Готовим текст', status: 'in_progress' },
          { text: 'Публикуем', status: 'pending' },
        ],
        { completed: 12, other: 3 },
      ),
    ).toBe('План: сделано 12 из 17 · сейчас: Готовим текст')
  })

  it('says only the count when nothing is at work', () => {
    expect(
      plan([
        { text: 'Собрали цены', status: 'completed' },
        { text: 'Публикуем страницу', status: 'pending' },
      ]),
    ).toBe('План: сделано 1 из 2')
    expect(
      plan([
        { text: 'Собрали цены', status: 'completed' },
        { text: 'Опубликовали страницу', status: 'completed' },
      ]),
    ).toBe('План: сделано 2 из 2')
  })

  it('cuts a long item to 80 characters, astral letters whole', () => {
    const long = `Готовим ${'очень '.repeat(20)}длинный текст`
    const line = plan([
      { text: long, status: 'in_progress' },
      { text: 'Публикуем', status: 'pending' },
    ])!
    const item = line.split(' · сейчас: ')[1]!
    expect(item).toHaveLength(80)
    expect(item.endsWith('…')).toBe(true)
    expect(long.startsWith(item.slice(0, -1))).toBe(true)
    const emoji = plan([
      { text: `Готовим ${'🙂'.repeat(60)}`, status: 'in_progress' },
      { text: 'Публикуем', status: 'pending' },
    ])!
    expect(emoji).not.toMatch(/\p{Cs}/u)
    expect(emoji.split(' · сейчас: ')[1]!.length).toBeLessThanOrEqual(80)
  })

  it('tells a list not written in Russian by its count alone (rule 10)', () => {
    const english = (statuses: Item['status'][]) =>
      plan(
        statuses.map((status, index) => ({ text: `Step ${index + 1}: edit src/app.ts`, status })),
      )
    expect(english(['completed', 'completed', 'in_progress', 'pending', 'pending'])).toBe(
      'План: шаг 3 из 5',
    )
    expect(english(['pending', 'pending'])).toBe('План: шаг 1 из 2')
    expect(english(['completed', 'completed', 'cancelled'])).toBe('План: сделано 2 из 2')
    expect(english(['completed', 'in_progress', 'pending'])).not.toContain('Step')
  })

  it('says the agent is making its plan over an empty list, and that it gave up an abandoned one', () => {
    expect(plan([])).toBe('Обновляет план работы')
    expect(
      plan([
        { text: 'Готовим текст', status: 'cancelled' },
        { text: 'Публикуем', status: 'cancelled' },
      ]),
    ).toBe('Агент отменил план')
  })

  it('stands in the message of the work like any other event', () => {
    expect(
      progressText({
        tick: 0,
        status: 'running',
        event: {
          type: 'todo_list',
          items: [
            { text: 'Собрали цены', status: 'completed' },
            { text: 'Готовим текст', status: 'in_progress' },
          ],
        },
        elapsedMs: 5_000,
      }),
    ).toBe('▰▱▱▱▱▱  Агент работает · 5 с\nПлан: сделано 1 из 2 · сейчас: Готовим текст')
  })
})
