// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectView } from './project-view'
import type { ProjectDetails } from './project-types'

const PROJECT_ID = '0199a3f2-0000-7000-8000-00000000c001'

const calls = vi.hoisted(() => ({
  get: vi.fn<(input: { projectId: string }) => Promise<unknown>>(),
  chats: vi.fn<(input: unknown) => Promise<unknown>>(),
  create: vi.fn(async (input: { taskId: string }) => ({ taskId: input.taskId, created: true })),
  setInstructions: vi.fn(async (input: { text: string }) => ({ text: input.text })),
  archive: vi.fn(async (input: { archived: boolean }) => ({ archived: input.archived })),
  push: vi.fn<(href: string) => void>(),
  schedules: vi.fn<(input: unknown) => Promise<unknown>>(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: calls.push, replace: vi.fn() }),
  usePathname: () => `/projects/${PROJECT_ID}`,
  useSelectedLayoutSegment: () => null,
}))
vi.mock('@repo/ui/providers', () => ({
  useThemePreference: () => ({ preference: 'system', setPreference: vi.fn() }),
}))

const mutation = (fn: (input: never) => Promise<unknown>) => ({
  mutationOptions: () => ({ mutationFn: fn }),
})
const noop = { mutationOptions: () => ({ mutationFn: vi.fn() }) }

vi.mock('@/trpc/client', async () => {
  const { repoTrpc } = await import('./testing/repo-trpc')
  return {
    useTRPC: () => ({
      ...repoTrpc(),
      project: {
        pathKey: () => ['project'],
        get: {
          queryOptions: (input: { projectId: string }) => ({
            queryKey: ['project.get', input],
            queryFn: () => calls.get(input),
          }),
        },
        list: {
          queryOptions: () => ({
            queryKey: ['project.list'],
            queryFn: async () => ({ items: [] }),
          }),
        },
        setInstructions: mutation(calls.setInstructions),
        archive: mutation(calls.archive),
        star: noop,
        remove: noop,
        restore: noop,
        update: noop,
      },
      schedule: {
        list: {
          queryKey: (input?: unknown) => ['schedule.list', input],
          queryOptions: (input?: unknown) => ({
            queryKey: ['schedule.list', input],
            queryFn: () => calls.schedules(input),
          }),
        },
        get: { queryKey: (input?: unknown) => ['schedule.get', input] },
        setEnabled: noop,
        runNow: noop,
        delete: noop,
        create: noop,
        update: noop,
        costHint: {
          queryOptions: (input?: unknown) => ({
            queryKey: ['schedule.costHint', input],
            queryFn: async () => ({
              averageCredits: 11,
              runsPerWeek: 5,
              creditsPerWeek: 55,
              weeklyLimit: null,
              overHalf: false,
              nextRunAt: null,
            }),
          }),
        },
      },
      task: {
        create: mutation(calls.create),
        rename: noop,
        remove: noop,
        pin: noop,
        archive: noop,
        moveToProject: noop,
      },
      projectFile: {
        pathKey: () => ['projectFile'],
        list: {
          queryOptions: (input: { projectId: string }) => ({
            queryKey: ['projectFile.list', input],
            queryFn: async () => ({
              files: [],
              bytes: 0,
              limitBytes: 100 * 1024 * 1024,
              percent: 0,
            }),
          }),
        },
        remove: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      },
      billing: {
        usage: {
          queryKey: () => ['billing', 'usage'],
          queryOptions: () => ({ queryKey: ['billing', 'usage'], queryFn: async () => null }),
        },
      },
    }),
    useTRPCClient: () => ({
      task: { list: { query: calls.chats } },
      attachment: { start: { mutate: vi.fn() }, remove: { mutate: vi.fn() } },
      projectFile: {
        start: { mutate: vi.fn() },
        bind: { mutate: vi.fn() },
        addText: { mutate: vi.fn() },
        remove: { mutate: vi.fn(async () => ({})) },
      },
    }),
  }
})

const NOW = new Date()
const kolos: ProjectDetails = {
  id: PROJECT_ID,
  name: 'Сайт пекарни «Колос»',
  goal: 'Обновить сайт к зиме',
  instructions: null,
  useAccountMemory: true,
  starred: false,
  archived: false,
  chats: 0,
  activityAt: NOW,
  createdAt: NOW,
  files: { count: 0, bytes: 0, limitBytes: 100 * 1024 * 1024, first: [] },
  memory: { active: 0, proposed: 0 },
  repository: null,
}

