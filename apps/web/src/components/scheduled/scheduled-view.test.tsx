// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScheduleItem } from './schedule-model'
import { ScheduledView } from './scheduled-view'
import { CHAT_ID, scheduleItem, scheduleRun, SCHEDULE_ID, SITE_ID } from './testing'

const { listSchedules, listProjects, setEnabled, runNow, remove, costHint, push, pathname } =
  vi.hoisted(() => ({
    listSchedules: vi.fn<() => Promise<{ schedules: ScheduleItem[]; timezone: string }>>(),
    listProjects: vi.fn(async () => [] as unknown[]),
    setEnabled: vi.fn(async (input: { scheduleId: string; enabled: boolean }) => input),
    runNow: vi.fn(async (_input: unknown) => ({ taskId: '019f2a00-0000-7000-8000-0000000000c9' })),
    remove: vi.fn(async (_input: unknown) => ({ deleted: true as const })),
    costHint: vi.fn(async () => ({
      averageCredits: 11,
      runsPerWeek: 7,
      creditsPerWeek: 77,
      weeklyLimit: 73,
      overHalf: true,
      nextRunAt: null,
    })),
    push: vi.fn(),
    pathname: { current: '/scheduled' },
  }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname.current,
}))
// The push of this browser reads the service worker: here it is a mark of where it stands.
vi.mock('@/components/notifications/browser-push-control', () => ({
  BrowserPushControl: () => <span data-testid="browser-push" />,
}))

const mutation = (fn: (input: never) => Promise<unknown>) => ({
  mutationOptions: (options: object = {}) => ({ mutationFn: fn, ...options }),
})
const query = (key: string, fn: (input?: unknown) => Promise<unknown>) => ({
  queryKey: (input?: unknown) => (input === undefined ? [key] : [key, input]),
  queryOptions: (input?: unknown) => ({
    queryKey: input === undefined ? [key] : [key, input],
    queryFn: () => fn(input),
  }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    schedule: {
      list: query('schedule.list', listSchedules),
      get: query('schedule.get', async () => null),
      costHint: query('schedule.costHint', costHint),
      setEnabled: mutation(setEnabled),
      runNow: mutation(runNow),
      delete: mutation(remove),
      create: mutation(async () => null),
      update: mutation(async () => null),
    },
    project: { list: query('project.list', listProjects) },
  }),
}))

function show(node: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

const USER = 'user-1'
const list = (schedules: ScheduleItem[]) =>
  listSchedules.mockResolvedValue({ schedules, timezone: 'Europe/Moscow' })

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  pathname.current = '/scheduled'
  list([])
})

describe('«Запланированные задачи» (plan 82, Зп2)', () => {
  it('names the section with what it is, and has «Ваши» and «Шаблоны»', async () => {
    show(<ScheduledView userId={USER} tab="yours" />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Запланированные задачи')
    const tabs = screen.getByRole('navigation', { name: 'Запланированные задачи' })
    expect(within(tabs).getByRole('link', { name: 'Ваши' })).toHaveAttribute('aria-current', 'page')
    expect(within(tabs).getByRole('link', { name: 'Шаблоны' })).toHaveAttribute(
      'href',
      '/scheduled/templates',
    )
    fireEvent.mouseOver(
      within(screen.getByRole('heading', { level: 1 })).getByText('Запланированные задачи'),
    )
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Агент выполняет их сам по расписанию',
    )
  })

  it('offers «Настроить вручную» and «Настроить в чате» under «Новая задача»', async () => {
    show(<ScheduledView userId={USER} tab="yours" />)
    const button = screen.getByRole('button', { name: 'Новая задача' })
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.click(button)
    const menu = screen.getByRole('menu', { name: 'Как настроить новую задачу' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Настроить вручную', 'Настроить в чате'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Настроить в чате' }))
    // The words go into the draft of a new chat, unsent (Зп10).
    expect(push).toHaveBeenCalledWith('/chats/new')
    expect(JSON.parse(sessionStorage.getItem('raditi-new-chat-draft') ?? '{}')).toEqual({
      userId: USER,
      text: 'Помогите настроить запланированную задачу',
    })
  })
})

