// @vitest-environment jsdom
import { scheduleTemplateOf } from '@repo/domain/schedule'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScheduleDialog, type ScheduleDialogOpening } from './schedule-dialog'
import { NOW, scheduleDetail } from './testing'

const { create, update, costHint, listSchedules, push } = vi.hoisted(() => ({
  create: vi.fn(async (input: { name: string }) => ({
    id: '019f2a00-0000-7000-8000-0000000000f1',
    ...input,
  })),
  update: vi.fn(async (input: { scheduleId: string }) => ({ id: input.scheduleId })),
  costHint: vi.fn(async () => ({
    averageCredits: 11,
    runsPerWeek: 7,
    creditsPerWeek: 77,
    weeklyLimit: 73,
    overHalf: true,
    nextRunAt: null,
  })),
  listSchedules: vi.fn(async () => ({ schedules: [] as unknown[], timezone: 'Europe/Moscow' })),
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/components/notifications/browser-push-control', () => ({
  BrowserPushControl: () => <span data-testid="browser-push" />,
}))

const query = (key: string, fn: () => Promise<unknown>) => ({
  queryKey: (input?: unknown) => (input === undefined ? [key] : [key, input]),
  queryOptions: (input?: unknown) => ({
    queryKey: input === undefined ? [key] : [key, input],
    queryFn: fn,
  }),
})
const mutation = (fn: (input: never) => Promise<unknown>) => ({
  mutationOptions: (options: object = {}) => ({ mutationFn: fn, ...options }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    schedule: {
      list: query('schedule.list', listSchedules),
      get: query('schedule.get', async () => null),
      costHint: query('schedule.costHint', costHint),
      create: mutation(create),
      update: mutation(update),
    },
  }),
}))

const USER = 'user-1'
function show(
  opening: ScheduleDialogOpening,
  handlers: { onClose?: () => void; onSaved?: () => void } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onClose = handlers.onClose ?? vi.fn()
  const onSaved = handlers.onSaved ?? vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleDialog opening={opening} userId={USER} onClose={onClose} onSaved={onSaved} />
    </QueryClientProvider>,
  )
  return { onClose, onSaved, queryClient, dialog: screen.getByRole('dialog') }
}

const template = (slug: string) => {
  const found = scheduleTemplateOf(slug)
  if (found === undefined) throw new Error(slug)
  return found
}

function choose(dialog: HTMLElement, label: string, option: string, index = 0) {
  fireEvent.mouseDown(within(dialog).getAllByRole('combobox', { name: label })[index]!)
  fireEvent.click(screen.getByRole('option', { name: option }))
}

