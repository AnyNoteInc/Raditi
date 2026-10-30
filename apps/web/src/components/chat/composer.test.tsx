// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'

import { Composer, pastedFiles } from './composer'
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

describe('the window of commands', () => {
  it('opens on «/» at the start of the field, with the Russian names, and says how to use it', () => {
    const { onOpen } = showComposer()
    expect(screen.queryByRole('listbox')).toBeNull()
    type('/')
    const options = within(list()).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Выпустить новую версию'),
      expect.stringContaining('Открыть предпросмотр'),
      expect.stringContaining('Сбросить данные предпросмотра'),
      expect.stringContaining('Обновить рабочую копию'),
      expect.stringContaining('Отменить диалог'),
    ])
    expect(field().getAttribute('aria-controls')).toBe(list().id)
    expect(field().getAttribute('aria-activedescendant')).toBe(options[0]!.id)
    expect(options[0]!.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe(
      '5 команд. Стрелки вверх и вниз — выбор, Enter — выполнить, Escape — закрыть.',
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
    ).toEqual(['release', 'reset'])
    type('/release please')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('moves with the arrows and runs the chosen command with Enter, never sending its words', () => {
    const { onRun, onSend } = showComposer()
    type('/')
    press('ArrowDown')
    press('ArrowDown')
    const options = within(list()).getAllByRole('option')
    expect(field().getAttribute('aria-activedescendant')).toBe(options[2]!.id)
    press('ArrowUp')
    press('Enter')
    expect(onRun).toHaveBeenCalledWith('preview')
    expect(onSend).not.toHaveBeenCalled()
    expect(field().value).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows a command the server refuses with its reason, and choosing it runs nothing', () => {
    const { onRun } = showComposer({ release: 'no_candidate' })
    type('/')
    const release = within(list()).getAllByRole('option')[0]!
    expect(release.getAttribute('aria-disabled')).toBe('true')
    expect(release.textContent).toContain('Пока нечего выпускать: изменений ещё нет.')
    expect(release.textContent).toContain('Недоступна')
    press('Enter')
    expect(onRun).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('Пока нечего выпускать: изменений ещё нет.')
    fireEvent.click(release)
    expect(onRun).not.toHaveBeenCalled()
  })

  it('closes with Escape and keeps the text; it stays closed until the field starts anew', () => {
    showComposer()
    type('/up')
    press('Escape')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field().value).toBe('/up')
    type('/upd')
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
    const { onRun } = showComposer()
    const button = screen.getByRole('button', { name: 'Команды' })
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(within(list()).getAllByRole('option')).toHaveLength(5)
    expect(list().getAttribute('tabindex')).toBe('0')
    await vi.waitFor(() => expect(document.activeElement).toBe(list()))
    press('End', list())
    expect(list().getAttribute('aria-activedescendant')).toMatch(/cancel$/)
    press('Escape', list())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    fireEvent.click(within(list()).getAllByRole('option')[3]!)
    expect(onRun).toHaveBeenCalledWith('update')
  })

  it('keeps a draft the button opened the list over, and gives the focus back to the field', async () => {
    const { onRun, onSend } = showComposer()
    type('Ещё поменяйте цену латте')
    fireEvent.click(screen.getByRole('button', { name: 'Команды' }))
    await vi.waitFor(() => expect(document.activeElement).toBe(list()))
    fireEvent.click(within(list()).getAllByRole('option')[1]!)
    expect(onRun).toHaveBeenCalledWith('preview')
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
    press('End', list())
    press('Enter', list())
    expect(onRun).toHaveBeenCalledWith('cancel')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('says why a command typed in whole cannot be run now, and runs nothing', () => {
    const { onRun, onSend } = showComposer({ release: 'checks_failed' })
    type('/release')
    press('Escape')
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(onRun).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Проверки изменений не прошли.')
    expect(field().value).toBe('/release')
    type('/releas')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a field without commands', () => {
  it('never sends a command as words: there is no dialog to run it in yet', () => {
    const onSend = vi.fn(async () => true)
    render(<Composer placeholder="Что поменять на сайте?" onSend={onSend} />)
    type('/release')
    expect(screen.queryByRole('listbox')).toBeNull()
    press('Enter', field(), { ctrlKey: true })
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(
      'Команды работают внутри диалога. Сначала опишите, что поменять на сайте.',
    )
    expect(described(field())).toContain('Команды работают внутри диалога.')
    type('/release и поменяйте цену')
    press('Enter', field(), { ctrlKey: true })
    expect(onSend).toHaveBeenCalledWith('/release и поменяйте цену', [])
  })
})

describe('the field', () => {
  it('sends with the button or Ctrl+Enter; Enter alone is a new line', async () => {
    const { onSend } = showComposer()
    type('Поменяйте цену')
    press('Enter')
    expect(onSend).not.toHaveBeenCalled()
    press('Enter', field(), { ctrlKey: true })
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

  it('keeps its controls in one order: «/», the paperclip, «Размышление», then «Отправить»', () => {
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
    ).toEqual(['Команды', 'Прикрепить файлы', 'Размышление: Высокое', 'Отправить'])
    const attach = screen.getByRole<HTMLButtonElement>('button', { name: 'Прикрепить файлы' })
    // A paperclip, not «+»: «+» of a dialog is its tools (docs/plan/59, И15).
    expect(outline(attach)).toBe(outlineOf('attach'))
    expect(outline(attach)).not.toBe(outlineOf('plus'))
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

  it('takes a command without a verdict for one that cannot be run', () => {
    const [release] = paletteOptions('/release', [])
    expect(release).toEqual({ id: 'release', available: false, reason: null })
  })

  it('gives a command without a verdict the reason of the place, when it has one', () => {
    const [release] = paletteOptions('/release', [], undefined, 'Команды работают внутри диалога.')
    expect(release).toEqual({
      id: 'release',
      available: false,
      reason: 'Команды работают внутри диалога.',
    })
  })

  it('lists «Отменить выпуск» only with a verdict on it', () => {
    expect(paletteOptions('/undo', [])).toEqual([])
    expect(
      paletteOptions('/undo', [{ id: 'undo', available: false, refusal: 'undo_expired' }]),
    ).toEqual([
      {
        id: 'undo',
        available: false,
        reason:
          'Отменить выпуск можно в течение 7 дней после установки. Опишите в новом диалоге, что нужно вернуть.',
      },
    ])
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
