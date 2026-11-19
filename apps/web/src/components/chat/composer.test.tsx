// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'

import { Composer, draggedFiles, historyStep, pastedFiles } from './composer'
import { movedIndex, paletteOptions } from './command-palette'
import { verdicts } from './testing'

/** The outline of the sign an element draws: two signs are the same when their outlines are. */
const outline = (element: Element) => element.querySelector('svg path')?.getAttribute('d') ?? null
/** The outline `AppIcon` draws for `name`, drawn aside from the page. */
const outlineOf = (name: AppIconName) =>
  outline(render(<AppIcon name={name} />, { container: document.createElement('div') }).container)

const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Сообщение' })
const list = () => screen.getByRole('listbox', { name: 'Команды' })
const described = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')

function showComposer(
  refused: Parameters<typeof verdicts>[0] = {},
  disabledReason: string | null = null,
) {
  const onRun = vi.fn()
  const onSend = vi.fn(async () => true)
  const onOpen = vi.fn()
  render(
    <Composer
      placeholder="Что поправить?"
      onSend={onSend}
      disabledReason={disabledReason}
      commands={{ verdicts: verdicts(refused), onRun, onOpen }}
    />,
  )
  return { onRun, onSend, onOpen }
}

const type = (text: string) => fireEvent.change(field(), { target: { value: text } })
const press = (key: string, target: HTMLElement = field(), extra = {}) =>
  fireEvent.keyDown(target, { key, ...extra })

describe('words kept for the field', () => {
  const view = (restored: string | null, restoredTaken: number) => (
    <Composer
      placeholder="Что поправить?"
      onSend={vi.fn(async () => true)}
      disabledReason={null}
      restored={restored}
      restoredTaken={restoredTaken}
    />
  )

  it('leave the field when the page takes them back', () => {
    const { rerender } = render(view(null, 0))
    rerender(view('Добавьте новость', 0))
    expect(field().value).toBe('Добавьте новость')
    rerender(view(null, 1))
    expect(field().value).toBe('')
  })

  it('stay when the client changed them: they are the client’s words by then', () => {
    const { rerender } = render(view(null, 0))
    rerender(view('Добавьте новость', 0))
    type('Добавьте новость о скидках')
    rerender(view(null, 1))
    expect(field().value).toBe('Добавьте новость о скидках')
  })
})