function show(project: ProjectDetails = kolos) {
  calls.get.mockResolvedValue(project)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectView initial={project} userId="user-1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.chats.mockResolvedValue({ pinned: [], items: [], nextCursor: null })
  calls.schedules.mockResolvedValue({ schedules: [], timezone: 'Europe/Moscow' })
})
afterEach(cleanup)

describe('the page of a project (docs/plan/84-projects.md, ПР6)', () => {
  it('heads with the way back, the name and the goal; a new project waits for its chats', async () => {
    show()
    expect(screen.getByRole('link', { name: 'Все проекты' }).getAttribute('href')).toBe('/projects')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Сайт пекарни «Колос»')
    expect(screen.getByText('Обновить сайт к зиме')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Сообщение' }).getAttribute('placeholder')).toBe(
      'Новый чат в проекте «Сайт пекарни «Колос»»',
    )
    expect(await screen.findByText('Здесь появятся чаты этого проекта.')).toBeTruthy()
    expect(calls.chats).toHaveBeenCalledWith({ projectId: PROJECT_ID })
    // The column holds only what exists in this slice.
    const column = screen.getByRole('complementary', { name: 'Проекты' })
    expect(within(column).getByText('Инструкции')).toBeTruthy()
    expect(within(column).getByRole('heading', { name: 'Контекст' })).toBeTruthy()
    expect(
      within(column).getByText('Файлы и тексты, которые агент читает в каждом чате проекта'),
    ).toBeTruthy()
    expect(within(column).getByRole('heading', { name: 'Память' })).toBeTruthy()
    expect(within(column).getByText('Пока пусто. Скажите агенту «запомни…»')).toBeTruthy()
    expect(within(column).getByRole('heading', { name: 'Запланировано' })).toBeTruthy()
    expect(
      await within(column).findByText('Задачи, которые агент выполняет сам по расписанию.'),
    ).toBeTruthy()
    expect(calls.schedules).toHaveBeenCalledWith({ projectId: PROJECT_ID })
    expect(column.textContent).toContain('Приватный · Видите только вы')
  })

  it('starts a chat in the project from its field', async () => {
    show()
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), {
      target: { value: 'Сверь цены с прайсом' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(calls.push).toHaveBeenCalledTimes(1))
    expect(calls.create.mock.calls[0]![0]).toMatchObject({
      text: 'Сверь цены с прайсом',
      projectId: PROJECT_ID,
    })
  })

  it('lists the chats of the project without the name of the project', async () => {
    calls.chats.mockResolvedValue({
      pinned: [],
      items: [
        {
          id: '0199a3f2-0000-7000-8000-000000000001',
          title: 'Новое меню на зиму',
          status: 'done',
          answered: false,
          rewound: false,
          failed: false,
          createdAt: NOW,
          updatedAt: NOW,
          pinned: false,
          project: { id: PROJECT_ID, name: kolos.name },
          archived: false,
          telegram: false,
          schedule: null,
          // Its branch was sent and its merge request opened (§4.8, ревью P9).
          repo: { state: 'pushed', sent: true, request: { state: 'open' } },
        },
      ],
      nextCursor: null,
    })
    show({ ...kolos, chats: 1 })
    const list = await screen.findByRole('list', { name: /Чаты проекта/ })
    expect(within(list).getByRole('link').textContent).toContain('Новое меню на зиму')
    expect(within(list).queryByText(kolos.name)).toBeNull()
    expect(within(list).getByText('запрос на слияние открыт')).toBeTruthy()
  })

  it('adds the instructions in a window that counts the characters', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Добавить: Инструкции' }))
    const window_ = await screen.findByRole('dialog', { name: 'Инструкции проекта' })
    fireEvent.change(within(window_).getByRole('textbox', { name: 'Инструкции проекта' }), {
      target: { value: 'Пишем на «вы».' },
    })
    expect(within(window_).getByText(/^14 из 8\s000$/)).toBeTruthy()
    fireEvent.click(within(window_).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(calls.setInstructions).toHaveBeenCalledWith(
        { projectId: PROJECT_ID, text: 'Пишем на «вы».' },
        expect.anything(),
      ),
    )
  })

  it('closes the field of a project in the archive and offers to bring it back', async () => {
    show({ ...kolos, archived: true })
    // Said once in sight, and read aloud with the closed field.
    expect(screen.getByRole('alert').textContent).toContain('Проект в архиве')
    expect(screen.getByRole('textbox', { name: 'Сообщение' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть из архива' }))
    await waitFor(() =>
      expect(calls.archive).toHaveBeenCalledWith(
        { projectId: PROJECT_ID, archived: false },
        expect.anything(),
      ),
    )
  })
})
