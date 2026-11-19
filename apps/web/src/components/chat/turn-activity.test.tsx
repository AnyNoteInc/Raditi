// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ActivityEvent } from './chat-types'
import { TurnActivityView } from './turn-activity'
import { initialActivity, type ActivityState } from './use-turn-activity'

const events: ActivityEvent[] = [
  { id: '7:1', type: 'message', text: 'Смотрю тему <b>сайта</b>.' },
  { id: '7:2', type: 'command', command: 'ls wp-content/themes', exitCode: 0 },
  { id: '7:3', type: 'command', command: 'php -l broken.php', exitCode: 255 },
  { id: '7:4', type: 'command', command: 'tail -f log', exitCode: null },
  { id: '9:0', type: 'tool_call', tool: 'raditi_site_info', ok: true },
  { id: '9:1', type: 'tool_call', tool: 'raditi_wp_rest', ok: false },
  { id: '9:2', type: 'file_change', path: 'wp-content/themes/a/style.css', change: 'update' },
  { id: '9:3', type: 'file_change', path: 'wp-content/themes/a/new.php', change: 'add' },
  { id: '9:4', type: 'question', text: 'Какой цвет кнопки?', options: ['Синий', 'Зелёный'] },
]

const read = (patch: Partial<ActivityState> = {}): ActivityState => ({
  ...initialActivity,
  read: true,
  events,
  ...patch,
})

