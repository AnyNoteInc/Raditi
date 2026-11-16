// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScheduleItem } from './schedule-model'
import { ScheduledView } from './scheduled-view'
import {
  CHAT_ID,
  mediaStyleOf,
  PHONE_MEDIA,
  phoneMatchMedia,
  scheduleItem,
  scheduleRun,
  SCHEDULE_ID,
} from './testing'

const { listSchedules, setEnabled, runNow, remove, costHint, push, pathname } = vi.hoisted(() => ({
  listSchedules: vi.fn<() => Promise<{ schedules: ScheduleItem[]; timezone: string }>>(),
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
    project: { list: query('project.list', async () => ({ items: [] })) },
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
afterEach(() => {
  vi.unstubAllGlobals()
})

/** The box of «Новая задача ▾» under the tabs. */
const newTaskBox = () => {
  const box = screen.getByRole('button', { name: 'Новая задача' }).closest('[data-new-task]')
  if (!(box instanceof HTMLElement)) throw new Error('no box of «Новая задача»')
  return box
}

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
    // «i» beside the title says there is something to read at rest, and leads to it by keyboard.
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Запланированные задачи')
    expect(screen.getByRole('button', { name: 'Что это за раздел' })).toHaveAttribute(
      'aria-describedby',
      screen.getByRole('tooltip').id,
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
    expect(screen.getByRole('button', { name: 'Курс валют' })).toHaveAccessibleDescription(
      /По\sбудням\sв\s9:00/,
    )
    // No tools over an empty list.
    expect(screen.queryByRole('button', { name: 'Фильтр задач' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Порядок задач' })).toBeNull()
    // On a phone the list's own «Настроить вручную» stands for «Новая задача», right under it:
    // no second orange button of the whole width. A wide screen keeps it in the corner.
    expect(mediaStyleOf(newTaskBox(), PHONE_MEDIA)).toContain('display:none')
  })

  it('keeps «Новая задача» on a phone once there is a task', async () => {
    list([scheduleItem()])
    show(<ScheduledView userId={USER} tab="yours" />)
    await screen.findByRole('list', { name: 'Ваши запланированные задачи' })
    expect(mediaStyleOf(newTaskBox(), PHONE_MEDIA)).not.toContain('display:none')
  })

  it('gives the focus to «Настроить вручную» on a phone when the last task is deleted', async () => {
    vi.stubGlobal('matchMedia', phoneMatchMedia)
    list([scheduleItem({ name: 'Последняя' })])
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Действия с задачей «Последняя»' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Удалить' }))
    list([])
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Удалить задачу «Последняя»?' })).getByRole(
        'button',
        { name: 'Удалить' },
      ),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Настроить вручную' })).toHaveFocus(),
    )
  })

  it('opens the window of a template filled in, nothing made before «Создать» (Зп9)', async () => {
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Идеи для постов' }))
    const dialog = await screen.findByRole('dialog', { name: 'Новая запланированная задача' })
    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toHaveValue('Идеи для постов')
    expect(
      (within(dialog).getByRole('textbox', { name: 'Что сделать агенту' }) as HTMLTextAreaElement)
        .value,
    ).toContain('Предложи три идеи постов для соцсетей')
    expect(within(dialog).getByRole('button', { name: 'Размышление: Высокое' })).toBeInTheDocument()
  })
})

