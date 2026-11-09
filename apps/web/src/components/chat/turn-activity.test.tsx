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

    it('is something to read for a viewer who asked, when it is all there is', () => {
      render(<TurnActivityView state={read({ events: [thought] })} live thinking />)
      expect(screen.getByText(THOUGHT)).toBeTruthy()
      expect(screen.queryByText('Агент пока ничего не вывел.')).toBeNull()
    })

    it('counts as nothing yet for a viewer who has not asked', () => {
      render(<TurnActivityView state={read({ events: [thought] })} live />)
      expect(screen.getByText('Агент пока ничего не вывел.')).toBeTruthy()
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
    rerender(<TurnActivityView state={read({ events: [] })} live />)
    expect(screen.getByText('Агент пока ничего не вывел.')).toBeTruthy()
    rerender(<TurnActivityView state={read({ more: true })} live />)
    expect(screen.getByText('Загружаем дальше…')).toBeTruthy()
    rerender(<TurnActivityView state={read({ failed: true })} live />)
    expect(screen.getByText('Не удалось загрузить ход работы. Попробуем ещё раз.')).toBeTruthy()
    expect(screen.getByText('raditi_wp_rest')).toBeTruthy()
  })

  describe('a command, IN and OUT (owner\'s request of 09.11.2026)', () => {
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
      fireEvent.click(screen.getByRole('button', { name: 'Команда wp plugin list — открыть вывод' }))
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