describe('«Ход работы»', () => {
  it('stands in the feed as it comes while the turn is live, and in a block of its own after', () => {
    const live = render(<TurnActivityView state={read()} live />)
    const flowing = screen.getByRole('region', { name: 'Ход работы' })
    expect(flowing.getAttribute('data-activity')).toBe('live')
    // Nothing of its own to scroll: the feed follows it.
    expect(flowing.getAttribute('tabindex')).toBeNull()
    live.unmount()
    render(<TurnActivityView state={read()} live={false} />)
    const kept = screen.getByRole('region', { name: 'Ход работы' })
    expect(kept.getAttribute('data-activity')).toBeNull()
    expect(kept.getAttribute('tabindex')).toBe('0')
  })

  describe('what the model thought', () => {
    const THOUGHT = 'Maybe <i>the theme</i> first.'
    const thought: ActivityEvent = { id: '6:0', type: 'reasoning', text: THOUGHT }

    it('stays out of sight until the viewer asks, and nothing says it is there', () => {
      render(<TurnActivityView state={read({ events: [thought, ...events] })} live={false} />)
      expect(screen.queryByText(THOUGHT)).toBeNull()
      expect(screen.queryByText('Размышления агента')).toBeNull()
    })

    it('stands in its place as text, under a label of its own, for a viewer who asked', () => {
      render(
        <TurnActivityView state={read({ events: [thought, ...events] })} live={false} thinking />,
      )
      const block = screen.getByRole('region', { name: 'Ход работы' })
      expect(block.querySelector('i')).toBeNull()
      expect(within(block).getByText('Размышления агента')).toBeTruthy()
      expect(block.textContent!.indexOf('Maybe')).toBeLessThan(block.textContent!.indexOf('Смотрю'))
      expect(within(block).getByText(THOUGHT)).toBeTruthy()
    })

    it('stands in one line, and opens into three that scroll on a click or a key', () => {
      render(<TurnActivityView state={read({ events: [thought] })} live={false} thinking />)
      const box = screen.getByText(THOUGHT)
      expect(box.getAttribute('aria-expanded')).toBe('false')
      expect(box.getAttribute('aria-label')).toBe('Размышления агента — показать три строки')
      expect(getComputedStyle(box).overflowY).toBe('hidden')
      fireEvent.click(box)
      expect(box.getAttribute('aria-expanded')).toBe('true')
      expect(box.getAttribute('aria-label')).toBe('Размышления агента — свернуть в одну строку')
      expect(getComputedStyle(box).overflowY).toBe('auto')
      fireEvent.keyDown(box, { key: 'Enter' })
      expect(box.getAttribute('aria-expanded')).toBe('false')
    })

    it('stays open, and the same box, while the draft of it grows under a new id', () => {
      // Each poll brings the draft under the id of a newer journal row (`1:0`, then `2:0`): the
      // box the viewer opened must not be built again, or it closes and scrolls from its first
      // word at every update.
      const draft = (id: string, text: string): ActivityEvent => ({
        id,
        type: 'draft',
        kind: 'reasoning',
        text,
      })
      const { rerender } = render(
        <TurnActivityView state={read({ events: [draft('1:0', 'Сначала тема')] })} live thinking />,
      )
      const box = screen.getByText('Сначала тема')
      fireEvent.click(box)
      expect(box.getAttribute('aria-expanded')).toBe('true')
      rerender(
        <TurnActivityView
          state={read({ events: [draft('2:0', 'Сначала тема, потом плагины')] })}
          live
          thinking
        />,
      )
      const grown = screen.getByText('Сначала тема, потом плагины')
      expect(grown).toBe(box)
      expect(grown.getAttribute('aria-expanded')).toBe('true')
    })

    it('is something to read for a viewer who asked, when it is all there is', () => {
      render(<TurnActivityView state={read({ events: [thought] })} live thinking />)
      expect(screen.getByText(THOUGHT)).toBeTruthy()
      expect(screen.queryByText('Агент пока ничего не вывел.')).toBeNull()
    })

    it('hides what the model is thinking now when the viewer hid the thoughts (19.11.2026)', () => {
      const draft: ActivityEvent = {
        id: '1:0',
        type: 'draft',
        kind: 'reasoning',
        text: 'Сначала тема',
      }
      const words: ActivityEvent = { id: '1:1', type: 'draft', kind: 'text', text: 'Смотрю тему.' }
      render(<TurnActivityView state={read({ events: [draft] })} live thinking={false} />)
      expect(screen.queryByText('Сначала тема')).toBeNull()
      expect(screen.queryByText('Агент размышляет…')).toBeNull()
      cleanup()
      render(<TurnActivityView state={read({ events: [words] })} live thinking={false} />)
      expect(screen.getByText('Смотрю тему.')).toBeTruthy()
    })

    it('counts as nothing yet for a viewer who has not asked, and says nothing of it', () => {
      render(<TurnActivityView state={read({ events: [thought] })} live />)
      expect(screen.queryByText(THOUGHT)).toBeNull()
      expect(screen.getByRole('region', { name: 'Ход работы' }).textContent).toBe('')
    })
  })

  it('shows every event of the agent as text, in the order it came', () => {
    render(<TurnActivityView state={read()} live={false} />)
    const block = screen.getByRole('region', { name: 'Ход работы' })
    expect(block.querySelector('b')).toBeNull()
    expect(within(block).getByText('Смотрю тему <b>сайта</b>.')).toBeTruthy()
    const commands = within(block)
      .getAllByRole('button', { name: /^Команда .+ — открыть вывод$/ })
      .map((button) => button.getAttribute('aria-label'))
    expect(commands).toEqual([
      'Команда ls wp-content/themes — открыть вывод',
      'Команда php -l broken.php — открыть вывод',
      'Команда tail -f log — открыть вывод',
    ])
    expect(within(block).getByText('· выполнена')).toBeTruthy()
    expect(within(block).getByText('· ошибка, код 255')).toBeTruthy()
    expect(within(block).getByText('raditi_site_info')).toBeTruthy()
    expect(within(block).getByText('· выполнен')).toBeTruthy()
    expect(within(block).getAllByText('· ошибка')).toHaveLength(1)
    expect(within(block).getByText('Изменён файл')).toBeTruthy()
    expect(within(block).getByText('Добавлен файл')).toBeTruthy()
    expect(within(block).getByText('wp-content/themes/a/style.css')).toBeTruthy()
    expect(within(block).getByText('Какой цвет кнопки?')).toBeTruthy()
    expect(within(block).getByText('Зелёный')).toBeTruthy()
    expect(block.textContent!.indexOf('Смотрю')).toBeLessThan(block.textContent!.indexOf('ls wp'))
    // The block scrolls and can be reached from the keyboard.
    expect(block.tabIndex).toBe(0)
  })

  it('says what it waits for: the first answer, a failure, more rows, nothing yet', () => {
    const { rerender } = render(<TurnActivityView state={initialActivity} live />)
    expect(screen.getByText('Загружаем ход работы…')).toBeTruthy()
    // Nothing written yet says nothing (owner's request of 14.11.2026).
    rerender(<TurnActivityView state={read({ events: [] })} live />)
    expect(screen.getByRole('region', { name: 'Ход работы' }).textContent).toBe('')
    rerender(<TurnActivityView state={read({ more: true })} live />)
    expect(screen.getByText('Загружаем дальше…')).toBeTruthy()
    rerender(<TurnActivityView state={read({ failed: true })} live />)
    expect(screen.getByText('Не удалось загрузить ход работы. Попробуем ещё раз.')).toBeTruthy()
    expect(screen.getByText('raditi_wp_rest')).toBeTruthy()
  })

  // «План работы» in «Ход работы» (docs/plan/87-agent-todos.md, ТД8, §6.3): `ActivityLine` would
  // draw nothing of it without its case, and nothing but this test would say so.
  describe('the plan of the agent', () => {
    type Plan = Extract<ActivityEvent, { type: 'todo_list' }>
    const plan = (id: string, items: Plan['items'], omitted?: Plan['omitted']): Plan => ({
      id,
      type: 'todo_list',
      items,
      ...(omitted ? { omitted } : {}),
    })
    const first = plan('4:0', [
      { text: 'Посмотрели текущую страницу', status: 'completed' },
      { text: 'Готовим текст страницы', status: 'in_progress' },
      { text: 'Публикуем страницу', status: 'pending' },
    ])
    const lines = () => screen.queryAllByRole('button', { name: /^План работы/ })

    it('is one line with the count, which opens into the list as it stood then', () => {
      render(<TurnActivityView state={read({ events: [first] })} live={false} />)
      const [line] = lines()
      expect(line).toHaveTextContent('План работы · сделано 1 из 3 · Готовим текст страницы')
      expect(line).toHaveAttribute('aria-expanded', 'false')
      const list = document.getElementById(line!.getAttribute('aria-controls')!)!
      expect(list).not.toBeVisible()
      fireEvent.click(line!)
      expect(line).toHaveAttribute('aria-expanded', 'true')
      expect(list).toBeVisible()
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((item) => item.getAttribute('aria-label')),
      ).toEqual([
        'Посмотрели текущую страницу, сделано',
        'Готовим текст страницы, сейчас',
        'Публикуем страницу, впереди',
      ])
      // History: nothing of it says it is at work now.
      expect(within(list).queryByText('Сейчас')).toBeNull()
      expect(list.querySelector('[aria-current]')).toBeNull()
    })

    it('stands in the live turn too, and is no tool any more', () => {
      render(<TurnActivityView state={read({ events: [first] })} live />)
      expect(lines()).toHaveLength(1)
      expect(screen.queryByText('Инструмент')).toBeNull()
    })

    it('keeps a line only where the count or the item at work changed', () => {
      // Rewritten words of an item ahead are the same step for the client.
      const rewritten = plan('4:1', [
        first.items[0]!,
        first.items[1]!,
        { text: 'Публикуем страницу на сайте', status: 'pending' },
      ])
      const next = plan('5:0', [
        first.items[0]!,
        { text: 'Готовим текст страницы', status: 'completed' },
        { text: 'Публикуем страницу', status: 'in_progress' },
      ])
      const again = plan('6:0', next.items)
      render(
        <TurnActivityView
          state={read({ events: [first, rewritten, events[0]!, next, again] })}
          live={false}
        />,
      )
      expect(lines().map((line) => line.textContent)).toEqual([
        'План работы · сделано 1 из 3 · Готовим текст страницы',
        'План работы · сделано 2 из 3 · Публикуем страницу',
      ])
    })

    it('says when the agent cleared its list, and a list written back after it gets its line', () => {
      render(
        <TurnActivityView
          state={read({ events: [first, plan('5:0', []), plan('6:0', first.items)] })}
          live={false}
        />,
      )
      expect(screen.getByText('План работы · агент убрал план')).toBeVisible()
      expect(lines().map((line) => line.textContent)).toEqual([
        'План работы · сделано 1 из 3 · Готовим текст страницы',
        'План работы · сделано 1 из 3 · Готовим текст страницы',
      ])
    })

    it('tells a list that starts its first step from the list with everything ahead', () => {
      const ahead = plan('4:0', [
        { text: 'Посмотрим страницу', status: 'pending' },
        { text: 'Подготовим текст', status: 'pending' },
      ])
      const started = plan('4:1', [
        { text: 'Посмотрим страницу', status: 'in_progress' },
        { text: 'Подготовим текст', status: 'pending' },
      ])
      render(<TurnActivityView state={read({ events: [ahead, started] })} live={false} />)
      expect(lines().map((line) => line.textContent)).toEqual([
        'План работы · сделано 0 из 2',
        'План работы · сделано 0 из 2 · Посмотрим страницу',
      ])
    })

    it('cuts a long item in its line between whole characters', () => {
      const long = `${'Готовим очень длинный текст '.repeat(3)}😀${'я'.repeat(60)}`
      render(
        <TurnActivityView
          state={read({
            events: [
              plan('4:0', [
                { text: long, status: 'in_progress' },
                { text: 'Публикуем', status: 'pending' },
              ]),
            ],
          })}
          live={false}
        />,
      )
      const [line] = lines()
      const words = line!.textContent!.split(' · ').at(-1)!
      expect(Array.from(words)).toHaveLength(80)
      expect(words.endsWith('…')).toBe(true)
      expect(words.isWellFormed()).toBe(true)
    })

    it('keeps one line while a list told by its count keeps its count', () => {
      const english = (id: string, statuses: Plan['items'][number]['status'][]) =>
        plan(
          id,
          ['Read the page', 'Write the text', 'Publish it'].map((text, n) => ({
            text,
            status: statuses[n]!,
          })),
        )
      render(
        <TurnActivityView
          state={read({
            events: [
              english('4:0', ['pending', 'pending', 'pending']),
              english('4:1', ['in_progress', 'pending', 'pending']),
              english('5:0', ['completed', 'pending', 'pending']),
              english('5:1', ['completed', 'in_progress', 'pending']),
            ],
          })}
          live={false}
        />,
      )
      expect(screen.getAllByText(/^План работы · шаг/).map((line) => line.textContent)).toEqual([
        'План работы · шаг 1 из 3',
        'План работы · шаг 2 из 3',
      ])
    })

    it('counts what a long list left out', () => {
      render(
        <TurnActivityView
          state={read({ events: [plan(first.id, first.items, { completed: 12, other: 3 })] })}
          live={false}
        />,
      )
      const [line] = lines()
      expect(line).toHaveTextContent('План работы · сделано 13 из 18')
      fireEvent.click(line!)
      expect(screen.getByText('12 выполненных шагов не показаны')).toBeVisible()
      expect(screen.getByText('и ещё 3 шага')).toBeVisible()
    })

    it('tells a list with no Russian word by its step alone, with nothing to open', () => {
      const english = plan('4:0', [
        { text: 'Read the page', status: 'completed' },
        { text: 'Write the text', status: 'in_progress' },
        { text: 'Publish', status: 'pending' },
      ])
      render(<TurnActivityView state={read({ events: [english] })} live={false} />)
      expect(screen.getByText('План работы · шаг 2 из 3')).toBeTruthy()
      expect(lines()).toEqual([])
      expect(screen.queryByText('Write the text')).toBeNull()
    })
  })

  describe("a command, IN and OUT (owner's request of 09.11.2026)", () => {
    const command = (patch: Partial<Extract<ActivityEvent, { type: 'command' }>> = {}) =>
      read({
        events: [
          {
            id: '3:0',
            type: 'command',
            command: 'wp plugin list',
            exitCode: 0,
            output: 'akismet\nclassic-editor\nraditi\nwordfence\nyoast\n',
            ...patch,
          },
        ],
      })

    it('shows the command and the first lines of its output, and how many more there are', () => {
      render(<TurnActivityView state={command()} live />)
      const button = screen.getByRole('button', { name: 'Команда wp plugin list — открыть вывод' })
      expect(within(button).getByText('IN')).toBeTruthy()
      expect(within(button).getByText('OUT')).toBeTruthy()
      expect(button.textContent).toContain('akismet\nclassic-editor\nraditi')
      expect(button.textContent).not.toContain('wordfence')
      expect(within(button).getByText('… ещё 2 строки')).toBeTruthy()
    })

    it('opens the whole output in a window, and says when its middle is left out', async () => {
      render(<TurnActivityView state={command({ outputCut: true })} live={false} />)
      fireEvent.click(
        screen.getByRole('button', { name: 'Команда wp plugin list — открыть вывод' }),
      )
      const window = await screen.findByRole('dialog', { name: /Команда/ })
      expect(within(window).getByText(/wordfence/)).toBeTruthy()
      expect(
        within(window).getByText('Вывод длинный: здесь его начало и конец, середина пропущена.'),
      ).toBeTruthy()
      fireEvent.click(within(window).getByRole('button', { name: 'Закрыть' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it('has no OUT for a command that printed nothing, or whose output is not known', async () => {
      render(<TurnActivityView state={command({ output: '\n' })} live />)
      expect(screen.queryByText('OUT')).toBeNull()
      cleanup()
      render(<TurnActivityView state={command({ output: undefined })} live />)
      expect(screen.queryByText('OUT')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /открыть вывод/ }))
      expect(await screen.findByText(/Вывода этой команды нет/)).toBeTruthy()
    })
  })
})
