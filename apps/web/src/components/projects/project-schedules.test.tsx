// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NOW, scheduleItem } from '@/components/scheduled/testing'

import { ProjectSchedulesRow } from './project-schedules'
import type { ProjectDetails } from './project-types'

const PROJECT_ID = '0199a3f2-0000-7000-8000-00000000c001'

const calls = vi.hoisted(() => ({
  list: vi.fn<(input: unknown) => Promise<unknown>>(),
  create: vi.fn(async (input: { name: string }) => ({
    id: '019f2a00-0000-7000-8000-0000000000f1',
    ...input,
  })),
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: calls.push }) }))
vi.mock('@/components/notifications/browser-push-control', () => ({
  BrowserPushControl: () => <span data-testid="browser-push" />,
}))

const query = (key: string, fn: (input?: unknown) => Promise<unknown>) => ({
  queryKey: (input?: unknown) => (input === undefined ? [key] : [key, input]),
  queryOptions: (input?: unknown) => ({
    queryKey: input === undefined ? [key] : [key, input],
    queryFn: () => fn(input),
  }),
})
const mutation = (fn: (input: never) => Promise<unknown>) => ({
  mutationOptions: (options: object = {}) => ({ mutationFn: fn, ...options }),
})
const noop = mutation(async () => ({}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    project: { list: query('project.list', async () => ({ items: [] })) },
    schedule: {
      list: query('schedule.list', calls.list),
      get: query('schedule.get', async () => null),
      costHint: query('schedule.costHint', async () => ({
        averageCredits: 11,
        runsPerWeek: 5,
        creditsPerWeek: 55,
        weeklyLimit: null,
        overHalf: false,
        nextRunAt: null,
      })),
      create: mutation(calls.create),
      update: noop,
      setEnabled: noop,
      runNow: noop,
      delete: noop,
    },
  }),
}))

type Project = Pick<ProjectDetails, 'id' | 'name' | 'archived' | 'repository'>
const kolos: Project = {
  id: PROJECT_ID,
  name: 'Сайт пекарни «Колос»',
  archived: false,
  repository: null,
}
const withRepository = {
  ...kolos,
  repository: {} as NonNullable<ProjectDetails['repository']>,
}

function show(project: Project = kolos) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectSchedulesRow project={project} userId="user-1" />
    </QueryClientProvider>,
  )
}

const ofProject = { id: PROJECT_ID, name: kolos.name, gone: false }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  calls.list.mockResolvedValue({ schedules: [], timezone: 'Europe/Moscow' })
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('«Запланировано» of a project (docs/plan/84-projects.md, ПР19, P-schedule-list)', () => {
  it('lists the tasks of the project, three of them, and tells how many more', async () => {
    calls.list.mockResolvedValue({
      schedules: [1, 2, 3, 4].map((n) =>
        scheduleItem({
          id: `019f2a00-0000-7000-8000-00000000000${n}`,
          name: `Задача ${n}`,
          project: ofProject,
          nextRunAt: new Date(`2026-11-1${5 + n}T06:00:00.000Z`),
        }),
      ),
      timezone: 'Europe/Moscow',
    })
    show()
    expect(await screen.findByText('Задача 1')).toBeTruthy()
    expect(calls.list).toHaveBeenCalledWith({ projectId: PROJECT_ID })
    const row = screen.getByText('Задача 1').closest('li')!
    expect(row).toHaveTextContent('Задача 1 · завтра в 9:00')
    expect(screen.queryByText('Задача 4')).toBeNull()
    expect(screen.getByText('и ещё 1 задача')).toBeTruthy()
  })

  it('opens its window with the lead, the tasks and the way to «Задачи»', async () => {
    calls.list.mockResolvedValue({
      schedules: [scheduleItem({ project: ofProject })],
      timezone: 'Europe/Moscow',
    })
    show()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Посмотреть запланированные задачи проекта' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Запланировано' })
    expect(dialog).toHaveTextContent(
      'Задачи запускаются сами, без вас. Каждый запуск — новый чат в этом проекте.',
    )
    const list = within(dialog).getByRole('list', { name: 'Запланировано' })
    expect(within(list).getByRole('link', { name: 'Проверка сайта' })).toHaveAttribute(
      'href',
      '/scheduled/019f2a00-0000-7000-8000-000000000001',
    )
    // The project is the window's own: its rows do not repeat it.
    expect(list).not.toHaveTextContent('Проект:')
    expect(within(dialog).getByRole('link', { name: '«Задачи»' })).toHaveAttribute(
      'href',
      '/scheduled',
    )
  })

  it('adds a task with the project fixed and sends it with the task (P-schedule)', async () => {
    show()
    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить запланированную задачу в проект' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Новая запланированная задача' })
    expect(dialog).toHaveTextContent(
      'Проект: Сайт пекарни «Колос», задача закреплена за этим проектом',
    )
    // No pill: the project is the window's.
    expect(within(dialog).queryByRole('button', { name: /Без проекта/ })).toBeNull()
    expect(dialog).not.toHaveTextContent('не принимает изменения в основную ветку')
    // A project without a repository: only the template that needs none, before the six.
    const templates = within(dialog).getByRole('group', { name: 'Шаблоны задач проекта' })
    expect(
      within(templates)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['План на неделю'])
    fireEvent.click(within(templates).getByRole('button', { name: 'План на неделю' }))
    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toHaveValue('План на неделю')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    await waitFor(() =>
      expect(calls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'План на неделю',
          projectId: PROJECT_ID,
          templateSlug: 'week-plan',
        }),
        expect.anything(),
      ),
    )
  })

  it('in a project with a repository warns of what a run does not do and offers its templates', async () => {
    show(withRepository)
    fireEvent.click(
      screen.getByRole('button', { name: 'Добавить запланированную задачу в проект' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Новая запланированная задача' })
    expect(dialog).toHaveTextContent(
      'агент не принимает изменения в основную ветку, не выкатывает и не меняет настройки сборки — он подготовит изменения, а запрос на слияние вы откроете сами.',
    )
    const templates = within(dialog).getByRole('group', { name: 'Шаблоны задач проекта' })
    expect(
      within(templates)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Проверка сборок по утрам', 'Сводка запросов на слияние', 'План на неделю'])
    fireEvent.click(within(templates).getByRole('button', { name: 'Проверка сборок по утрам' }))
    expect(within(dialog).getByRole('textbox', { name: 'Что сделать агенту' })).toHaveValue(
      'Проверь последние сборки в репозитории. Если какая-то упала — разберись по журналу, исправь и подготовь изменения — запрос на слияние открою я сам. Пришли короткую сводку.',
    )
  })

  it('takes no new task in a project in «Архив»', async () => {
    show({ ...kolos, archived: true })
    expect(
      await screen.findByText('Задачи, которые агент выполняет сам по расписанию.'),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Добавить запланированную задачу в проект' }),
    ).toBeNull()
  })
})