describe('before the first task (Зп4)', () => {
  it('draws the stopwatch, says nothing is here, and offers the six templates', async () => {
    show(<ScheduledView userId={USER} tab="yours" />)
    expect(await screen.findByText('Запланированных задач пока нет.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Настроить вручную' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Настроить в чате' })).toBeInTheDocument()
    expect(screen.getByText('Или начните с шаблона')).toBeInTheDocument()
    const templates = within(screen.getByRole('list', { name: 'Шаблоны задач' })).getAllByRole(
      'button',
    )
    expect(
      templates.map((each) => each.getAttribute('aria-labelledby') && each.textContent),
    ).toHaveLength(6)
    expect(screen.getByRole('button', { name: 'Проверка сайта' })).toHaveAccessibleDescription(
      /По\sбудням\sв\s9:00/,
    )
    // No tools over an empty list.
    expect(screen.queryByRole('button', { name: 'Фильтр задач' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Порядок задач' })).toBeNull()
  })

  it('opens the window of a template filled in, nothing made before «Создать» (Зп9)', async () => {
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Идеи для новостей' }))
    const dialog = await screen.findByRole('dialog', { name: 'Новая запланированная задача' })
    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toHaveValue(
      'Идеи для новостей',
    )
    expect(
      (within(dialog).getByRole('textbox', { name: 'Что сделать агенту' }) as HTMLTextAreaElement)
        .value,
    ).toContain('Предложите три идеи для новостей')
    expect(within(dialog).getByRole('button', { name: 'Размышление: Высокое' })).toBeInTheDocument()
  })
})

describe('a task of «Ваши» (Зп5)', () => {
  it('shows its name, schedules, project, state and latest run, with the switch named by it', async () => {
    list([scheduleItem({ lastRun: scheduleRun() })])
    show(<ScheduledView userId={USER} tab="yours" />)
    const row = (await screen.findByRole('link', { name: 'Проверка сайта' })).closest('li')
    if (!(row instanceof HTMLElement)) throw new Error('no row')
    expect(within(row).getByRole('link', { name: 'Проверка сайта' })).toHaveAttribute(
      'href',
      `/scheduled/${SCHEDULE_ID}`,
    )
    expect(row).toHaveTextContent('По будням в 9:00')
    expect(row).toHaveTextContent('Кофейня «Крошка»')
    expect(row).toHaveTextContent(/Следующий запуск: (завтра|.*) в 9:00/)
    expect(row).toHaveTextContent(/Выполнена · .* в 9:00/)
    const toggle = within(row).getByRole('switch', { name: 'Включить задачу «Проверка сайта»' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith(
        { scheduleId: SCHEDULE_ID, enabled: false },
        expect.anything(),
      ),
    )
  })

  it('runs a task now and opens the chat of its run (Зп24)', async () => {
    list([scheduleItem()])
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия с задачей «Проверка сайта»' }),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Запустить сейчас' }))
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/chats/019f2a00-0000-7000-8000-0000000000c9'),
    )
  })

  it('tells a refused run in the server words', async () => {
    list([scheduleItem()])
    runNow.mockRejectedValueOnce(
      Object.assign(new Error('Задача уже выполняется'), {
        data: { code: 'CONFLICT', domainCode: 'SCHEDULE_RUN_BUSY' },
      }),
    )
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия с задачей «Проверка сайта»' }),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Запустить сейчас' }))
    expect(await screen.findByText('Задача уже выполняется.')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('asks before deleting, and says the chats stay (Зп23)', async () => {
    list([scheduleItem()])
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия с задачей «Проверка сайта»' }),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Удалить' }))
    const confirm = screen.getByRole('dialog', { name: 'Удалить задачу «Проверка сайта»?' })
    expect(confirm).toHaveAccessibleDescription('Чаты прошлых запусков останутся.')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Удалить' }))
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith({ scheduleId: SCHEDULE_ID }, expect.anything()),
    )
    expect(await screen.findByText('Задача удалена')).toBeInTheDocument()
  })

  it('opens «Изменить задачу» with its fields', async () => {
    list([scheduleItem()])
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия с задачей «Проверка сайта»' }),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Изменить' }))
    const dialog = await screen.findByRole('dialog', { name: 'Изменить задачу' })
    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toHaveValue('Проверка сайта')
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: 'Вместо этого настроить в чате' }),
    ).toBeNull()
  })
})