describe('the window of commands', () => {
  it('opens on «/» at the start of the field, with the Russian names, and says how to use it', () => {
    const { onOpen } = showComposer()
    expect(screen.queryByRole('listbox')).toBeNull()
    type('/')
    const options = within(list()).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Сжать переписку'),
      expect.stringContaining('Отменить последний запрос'),
      expect.stringContaining('Вернуть отменённый запрос'),
      expect.stringContaining('Отменить чат'),
      expect.stringContaining('Новый чат'),
      expect.stringContaining('Все чаты'),
      expect.stringContaining('Скачать переписку'),
      expect.stringContaining('Модель и размышление'),
      expect.stringContaining('Использование'),
      expect.stringContaining('Состояние чата'),
      expect.stringContaining('Контекст агента'),
      expect.stringContaining('Подробности работы'),
      expect.stringContaining('Размышления агента'),
      expect.stringContaining('Оформление'),
      expect.stringContaining('Справка'),
    ])
    expect(field().getAttribute('aria-controls')).toBe(list().id)
    expect(field().getAttribute('aria-activedescendant')).toBe(options[0]!.id)
    expect(options[0]!.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe(
      '15 команд. Стрелки вверх и вниз — выбор, Enter — выполнить, Escape — закрыть.',
    )
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('narrows the list by the letters typed after «/» and closes when none fits', () => {
    showComposer()
    type('/re')
    expect(
      within(list())
        .getAllByRole('option')
        .map((option) => option.id.split('-').at(-1)),
    ).toEqual(['turn_redo', 'sessions'])
    type('/redo please')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows what a command of the page answered under the field, for a moment (19.11.2026)', () => {
    vi.useFakeTimers()
    try {
      const onRun = vi.fn(() => 'Размышления агента скрыты')
      render(
        <Composer
          placeholder="Что поправить?"
          onSend={vi.fn(async () => true)}
          commands={{ verdicts: verdicts(), onRun }}
        />,
      )
      type('/thinking')
      press('Enter')
      expect(onRun).toHaveBeenCalledWith('thinking')
      // The live region that reads it aloud stands visible, once in the page.
      const status = screen.getByRole('status')
      expect(status.textContent).toBe('Размышления агента скрыты')
      expect(status.hasAttribute('data-command-said')).toBe(true)
      expect(getComputedStyle(status).position).not.toBe('absolute')
      act(() => void vi.advanceTimersByTime(4000))
      expect(status.hasAttribute('data-command-said')).toBe(false)
      expect(status.textContent).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the next answer of a command its own while, not the rest of the last one', () => {
    vi.useFakeTimers()
    try {
      const onRun = vi
        .fn<() => string>()
        .mockReturnValueOnce('Размышления агента показаны')
        .mockReturnValueOnce('Размышления агента скрыты')
      render(
        <Composer
          placeholder="Что поправить?"
          onSend={vi.fn(async () => true)}
          commands={{ verdicts: verdicts(), onRun }}
        />,
      )
      type('/thinking')
      press('Enter')
      act(() => void vi.advanceTimersByTime(3000))
      type('/thinking')
      press('Enter')
      const status = screen.getByRole('status')
      expect(status.textContent).toBe('Размышления агента скрыты')
      act(() => void vi.advanceTimersByTime(3000))
      expect(status.hasAttribute('data-command-said')).toBe(true)
      act(() => void vi.advanceTimersByTime(1000))
      expect(status.hasAttribute('data-command-said')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves with the arrows and runs the chosen command with Enter, never sending its words', () => {
    const { onRun, onSend } = showComposer({ turn_undo: null })
    type('/')
    press('ArrowDown')
    press('ArrowDown')
    const options = within(list()).getAllByRole('option')
    expect(field().getAttribute('aria-activedescendant')).toBe(options[2]!.id)
    press('ArrowUp')
    press('Enter')
    expect(onRun).toHaveBeenCalledWith('turn_undo')
    expect(onSend).not.toHaveBeenCalled()
    expect(field().value).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows a command the server refuses with its reason, and choosing it runs nothing', () => {
    const { onRun } = showComposer({ compact: 'nothing_to_compact' })
    type('/')
    const compact = within(list()).getAllByRole('option')[0]!
    expect(compact.getAttribute('aria-disabled')).toBe('true')
    expect(compact.textContent).toContain('Сжимать пока нечего.')
    expect(compact.textContent).toContain('Недоступна')
    press('Enter')
    expect(onRun).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('Сжимать пока нечего.')
    fireEvent.click(compact)
    expect(onRun).not.toHaveBeenCalled()
  })

  it('closes with Escape and keeps the text; it stays closed until the field starts anew', () => {
    showComposer()
    type('/he')
    press('Escape')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field().value).toBe('/he')
    type('/hel')
    expect(screen.queryByRole('listbox')).toBeNull()
    type('')
    type('/')
    expect(list()).toBeTruthy()
  })

  it('runs a command typed in whole when it is sent, not the words', async () => {
    const { onRun, onSend } = showComposer()
    type('/cancel')
    press('Escape')
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(onRun).toHaveBeenCalledWith('cancel')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('opens from its button with every command, the focus on the list; Escape gives it back', async () => {
    const { onRun } = showComposer({ turn_redo: null })
    const button = screen.getByRole('button', { name: 'Команды' })
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(within(list()).getAllByRole('option')).toHaveLength(15)
    expect(list().getAttribute('tabindex')).toBe('0')
    await vi.waitFor(() => expect(document.activeElement).toBe(list()))
    press('End', list())
    expect(list().getAttribute('aria-activedescendant')).toMatch(/help$/)
    press('Escape', list())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    fireEvent.click(within(list()).getAllByRole('option')[2]!)
    expect(onRun).toHaveBeenCalledWith('turn_redo')
  })

  it('keeps a draft the button opened the list over, and gives the focus back to the field', async () => {
    const { onRun, onSend } = showComposer({ turn_undo: null })
    type('Ещё поменяйте цену латте')
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    await vi.waitFor(() => expect(document.activeElement).toBe(list()))
    fireEvent.click(within(list()).getAllByRole('option')[1]!)
    expect(onRun).toHaveBeenCalledWith('turn_undo')
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field().value).toBe('Ещё поменяйте цену латте')
    expect(document.activeElement).toBe(field())
  })

  it('gives the focus to its button when nothing can be written', async () => {
    const { onRun } = showComposer(
      {},
      'Написать можно будет, когда агент закончит или задаст вопрос.',
    )
    const button = screen.getByRole('button', { name: 'Команды' })
    fireEvent.click(button)
    await vi.waitFor(() => expect(document.activeElement).toBe(list()))
    const options = within(list()).getAllByRole('option')
    fireEvent.click(options.find((option) => option.id.endsWith('cancel'))!)
    expect(onRun).toHaveBeenCalledWith('cancel')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('opens on `/` again after the list of its button was closed over an empty field', async () => {
    showComposer()
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    await vi.waitFor(() => expect(document.activeElement).toBe(list()))
    press('Escape', list())
    type('/')
    expect(list()).toBeTruthy()
  })

  it('stays closed after Escape over a typed `/`, the list opened by its button', async () => {
    showComposer()
    type('/he')
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    await vi.waitFor(() => expect(document.activeElement).toBe(list()))
    press('Escape', list())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field().value).toBe('/he')
  })

  describe('over a field in the middle of the screen', () => {
    afterEach(() => vi.restoreAllMocks())
    const roomAt = (bottom: number) => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        bottom,
      } as DOMRect)
    }
    const room = () => list().parentElement!.style.getPropertyValue('--raditi-palette-room')

    it('is as high as what stands above the field, and follows the window', () => {
      roomAt(300)
      showComposer()
      type('/')
      expect(room()).toBe('288px')
      roomAt(500)
      fireEvent(window, new Event('resize'))
      expect(room()).toBe('488px')
    })

    it('shows a few rows where the window has almost no room', () => {
      roomAt(40)
      showComposer()
      type('/')
      expect(room()).toBe('120px')
    })
  })

  it('stands the commands under the heads of their groups, the arrows going through them all', () => {
    showComposer()
    type('/')
    const groups = within(list()).getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-labelledby'))).toHaveLength(2)
    expect(
      groups.map(
        (group) => document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent,
      ),
    ).toEqual(['Агент', 'Чат'])
    expect(within(groups[0]!).getAllByRole('option')).toHaveLength(4)
    press('End')
    expect(field().getAttribute('aria-activedescendant')).toMatch(/help$/)
    press('ArrowDown')
    expect(field().getAttribute('aria-activedescendant')).toMatch(/compact$/)
  })

  it('leaves out the head of a group nothing in it fits', () => {
    showComposer()
    type('/ex')
    expect(
      within(list())
        .getAllByRole('group')
        .map((group) => within(group).getAllByRole('option').length),
    ).toEqual([1])
  })

  it('runs `/compact` by its verdict, and sends none of its words', () => {
    const { onRun, onSend } = showComposer()
    type('/compact')
    press('Enter')
    expect(onRun).toHaveBeenCalledWith('compact')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('finds a command by its other word and runs it', () => {
    const { onRun } = showComposer()
    type('/cl')
    press('Enter')
    expect(onRun).toHaveBeenCalledWith('new')
    type('/resume')
    press('Escape')
    press('Enter', field(), { ctrlKey: true })
    expect(onRun).toHaveBeenLastCalledWith('sessions')
  })

  it('takes `/undo` for the last request and says it is closed', () => {
    const { onRun, onSend } = showComposer()
    type('/undo')
    press('Escape')
    press('Enter', field(), { ctrlKey: true })
    expect(onRun).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Отменять пока нечего.')
  })

  it('says of a command that is not listed that it is unavailable, and sends nothing', () => {
    const onRun = vi.fn()
    const onSend = vi.fn(async () => true)
    render(
      <Composer
        placeholder="Что поправить?"
        onSend={onSend}
        disabledReason={null}
        commands={{
          verdicts: verdicts().filter((command) => command.id !== 'compact'),
          onRun,
          onOpen: vi.fn(),
        }}
      />,
    )
    type('/compact')
    expect(screen.queryByRole('listbox')).toBeNull()
    press('Enter', field(), { ctrlKey: true })
    expect(screen.getByRole('alert').textContent).toBe('Эта команда сейчас недоступна.')
    expect(onRun).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('opens the whole list for `/help`, typed or chosen, and leaves the words of it out', async () => {
    const { onRun, onSend } = showComposer()
    type('/help')
    press('Enter')
    expect(field().value).toBe('')
    expect(within(list()).getAllByRole('option')).toHaveLength(15)
    await vi.waitFor(() => expect(document.activeElement).toBe(list()))
    expect(onRun).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
    // Chosen from the list that is open already, it leaves it as it is.
    fireEvent.click(within(list()).getAllByRole('option').at(-1)!)
    expect(within(list()).getAllByRole('option')).toHaveLength(15)
  })

  it('says aloud what a command of the page answers', () => {
    const onRun = vi.fn(() => 'Подробности работы показаны')
    render(
      <Composer
        placeholder="Что поправить?"
        onSend={vi.fn(async () => true)}
        commands={{ verdicts: verdicts(), onRun }}
      />,
    )
    type('/details')
    press('Enter')
    expect(screen.getByRole('status').textContent).toBe('Подробности работы показаны')
  })

  it('tells a chat what `/undo` does there', () => {
    render(
      <Composer
        placeholder="Что поправить?"
        onSend={vi.fn(async () => true)}
        commands={{ verdicts: verdicts({ turn_undo: null }), onRun: vi.fn() }}
      />,
    )
    type('/und')
    const undo = within(list()).getByRole('option').textContent
    expect(undo).toContain('Агент забудет последний запрос и ответ на него.')
    expect(undo).not.toContain('файлов')
  })

  it('keeps the option the arrows reach in sight', () => {
    // Chromium answers with a promise: the effect must not return it as its clean-up.
    const scroll = vi.fn(async () => undefined)
    Element.prototype.scrollIntoView = scroll
    showComposer()
    type('/')
    scroll.mockClear()
    press('End')
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scroll.mock.instances.at(-1)).toBe(
      document.getElementById(field().getAttribute('aria-activedescendant')!),
    )
  })

  it('says why a command typed in whole cannot be run now, and runs nothing', () => {
    const { onRun, onSend } = showComposer({ compact: 'nothing_to_compact' })
    type('/compact')
    press('Escape')
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(onRun).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Сжимать пока нечего.')
    expect(field().value).toBe('/compact')
    type('/compac')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a field without commands', () => {
  it('never sends a command as words: there is no dialog to run it in yet', () => {
    const onSend = vi.fn(async () => true)
    render(<Composer placeholder="Что поменять на сайте?" onSend={onSend} />)
    type('/compact')
    expect(screen.queryByRole('listbox')).toBeNull()
    press('Enter', field(), { ctrlKey: true })
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(
      'Команды работают внутри чата. Сначала напишите, что нужно сделать.',
    )
    expect(described(field())).toContain('Команды работают внутри чата.')
    type('/compact и поменяйте цену')
    press('Enter', field(), { ctrlKey: true })
    expect(onSend).toHaveBeenCalledWith('/compact и поменяйте цену', [])
  })
})

describe('the field', () => {
  it('sends with the button or Enter; Shift+Enter and the Enter of an input method do not', async () => {
    const { onSend } = showComposer()
    type('Поменяйте цену')
    press('Enter', field(), { shiftKey: true })
    press('Enter', field(), { keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    press('Enter')
    expect(onSend).toHaveBeenCalledWith('Поменяйте цену', [])
    await vi.waitFor(() => expect(field().value).toBe(''))
  })

  it('is off with its reason, which the field and the button both carry', () => {
    showComposer({}, 'Написать можно будет, когда агент закончит или задаст вопрос.')
    expect(field().disabled).toBe(true)
    expect(described(field())).toContain(
      'Написать можно будет, когда агент закончит или задаст вопрос.',
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить' }).disabled).toBe(true)
    type('/')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('says when the message is too long and does not send it', () => {
    const { onSend } = showComposer()
    type('а'.repeat(4001))
    expect(screen.getByRole('alert').textContent).toBe(
      'Сообщение слишком длинное — сократите его до 4000 знаков',
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить' }).disabled).toBe(true)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('reads the reminder about passwords with the field and shows no words under it', () => {
    showComposer()
    expect(screen.queryByText('ИИ может допускать ошибки. Проверяйте важное.')).toBeNull()
    expect(described(field())).toContain(
      'Не отправляйте в чат пароли и ключи: доступы задаются в разделе «Переменные».',
    )
  })

  it('keeps its controls in one order: «+», «/», «Размышление», then «Отправить»', () => {
    render(
      <Composer
        placeholder="Что поправить?"
        onSend={vi.fn(async () => true)}
        commands={{ verdicts: verdicts(), onRun: vi.fn() }}
        effort={<button type="button">Размышление: Высокое</button>}
      />,
    )
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.textContent || button.getAttribute('aria-label')),
    ).toEqual(['Прикрепить файлы', 'Команды', 'Размышление: Высокое', 'Отправить'])
    const attach = screen.getByRole<HTMLButtonElement>('button', { name: 'Прикрепить файлы' })
    // A plus in place of the paperclip, first in the row (owner's request of 19.11.2026).
    expect(outline(attach)).toBe(outlineOf('plus'))
    expect(outline(attach)).not.toBe(outlineOf('attach'))
    expect(attach.getAttribute('aria-haspopup')).toBe('menu')
    // A field that takes no files has it all the same, closed, and says why.
    expect(attach.disabled).toBe(true)
    expect(described(attach)).toBe('К этому сообщению файлы не прикрепить.')
  })

  it('stands «Остановить» in place of «Отправить» while the agent works', () => {
    const onStop = vi.fn()
    render(
      <Composer
        placeholder="Что поправить?"
        onSend={vi.fn(async () => true)}
        disabledReason="Написать можно будет, когда агент закончит или задаст вопрос."
        stop={{ onStop, available: true }}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Отправить' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Остановить' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})

describe('palette helpers', () => {
  it('wraps the arrows around', () => {
    expect(movedIndex(4, 'ArrowDown', 5)).toBe(0)
    expect(movedIndex(0, 'ArrowUp', 5)).toBe(4)
    expect(movedIndex(2, 'Home', 5)).toBe(0)
  })

  it('lists in a chat only the commands it has a verdict on (К27)', () => {
    expect(paletteOptions('/compact', [])).toEqual([])
    const cancel = { id: 'cancel', available: true, refusal: null } as const
    expect(paletteOptions(null, [cancel]).map((item) => item.id)).toEqual([
      'cancel',
      'new',
      'sessions',
      'export',
      'models',
      'usage',
      'status',
      'context',
      'details',
      'thinking',
      'themes',
      'help',
    ])
  })

  it('needs no verdict for a command of the page, but a chat for `/export`', () => {
    expect(paletteOptions('/ex', [])).toEqual([{ id: 'export', available: true, reason: null }])
    expect(paletteOptions('/ex', [], 'Команды работают внутри чата.')).toEqual([
      { id: 'export', available: false, reason: 'Команды работают внутри чата.' },
    ])
    expect(paletteOptions('/mo', [], 'Команды работают внутри чата.')).toEqual([
      { id: 'models', available: true, reason: null },
    ])
  })

  it('says of `/undo` and `/redo` on a new chat that they work inside a chat', () => {
    const reason = 'Команды работают внутри чата.'
    expect(paletteOptions('/undo', [], reason)).toEqual([
      { id: 'turn_undo', available: false, reason },
    ])
    expect(paletteOptions('/redo', [], reason)).toEqual([
      { id: 'turn_redo', available: false, reason },
    ])
  })

  it('lists on a new chat what that chat will have, and no command of a site (plan 83)', () => {
    const reason = 'Команды работают внутри чата.'
    expect(paletteOptions(null, [], reason, true)).toEqual([
      { id: 'compact', available: false, reason },
      { id: 'turn_undo', available: false, reason },
      { id: 'turn_redo', available: false, reason },
      { id: 'cancel', available: false, reason },
      { id: 'new', available: true, reason: null },
      { id: 'sessions', available: true, reason: null },
      { id: 'export', available: false, reason },
      { id: 'models', available: true, reason: null },
      { id: 'usage', available: true, reason: null },
      { id: 'status', available: false, reason },
      { id: 'context', available: false, reason },
      { id: 'details', available: true, reason: null },
      { id: 'thinking', available: true, reason: null },
      { id: 'themes', available: true, reason: null },
      { id: 'help', available: true, reason: null },
    ])
    for (const typed of ['/release', '/preview', '/update', '/reset', '/init', '/rollback'])
      expect(paletteOptions(typed, [], reason, true)).toEqual([])
  })

  it('finds `/compact` by its other word as well, as a command of a chat (К30)', () => {
    const reason = 'Команды работают внутри чата.'
    for (const typed of ['/compact', '/summarize'])
      expect(paletteOptions(typed, [], reason)).toEqual([
        { id: 'compact', available: false, reason },
      ])
  })

  it('offers `/thinking` as a command of the page, with no verdict and no reason', () => {
    expect(paletteOptions('/thinking', [], 'Команды работают внутри чата.')).toEqual([
      { id: 'thinking', available: true, reason: null },
    ])
  })

  it('gives a command without a verdict the reason of the place, when it has one', () => {
    const [compact] = paletteOptions('/compact', [], 'Команды работают внутри чата.')
    expect(compact).toEqual({
      id: 'compact',
      available: false,
      reason: 'Команды работают внутри чата.',
    })
  })
})

describe('pastedFiles', () => {
  const png = new File([new Uint8Array(4)], 'image.png', { type: 'image/png' })
  const clip = (types: string[], files: File[] = [png]) =>
    ({ types, files }) as unknown as Pick<DataTransfer, 'files' | 'types'>

  it('takes a screenshot and a picture copied from a page', () => {
    expect(pastedFiles(clip(['Files']))).toEqual([png])
    expect(pastedFiles(clip(['text/html', 'Files']))).toEqual([png])
  })

  it('takes files copied in the file manager, which carry their names as text', () => {
    expect(pastedFiles(clip(['text/plain', 'Files']))).toEqual([png])
  })

  it('leaves text, and a copy from a document with a picture of it, to the field', () => {
    expect(pastedFiles(clip(['text/plain'], []))).toEqual([])
    expect(pastedFiles(clip(['text/plain', 'text/html', 'Files']))).toEqual([])
    expect(pastedFiles(null)).toEqual([])
  })
})

describe('the earlier requests under the arrows (docs/plan/75, ВВ23)', () => {
  const history = ['Третья просьба', 'Вторая просьба', 'Первая просьба']
  const view = () =>
    render(
      <Composer placeholder="Что поправить?" onSend={vi.fn(async () => true)} history={history} />,
    )

  it('go back one by one from an empty field, and forward to an empty field again', () => {
    view()
    press('ArrowUp')
    expect(field().value).toBe('Третья просьба')
    press('ArrowUp')
    expect(field().value).toBe('Вторая просьба')
    press('ArrowDown')
    expect(field().value).toBe('Третья просьба')
    press('ArrowDown')
    expect(field().value).toBe('')
  })

  it('stop at the oldest request', () => {
    view()
    for (let step = 0; step < 5; step++) press('ArrowUp')
    expect(field().value).toBe('Первая просьба')
  })

  it('leave the client’s own words alone', () => {
    view()
    type('Мои слова')
    press('ArrowUp')
    expect(field().value).toBe('Мои слова')
  })
})

describe('a step of the arrows', () => {
  it('goes up only from the first line and down only from the last', () => {
    const history = ['Раз\nДва', 'Три']
    expect(historyStep('ArrowUp', { text: 'Раз\nДва', index: 0, caret: 5 }, history)).toBeNull()
    expect(historyStep('ArrowUp', { text: 'Раз\nДва', index: 0, caret: 0 }, history)).toBe(1)
    expect(historyStep('ArrowDown', { text: 'Раз\nДва', index: 0, caret: 0 }, history)).toBeNull()
    expect(historyStep('ArrowDown', { text: 'Раз\nДва', index: 0, caret: 7 }, history)).toBe(-1)
  })
})

describe('files dragged onto the field (ВВ22)', () => {
  function attachmentsControl() {
    return {
      items: [],
      readyIds: [],
      uploading: false,
      failed: false,
      notice: null,
      add: vi.fn(),
      retry: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
    }
  }

  it('are attached as if they were chosen, and the field says so while they are over it', () => {
    const attachments = attachmentsControl()
    render(
      <Composer
        placeholder="Что поправить?"
        onSend={vi.fn(async () => true)}
        attachments={attachments as never}
      />,
    )
    const zone = screen.getByTestId('composer-field')
    const file = new File(['x'], 'фото.png', { type: 'image/png' })
    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(zone.getAttribute('data-dragging')).toBe('true')
    expect(zone.textContent).toContain('Отпустите, чтобы прикрепить')
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(attachments.add).toHaveBeenCalledWith([file])
    expect(zone.getAttribute('data-dragging')).toBeNull()
  })

  it('a drag of text is the field’s own', () => {
    expect(draggedFiles({ types: ['text/plain'] })).toBe(false)
    expect(draggedFiles({ types: ['Files'] })).toBe(true)
  })
})

describe('dictation in the field (docs/plan/75, ВВ16)', () => {
  it('shows the microphone only where dictation is set up, and says when the browser cannot record', async () => {
    const { rerender } = render(
      <Composer placeholder="Что поправить?" onSend={vi.fn(async () => true)} />,
    )
    expect(screen.queryByRole('button', { name: 'Надиктовать' })).toBeNull()
    rerender(<Composer placeholder="Что поправить?" onSend={vi.fn(async () => true)} speech />)
    fireEvent.click(screen.getByRole('button', { name: 'Надиктовать' }))
    // jsdom records nothing: the field says so instead of failing.
    expect(await screen.findByText('Этот браузер не умеет записывать звук.')).toBeTruthy()
  })
})

describe('a file named by «@» (docs/plan/78-file-mentions.md)', () => {
  const files = ['wp-content/themes/shop/style.css', 'wp-content/themes/shop/header.php']
  function showWithFiles(paths: readonly string[] | null = files) {
    const onOpen = vi.fn()
    const onSend = vi.fn(async () => true)
    render(
      <Composer
        placeholder="Что поправить?"
        onSend={onSend}
        mentions={{ paths, state: paths ? 'ready' : 'preparing', onOpen }}
      />,
    )
    return { onOpen, onSend }
  }
  const typeAt = (text: string) =>
    fireEvent.change(field(), { target: { value: text, selectionStart: text.length } })
  const files_ = () => screen.getByRole('listbox', { name: 'Файлы проекта' })

  it('opens the list on «@», reads the files then, and puts the chosen path in the words', () => {
    const { onOpen, onSend } = showWithFiles()
    typeAt('Поправь @head')
    expect(onOpen).toHaveBeenCalled()
    expect(within(files_()).getAllByRole('option')[0]).toHaveAccessibleName(
      'wp-content/themes/shop/header.php',
    )
    press('Enter')
    expect(field().value).toBe('Поправь @wp-content/themes/shop/header.php ')
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox', { name: 'Файлы проекта' })).toBeNull()
  })

  it('says the files are being read, closes on Escape, and is no mention in an address', () => {
    showWithFiles(null)
    typeAt('@')
    expect(within(files_()).getByRole('status')).toHaveTextContent('Готовим список файлов…')
    press('Escape')
    expect(screen.queryByRole('listbox', { name: 'Файлы проекта' })).toBeNull()
    typeAt('name@site.ru')
    expect(screen.queryByRole('listbox', { name: 'Файлы проекта' })).toBeNull()
  })

  it('is not in a chat without the files of a project', () => {
    showComposer()
    typeAt('@style')
    expect(screen.queryByRole('listbox', { name: 'Файлы проекта' })).toBeNull()
  })

  it('puts the root of the files before the path: the context of a project (plan 84, ПР24)', () => {
    const onSend = vi.fn(async () => true)
    render(
      <Composer
        placeholder="Что поправить?"
        onSend={onSend}
        mentions={{
          paths: ['Брендбук.pdf', 'Фото/витрина.jpg'],
          state: 'ready',
          onOpen: vi.fn(),
          root: '/workspace/project/',
          texts: { label: 'Файлы контекста проекта', none: 'В контексте проекта нет файлов.' },
        }}
      />,
    )
    typeAt('Возьми цвета из @бренд')
    const list = screen.getByRole('listbox', { name: 'Файлы контекста проекта' })
    expect(within(list).getAllByRole('option')[0]).toHaveAccessibleName('Брендбук.pdf')
    press('Enter')
    expect(field().value).toBe('Возьми цвета из @/workspace/project/Брендбук.pdf ')
    // A folder chosen goes on narrowing under the root.
    typeAt('и @Фото')
    press('Enter')
    expect(field().value).toBe('и @/workspace/project/Фото/')
    const narrowed = screen.getByRole('listbox', { name: 'Файлы контекста проекта' })
    expect(within(narrowed).getAllByRole('option')[1]).toHaveAccessibleName('Фото/витрина.jpg')
    press('ArrowDown')
    press('Enter')
    expect(field().value).toBe('и @/workspace/project/Фото/витрина.jpg ')
  })

  it('says a project has no files in its context in its own words', () => {
    render(
      <Composer
        placeholder="Что поправить?"
        onSend={vi.fn(async () => true)}
        mentions={{
          paths: null,
          state: 'none',
          onOpen: vi.fn(),
          root: '/workspace/project/',
          texts: { label: 'Файлы контекста проекта', none: 'В контексте проекта нет файлов.' },
        }}
      />,
    )
    typeAt('@')
    const list = screen.getByRole('listbox', { name: 'Файлы контекста проекта' })
    expect(within(list).getByRole('status')).toHaveTextContent('В контексте проекта нет файлов.')
  })
})