describe('a task of «Ваши» (Зп5)', () => {
  it('shows its name, schedules, state and latest run, with the switch named by it', async () => {
    list([scheduleItem({ lastRun: scheduleRun() })])
    show(<ScheduledView userId={USER} tab="yours" />)
    const row = (await screen.findByRole('link', { name: 'Проверка сайта' })).closest('li')
    if (!(row instanceof HTMLElement)) throw new Error('no row')
    expect(within(row).getByRole('link', { name: 'Проверка сайта' })).toHaveAttribute(
      'href',
      `/scheduled/${SCHEDULE_ID}`,
    )
    expect(row).toHaveTextContent('По будням в 9:00')
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

  // F30: the row the focus was in goes away; the focus goes to the next row, or to «Новая задача».
  it('gives the focus to the next row after a deletion, and to «Новая задача» after the last', async () => {
    const first = scheduleItem({ id: '019f2a00-0000-7000-8000-000000000101', name: 'Первая' })
    const second = scheduleItem({ id: '019f2a00-0000-7000-8000-000000000102', name: 'Вторая' })
    list([first, second])
    show(<ScheduledView userId={USER} tab="yours" />)
    const deleteFrom = async (name: string) => {
      fireEvent.click(await screen.findByRole('button', { name: `Действия с задачей «${name}»` }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Удалить' }))
      fireEvent.click(
        within(screen.getByRole('dialog', { name: `Удалить задачу «${name}»?` })).getByRole(
          'button',
          { name: 'Удалить' },
        ),
      )
    }
    list([second])
    await deleteFrom('Первая')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Действия с задачей «Вторая»' })).toHaveFocus(),
    )
    await waitFor(() => expect(screen.queryByText('Первая')).toBeNull())
    expect(screen.getByRole('button', { name: 'Действия с задачей «Вторая»' })).toHaveFocus()

    list([])
    await deleteFrom('Вторая')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Новая задача' })).toHaveFocus())
  })

  it('says «Задача удалена» the page of the task left for it, once', async () => {
    sessionStorage.setItem('raditi-schedule-notice', 'deleted')
    show(<ScheduledView userId={USER} tab="yours" />)
    expect(await screen.findByText('Задача удалена')).toBeInTheDocument()
    expect(sessionStorage.getItem('raditi-schedule-notice')).toBeNull()
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
      name: index === 0 ? 'Сводка курсов' : `Задача ${index}`,
      enabled: index % 2 === 0,
      nextRunAt: index % 2 === 0 ? new Date(`2026-11-1${6 + (index % 3)}T06:00:00.000Z`) : null,
      lastRun: index === 3 ? scheduleRun({ state: { kind: 'failed' } }) : null,
    }),
  )

  it('searches above six tasks, by the name and the instructions', async () => {
    list(many)
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Найти задачу' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск задач' }), {
      target: { value: 'курсов' },
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

  it('filters by state with counts (Зп3, Зп57)', async () => {
    list(many)
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Фильтр задач' }))
    const states = screen.getByRole('group', { name: 'Показать' })
    expect(
      within(states)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Все7', 'Включены4', 'На паузе3', 'Завершены0', 'С ошибкой1'])
    // On a phone the row is one line that scrolls sideways, its chips of their own width.
    const phone = mediaStyleOf(states, PHONE_MEDIA)
    expect(phone).toContain('flex-wrap:nowrap')
    expect(phone).toContain('overflow-x:auto')
    expect(phone).toContain('scrollbar-width:none')
    for (const chip of within(states).getAllByRole('button'))
      expect(getComputedStyle(chip).flexShrink).toBe('0')
    const look = (button: HTMLElement) =>
      [...button.classList].filter((each) => /^MuiButton-(color\w+|outlined|contained)$/.test(each))
    const chosen = within(states).getByRole('button', { name: 'Все7' })
    const other = within(states).getByRole('button', { name: 'Включены4' })
    expect(look(chosen)).not.toEqual(look(other))
    fireEvent.click(within(states).getByRole('button', { name: 'На паузе3' }))
    const rows = within(
      screen.getByRole('list', { name: 'Ваши запланированные задачи' }),
    ).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    fireEvent.click(within(states).getByRole('button', { name: 'Завершены0' }))
    expect(screen.getByText('Ничего не нашлось.')).toBeInTheDocument()
  })

  it('names the project of each task and filters by it when there are two or more (ПР19)', async () => {
    const kolos = { id: '019f2a00-0000-7000-8000-00000000aa01', name: 'Колос', gone: false }
    const old = { id: '019f2a00-0000-7000-8000-00000000aa02', name: 'Архивный', gone: true }
    list([
      scheduleItem({ id: '019f2a00-0000-7000-8000-0000000000b1', name: 'Сборки', project: kolos }),
      scheduleItem({ id: '019f2a00-0000-7000-8000-0000000000b2', name: 'Отчёт', project: old }),
      scheduleItem({ id: '019f2a00-0000-7000-8000-0000000000b3', name: 'Курс валют' }),
    ])
    show(<ScheduledView userId={USER} tab="yours" />)
    const rows = await screen.findByRole('list', { name: 'Ваши запланированные задачи' })
    expect(rows).toHaveTextContent('Проект: Колос')
    expect(rows).toHaveTextContent('Проект: Архивный (в архиве или удалён)')
    expect(rows).toHaveTextContent('Без проекта')
    fireEvent.click(screen.getByRole('button', { name: 'Фильтр задач' }))
    const projects = screen.getByRole('group', { name: 'Проект' })
    expect(
      within(projects)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Все проекты', 'Архивный', 'Колос', 'Без проекта'])
    fireEvent.click(within(projects).getByRole('button', { name: 'Колос' }))
    const shown = within(
      screen.getByRole('list', { name: 'Ваши запланированные задачи' }),
    ).getAllByRole('listitem')
    expect(shown.map((row) => within(row).getByRole('heading').textContent)).toEqual(['Сборки'])
    fireEvent.click(within(projects).getByRole('button', { name: 'Без проекта' }))
    expect(
      within(screen.getByRole('list', { name: 'Ваши запланированные задачи' }))
        .getAllByRole('heading')
        .map((each) => each.textContent),
    ).toEqual(['Курс валют'])
  })

  it('has no filter of projects when the tasks are of one', async () => {
    list(many)
    show(<ScheduledView userId={USER} tab="yours" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Фильтр задач' }))
    expect(screen.queryByRole('group', { name: 'Проект' })).toBeNull()
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
    expect(names.at(-1)).toBe('Сводка курсов')
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
    expect(
      screen.getByRole('button', { name: 'Цены конкурентов' }),
    ).not.toHaveAccessibleDescription(/Уже настроен/)
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