describe('the tools of «Ваши» (Зп3)', () => {
  const many = Array.from({ length: 7 }, (_, index) =>
    scheduleItem({
      id: `019f2a00-0000-7000-8000-00000000010${index}`,
      name: index === 0 ? 'Заявки за сутки' : `Задача ${index}`,
      enabled: index % 2 === 0,
      nextRunAt: index % 2 === 0 ? new Date(`2026-11-1${6 + (index % 3)}T06:00:00.000Z`) : null,
      project: index === 6 ? null : { id: SITE_ID, name: 'Кофейня «Крошка»' },
      lastRun: index === 3 ? scheduleRun({ state: { kind: 'failed' } }) : null,
    }),
  )

  it('searches above six tasks, by the name and the instructions', async () => {
    list(many)
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Найти задачу' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск задач' }), {
      target: { value: 'заявки' },
    })
    const rows = within(
      screen.getByRole('list', { name: 'Ваши запланированные задачи' }),
    ).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск задач' }), {
      target: { value: 'нет такой' },
    })
    expect(screen.getByText('Ничего не нашлось.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }))
    expect(screen.getByRole('textbox', { name: 'Поиск задач' })).toHaveValue('')
  })

  it('has no search for six tasks or fewer', async () => {
    list(many.slice(0, 6))
    show(<ScheduledView userId={USER} tab="yours" />)
    await screen.findByRole('list', { name: 'Ваши запланированные задачи' })
    expect(screen.queryByRole('button', { name: 'Найти задачу' })).toBeNull()
  })

  it('filters by state with counts, and by project when there are several', async () => {
    list(many)
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Фильтр задач' }))
    const states = screen.getByRole('group', { name: 'Показать' })
    expect(
      within(states)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Все7', 'Включены4', 'На паузе3', 'Завершены0', 'С ошибкой1'])
    fireEvent.click(within(states).getByRole('button', { name: 'На паузе3' }))
    const rows = within(
      screen.getByRole('list', { name: 'Ваши запланированные задачи' }),
    ).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    const projects = screen.getByRole('group', { name: 'Проект' })
    // The counts of the projects follow the state chosen: the task without one is not paused.
    fireEvent.click(within(projects).getByRole('button', { name: 'Без проекта0' }))
    expect(screen.getByText('Ничего не нашлось.')).toBeInTheDocument()
  })

  it('orders by the next run, by name or the newest first', async () => {
    list(many)
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Порядок задач' }))
    const order = screen.getByRole('menu', { name: 'Порядок задач' })
    expect(
      within(order)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['По следующему запуску', 'По названию', 'Сначала новые'])
    expect(
      within(order).getByRole('menuitemradio', { name: 'По следующему запуску' }),
    ).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(order).getByRole('menuitemradio', { name: 'По названию' }))
    const names = within(screen.getByRole('list', { name: 'Ваши запланированные задачи' }))
      .getAllByRole('heading', { level: 3 })
      .map((each) => each.textContent)
    expect(names[0]).toBe('Задача 1')
    expect(names.at(-1)).toBe('Заявки за сутки')
  })
})

describe('the tab «Шаблоны» (Зп9)', () => {
  it('lists the six templates and marks the one already set up', async () => {
    pathname.current = '/scheduled/templates'
    list([scheduleItem({ templateSlug: 'site-check', createdVia: 'template' })])
    show(<ScheduledView userId={USER} tab="templates" />)
    const tabs = screen.getByRole('navigation', { name: 'Запланированные задачи' })
    expect(within(tabs).getByRole('link', { name: 'Шаблоны' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    const check = await screen.findByRole('button', { name: 'Проверка сайта' })
    expect(check).toHaveAccessibleDescription(/Уже настроен/)
    expect(screen.getByRole('button', { name: 'Конкуренты' })).not.toHaveAccessibleDescription(
      /Уже настроен/,
    )
    expect(
      within(screen.getByRole('list', { name: 'Шаблоны задач' })).getAllByRole('listitem'),
    ).toHaveLength(6)
  })
})

describe('when the list could not be read', () => {
  it('says so and offers «Повторить»', async () => {
    listSchedules.mockRejectedValueOnce(new Error('offline'))
    show(<ScheduledView userId={USER} tab="yours" />)
    expect(
      await screen.findByText('Не удалось загрузить задачи. Попробуйте ещё раз.'),
    ).toBeInTheDocument()
    list([scheduleItem()])
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByRole('link', { name: 'Проверка сайта' })).toBeInTheDocument()
  })
})

void CHAT_ID