beforeEach(() => {
  vi.clearAllMocks()
  listSchedules.mockResolvedValue({ schedules: [], timezone: 'Europe/Moscow' })
  sessionStorage.clear()
  localStorage.clear()
  // The clock alone: React Query and MUI keep their timers.
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('«Новая запланированная задача» (plan 82, Зп7, Зп8)', () => {
  it('creates a task every day at a time, and says its next run as it changes', async () => {
    const { dialog, onClose, onSaved } = show({ kind: 'new' })
    expect(dialog).toHaveAccessibleName('Новая запланированная задача')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Сводка заявок' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Что сделать агенту' }), {
      target: { value: 'Соберите заявки за сутки' },
    })
    const block = within(dialog).getByRole('group', { name: 'Время запуска 1' })
    expect(within(block).getByRole('combobox', { name: 'Как часто' })).toHaveTextContent(
      'Ежедневно',
    )
    fireEvent.change(within(block).getByLabelText('Время'), { target: { value: '10:30' } })
    // 12:00 in Moscow now: 10:30 is tomorrow.
    const next = within(dialog).getByText(/^Следующий запуск:/)
    expect(next).toHaveTextContent('Следующий запуск: завтра, 16 ноября, в 10:30')
    expect(next.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        {
          name: 'Сводка заявок',
          instructions: 'Соберите заявки за сутки',
          effort: 'high',
          triggers: [{ kind: 'daily', time: '10:30' }],
          timezone: 'Europe/Moscow',
          notify: true,
          templateSlug: null,
        },
        expect.anything(),
      ),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'Сводка заявок' }), true)
  })

  it('warns that the task runs without the client, and says its cost', async () => {
    const { dialog } = show({ kind: 'new' })
    expect(dialog).toHaveTextContent(/Задача выполняется без вас/)
    // Зп56: on every site it only reads, and what to change it asks in the chat of the run.
    expect(dialog).toHaveTextContent(
      /На сайтах он только читает — ничего не отправляет, не сохраняет и не покупает/,
    )
    expect(dialog).toHaveTextContent(/подготовит и спросит вас в чате запуска/)
    expect(dialog).not.toHaveTextContent(/админк|предпросмотр|выпуск/)
    // What the platform refuses in such a run (Зп28, Зп32): pages and the keyed skills too, the
    // skills in plain words.
    expect(dialog).toHaveTextContent(/страницы из раздела «Страницы» не публикует и не меняет/)
    expect(dialog).toHaveTextContent(
      /к подключённым сервисам, которым нужен ваш ключ доступа, не обращается/,
    )
    expect(dialog).not.toHaveTextContent(/навык/)
    // A note drawn apart from the filled box of the instructions: outlined on the paper.
    const note = within(dialog).getByRole('note')
    expect(note).toHaveTextContent(/Задача выполняется без вас/)
    expect(note).toHaveClass('MuiAlert-outlined')
    expect(getComputedStyle(note).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(
      await within(dialog).findByText(
        /Каждый запуск тратит кредиты, как обычный чат, — в среднем около 11\. Так выйдет примерно 77 в неделю; ваш недельный лимит — 73\. Остальным чатам останется меньше\./,
      ),
    ).toBeInTheDocument()
  })

  it('tells what is missing when «Создать» is pressed, and creates nothing', () => {
    const { dialog } = show({ kind: 'new' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    expect(within(dialog).getByText('Назовите задачу')).toBeInTheDocument()
    expect(within(dialog).getByText('Напишите, что сделать агенту')).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toHaveFocus()
    expect(create).not.toHaveBeenCalled()
  })

  it('adds up to five times, each its own group, and removes one from the second', () => {
    const { dialog } = show({ kind: 'new' })
    const add = () => within(dialog).getByRole('button', { name: 'Добавить время' })
    for (let index = 0; index < 4; index += 1) fireEvent.click(add())
    const blocks = within(dialog).getAllByRole('group', { name: /^Время запуска \d$/ })
    expect(blocks).toHaveLength(5)
    // Each new time keeps an hour from the others: the window does not turn red by itself (F28).
    expect(
      blocks.map((block) => (within(block).getByLabelText('Время') as HTMLInputElement).value),
    ).toEqual(['09:00', '12:00', '15:00', '18:00', '21:00'])
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).getByText(/^Следующий запуск:/)).toHaveTextContent(
      'Следующий запуск: сегодня, 15 ноября, в 15:00',
    )
    expect(within(dialog).queryByRole('button', { name: 'Добавить время' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Убрать время запуска 1' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Убрать время запуска 3' }))
    expect(within(dialog).getAllByRole('group', { name: /^Время запуска \d$/ })).toHaveLength(4)
  })

  it('says the rule of an hour once the client makes two times meet', () => {
    const { dialog } = show({ kind: 'new' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить время' }))
    const second = within(dialog).getByRole('group', { name: 'Время запуска 2' })
    fireEvent.change(within(second).getByLabelText('Время'), { target: { value: '09:30' } })
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Запуски одной задачи — не чаще раза в час',
    )
    expect(within(dialog).queryByText(/^Следующий запуск:/)).toBeNull()
  })

  // F27: a cleared or half-typed date is the block's, not «не чаще раза в час».
  it('wants the date of a single run that the field does not hold whole', () => {
    const { dialog } = show({ kind: 'new' })
    choose(dialog, 'Как часто', 'Один раз')
    const block = within(dialog).getByRole('group', { name: 'Время запуска 1' })
    for (const date of ['', '0002-11-15']) {
      fireEvent.change(within(block).getByLabelText('Дата'), { target: { value: date } })
      expect(block).toHaveTextContent('Укажите дату')
      expect(block).not.toHaveTextContent('Это время уже прошло')
      expect(within(dialog).queryByRole('alert')).toBeNull()
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    expect(create).not.toHaveBeenCalled()
  })

  it('says at once that a single run is in the past', () => {
    const { dialog } = show({ kind: 'new' })
    choose(dialog, 'Как часто', 'Один раз')
    const block = within(dialog).getByRole('group', { name: 'Время запуска 1' })
    expect(within(block).getByLabelText('Дата')).toHaveAttribute('min', '2026-11-15')
    fireEvent.change(within(block).getByLabelText('Дата'), { target: { value: '2026-11-15' } })
    fireEvent.change(within(block).getByLabelText('Время'), { target: { value: '11:00' } })
    expect(block).toHaveTextContent('Это время уже прошло — выберите другое')
  })

  it('offers the days of a week, read by their full names', () => {
    const { dialog } = show({ kind: 'new' })
    choose(dialog, 'Как часто', 'Еженедельно')
    const days = within(dialog).getByRole('group', { name: 'Дни недели' })
    const monday = within(days).getByRole('button', { name: 'понедельник' })
    expect(monday).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(days).getByRole('button', { name: 'пятница' }))
    expect(within(days).getByRole('button', { name: 'пятница' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(monday)
    fireEvent.click(within(days).getByRole('button', { name: 'пятница' }))
    expect(dialog).toHaveTextContent('Выберите хотя бы один день')
  })

  it('offers «Только вручную» and then no time to add', () => {
    const { dialog } = show({ kind: 'new' })
    choose(dialog, 'Как часто', 'Только вручную')
    expect(within(dialog).queryByRole('button', { name: 'Добавить время' })).toBeNull()
    expect(dialog).toHaveTextContent(
      'Задача запустится, только когда вы нажмёте «Запустить сейчас».',
    )
  })

  // F26: the name is told by its own field, before the server and after it.
  it('tells a name that reads as a key under «Название», not under the instructions', async () => {
    const { dialog } = show({ kind: 'new' })
    const name = within(dialog).getByRole('textbox', { name: 'Название' })
    fireEvent.change(name, { target: { value: 'Kx9mP2vLq7wZ' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Что сделать агенту' }), {
      target: { value: 'Соберите заявки' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    expect(name).toHaveAccessibleDescription('Похоже, в названии пароль или ключ — уберите его')
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveFocus()
    expect(create).not.toHaveBeenCalled()
    const instructions = within(dialog).getByRole('textbox', { name: 'Что сделать агенту' })
    expect(instructions).not.toHaveAttribute('aria-invalid')
  })

  it('tells a refusal of the server by its field, or on top', async () => {
    const { dialog } = show({ kind: 'new' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Сводка' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Что сделать агенту' }), {
      target: { value: 'Войдите с паролем qwerty123456' },
    })
    create.mockRejectedValueOnce(
      Object.assign(new Error('Похоже, в сообщении есть пароль или ключ'), {
        data: { code: 'BAD_REQUEST', domainCode: 'TASK_TEXT_HAS_SECRET' },
      }),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    const field = within(dialog).getByRole('textbox', { name: 'Что сделать агенту' })
    await waitFor(() =>
      expect(field).toHaveAccessibleDescription(
        'Похоже, в инструкции пароль или ключ — уберите его',
      ),
    )
    expect(field).toHaveAttribute('aria-invalid', 'true')

    create.mockRejectedValueOnce(
      Object.assign(
        new Error('Включено 20 задач — больше нельзя. Приостановите или удалите одну'),
        {
          data: { code: 'CONFLICT', domainCode: 'SCHEDULE_LIMIT' },
        },
      ),
    )
    fireEvent.change(field, { target: { value: 'Соберите заявки' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    expect(
      await within(dialog).findByText(
        'Включено 20 задач — больше нельзя. Приостановите или удалите одну.',
      ),
    ).toBeInTheDocument()
  })

  it('sets the task up in a chat instead, with what is written (Зп10)', () => {
    const { dialog } = show({ kind: 'new' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Сводка' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Что сделать агенту' }), {
      target: { value: 'Соберите заявки' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Вместо этого настроить в чате' }))
    expect(push).toHaveBeenCalledWith('/chats/new')
    expect(JSON.parse(sessionStorage.getItem('raditi-new-chat-draft') ?? '{}')).toEqual({
      userId: USER,
      text: 'Помогите настроить запланированную задачу «Сводка»: Соберите заявки; Ежедневно в 9:00',
    })
  })

  it('turns the notice off, and offers the push of this browser while it is on (Зп36)', async () => {
    const { dialog } = show({ kind: 'new' })
    expect(within(dialog).getByTestId('browser-push')).toBeInTheDocument()
    const toggle = within(dialog).getByRole('switch', {
      name: 'Уведомлять, когда задача выполнится',
    })
    // The hint keeps its short words to the next ones (nbsp): `\s` meets them.
    expect(toggle).toHaveAccessibleDescription(
      /^О\sвопросах агента и\sсбоях сообщим в\sлюбом случае\.$/,
    )
    // The hint and the push stand under the label, in its column, in one quiet style.
    const notes = dialog.querySelector('[data-notify-notes]')
    if (!(notes instanceof HTMLElement)) throw new Error('no notes')
    const hint = within(notes).getByText('О вопросах агента и сбоях сообщим в любом случае.')
    expect(hint).toHaveClass('MuiTypography-body2')
    expect(notes).toContainElement(within(dialog).getByTestId('browser-push'))
    const label = within(dialog).getByText('Уведомлять, когда задача выполнится')
    expect(notes.parentElement).toBe(label.parentElement)
    expect(notes.parentElement).toContainElement(toggle)
    fireEvent.click(label)
    expect(toggle).not.toBeChecked()
    expect(within(dialog).queryByTestId('browser-push')).toBeNull()
  })

  // F35: the list may first answer an old zone, then the one the cabinet remembered of the browser.
  it('follows the zone of the list as it comes, until the client picks one', async () => {
    listSchedules.mockResolvedValueOnce({ schedules: [], timezone: 'Asia/Yekaterinburg' })
    listSchedules.mockResolvedValue({ schedules: [], timezone: 'Asia/Novosibirsk' })
    const { dialog, queryClient } = show({ kind: 'new' })
    const next = () => within(dialog).getByText(/^Следующий запуск:/)
    await waitFor(() => expect(next()).toHaveTextContent('(по времени Екатеринбурга)'))
    await act(() => queryClient.invalidateQueries({ queryKey: ['schedule.list'] }))
    await waitFor(() => expect(next()).toHaveTextContent('(по времени Новосибирска)'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Дополнительные настройки' }))
    choose(dialog, 'Часовой пояс', 'Самара')
    expect(next()).toHaveTextContent('(по времени Самары)')
    listSchedules.mockResolvedValue({ schedules: [], timezone: 'Asia/Yekaterinburg' })
    await act(() => queryClient.invalidateQueries({ queryKey: ['schedule.list'] }))
    await waitFor(() => expect(listSchedules).toHaveBeenCalledTimes(3))
    expect(next()).toHaveTextContent('(по времени Самары)')
  })

  it('keeps the zone under «Дополнительные настройки»', () => {
    const { dialog } = show({ kind: 'new' })
    const more = within(dialog).getByRole('button', { name: 'Дополнительные настройки' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    choose(dialog, 'Часовой пояс', 'Новосибирск')
    expect(within(dialog).getByText(/^Следующий запуск:/)).toHaveTextContent(
      '(по времени Новосибирска)',
    )
  })

  it('draws a line under the title once scrolled, and a shadow over the buttons while more is below', () => {
    // jsdom lays nothing out: the body tells its sizes here, and the observer reports on demand.
    let report = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          report = callback
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const { dialog } = show({ kind: 'new' })
    const header = within(dialog).getByRole('heading', { name: 'Новая запланированная задача' })
      .parentElement as HTMLElement
    const body = header.nextElementSibling as HTMLElement
    const footer = within(dialog).getByRole('button', { name: 'Создать' })
      .parentElement as HTMLElement
    expect(body).toContainElement(within(dialog).getByRole('textbox', { name: 'Название' }))
    let scrollTop = 0
    Object.defineProperties(body, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => 900 },
      scrollTop: { configurable: true, get: () => scrollTop },
    })

    // Opened: the start of the form, more of it below.
    act(() => report())
    // Transparent, as jsdom computes it.
    const clear = 'rgba(0, 0, 0, 0)'
    expect(getComputedStyle(header).borderBottomColor).toBe(clear)
    expect(getComputedStyle(footer).boxShadow).toContain('rgba(0, 0, 0, 0.12)')

    // Scrolled to the end: the title is ruled off, nothing more below.
    scrollTop = 500
    fireEvent.scroll(body)
    expect(getComputedStyle(header).borderBottomColor).not.toBe(clear)
    expect(getComputedStyle(footer).boxShadow).toBe('none')
  })
})

describe('a template (Зп9)', () => {
  it('fills a template in with «Размышление» on the left, and no project to choose (Зп55)', async () => {
    const { dialog } = show({ kind: 'new', template: template('currency-rates') })
    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toHaveValue('Курс валют')
    expect(within(dialog).getByRole('button', { name: 'Размышление: Низкое' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /^Проект/ })).toBeNull()
    expect(within(dialog).queryByRole('link', { name: /проект/i })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Создать' })).toBeEnabled()
  })

  // Зп59: the place to fill in is chosen to be written over, said quietly, then as an error.
  it('chooses the place to fill in, keeps «Создать» on, and sends nothing while it is left', async () => {
    const { dialog } = show({ kind: 'new', template: template('competitors') })
    const field = within(dialog).getByRole('textbox', {
      name: 'Что сделать агенту',
    }) as HTMLTextAreaElement
    expect(field).toHaveFocus()
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe(
      '[впишите адреса сайтов]',
    )
    const hint = within(dialog).getByText('Замените текст в квадратных скобках своим')
    expect(hint).not.toHaveClass('Mui-error')
    expect(field).not.toHaveAttribute('aria-invalid')
    expect(field.getAttribute('aria-describedby')).toBe(hint.id)
    const button = within(dialog).getByRole('button', { name: 'Создать' })
    expect(button).toBeEnabled()
    // Elsewhere meanwhile: «Создать» brings the focus back on the place, chosen again.
    within(dialog).getByRole('textbox', { name: 'Название' }).focus()
    fireEvent.click(button)
    expect(create).not.toHaveBeenCalled()
    const said = within(dialog).getByText('Замените текст в квадратных скобках своим')
    expect(said).toHaveClass('Mui-error')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveFocus()
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe(
      '[впишите адреса сайтов]',
    )
    // Written over, the task is made.
    fireEvent.change(field, {
      target: { value: field.value.replace('[впишите адреса сайтов]', 'kofe.ru, chai.ru') },
    })
    fireEvent.click(button)
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({
      instructions:
        'Посмотри сайты конкурентов: kofe.ru, chai.ru. Расскажи, какие у них сейчас цены, акции и новости.',
      templateSlug: 'competitors',
    })
  })

  it('tells the refusal of the place by the field of the instructions', async () => {
    create.mockRejectedValueOnce(
      Object.assign(new Error('Замените текст в квадратных скобках своим'), {
        data: { code: 'BAD_REQUEST', domainCode: 'SCHEDULE_TEMPLATE_PLACEHOLDER' },
      }),
    )
    const { dialog } = show({ kind: 'new', template: template('currency-rates') })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    const said = await within(dialog).findByText('Замените текст в квадратных скобках своим')
    expect(said).toHaveClass('Mui-error')
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })
})

describe('«Изменить задачу»', () => {
  // F31: renaming a finished «Один раз» is not a new run (Зп15, Зп24).
  it('renames a finished single run without asking for a new date', async () => {
    const schedule = scheduleDetail({
      triggers: [{ kind: 'once', date: '2026-11-14', time: '09:00' }],
      enabled: false,
      pausedReason: 'completed',
      nextRunAt: null,
    })
    const { dialog } = show({ kind: 'edit', schedule })
    expect(dialog).not.toHaveTextContent('Это время уже прошло')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Проверка перед выпуском' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        { scheduleId: schedule.id, name: 'Проверка перед выпуском' },
        expect.anything(),
      ),
    )
    // A change of its time is a new run: in the past, it is told.
    const block = within(dialog).getByRole('group', { name: 'Время запуска 1' })
    fireEvent.change(within(block).getByLabelText('Время'), { target: { value: '10:00' } })
    expect(block).toHaveTextContent('Это время уже прошло — выберите другое')
  })

  it('sends only what changed', async () => {
    const schedule = scheduleDetail()
    const { dialog } = show({ kind: 'edit', schedule })
    expect(dialog).toHaveAccessibleName('Изменить задачу')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Проверка сайта утром' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        { scheduleId: schedule.id, name: 'Проверка сайта утром' },
        expect.anything(),
      ),
    )
  })
})
