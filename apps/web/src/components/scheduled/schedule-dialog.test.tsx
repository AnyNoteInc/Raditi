// @vitest-environment jsdom
import { scheduleTemplateOf } from '@repo/domain/schedule'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScheduleDialog, type ScheduleDialogOpening } from './schedule-dialog'
import { NOW, scheduleDetail, SITE_ID } from './testing'

const { create, update, costHint, listProjects, push } = vi.hoisted(() => ({
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
  listProjects: vi.fn(async () => [] as unknown[]),
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
      list: query('schedule.list', async () => ({ schedules: [], timezone: 'Europe/Moscow' })),
      get: query('schedule.get', async () => null),
      costHint: query('schedule.costHint', costHint),
      create: mutation(create),
      update: mutation(update),
    },
    project: { list: query('project.list', listProjects) },
  }),
}))

const USER = 'user-1'
const project = {
  id: SITE_ID,
  name: 'Кофейня «Крошка»',
  host: 'kroshka.example',
  chat: { state: 'ready', requirements: { repository: true, browser: true } },
}

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
  return { onClose, onSaved, dialog: screen.getByRole('dialog') }
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
  listProjects.mockResolvedValue([])
  sessionStorage.clear()
  localStorage.clear()
  // The clock alone: React Query and MUI keep their timers.
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
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
          siteId: null,
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
    expect(dialog).toHaveTextContent(/В админке сайта он только читает/)
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
    expect(within(dialog).getAllByRole('group', { name: /^Время запуска \d$/ })).toHaveLength(5)
    expect(within(dialog).queryByRole('button', { name: 'Добавить время' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Убрать время запуска 1' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Убрать время запуска 3' }))
    expect(within(dialog).getAllByRole('group', { name: /^Время запуска \d$/ })).toHaveLength(4)
    // Five daily runs at 9:00 meet: «не чаще раза в час».
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Запуски одной задачи — не чаще раза в час',
    )
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
    fireEvent.click(
      within(dialog).getByRole('switch', { name: 'Уведомлять, когда задача выполнится' }),
    )
    expect(within(dialog).queryByTestId('browser-push')).toBeNull()
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
})

describe('a template (Зп9)', () => {
  it('takes the only project of a template about a site', async () => {
    listProjects.mockResolvedValue([project])
    const { dialog } = show({ kind: 'new', template: template('site-check') })
    expect(
      await within(dialog).findByRole('button', {
        name: 'Проект для этого чата: Кофейня «Крошка»',
      }),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Размышление: Низкое' })).toBeInTheDocument()
  })

  it('wants a project when there is none, and offers to add one', async () => {
    const { dialog } = show({ kind: 'new', template: template('site-check') })
    expect(await within(dialog).findByRole('link', { name: 'Добавьте проект' })).toHaveAttribute(
      'href',
      '/projects/new',
    )
    expect(within(dialog).getByRole('button', { name: 'Создать' })).toBeDisabled()
  })

  it('chooses the place for the addresses of «Конкуренты» to be written over', () => {
    const { dialog } = show({ kind: 'new', template: template('competitors') })
    const field = within(dialog).getByRole('textbox', {
      name: 'Что сделать агенту',
    }) as HTMLTextAreaElement
    expect(field).toHaveFocus()
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe('[впишите адреса]')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Конкуренты' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    expect(within(dialog).getByText('Впишите адреса сайтов конкурентов')).toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
  })
})

describe('«Изменить задачу»', () => {
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
