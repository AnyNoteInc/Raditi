// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
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
  it('shows every event of the agent as text, in the order it came', () => {
    render(<TurnActivityView state={read()} live={false} />)
    const block = screen.getByRole('region', { name: 'Ход работы' })
    expect(block.querySelector('b')).toBeNull()
    expect(within(block).getByText('Смотрю тему <b>сайта</b>.')).toBeTruthy()
    const commands = [...block.querySelectorAll('pre')].map((pre) => pre.textContent)
    expect(commands).toEqual(['ls wp-content/themes', 'php -l broken.php', 'tail -f log'])
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
})
