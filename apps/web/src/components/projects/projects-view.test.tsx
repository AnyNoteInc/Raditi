// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectsView } from './projects-view'
import type { ProjectListItem } from './project-types'

const calls = vi.hoisted(() => ({
  list: vi.fn<(input: { view: string; sort: string }) => Promise<{ items: unknown[] }>>(),
  create: vi.fn(async (input: { projectId: string }) => ({
    projectId: input.projectId,
    created: true,
  })),
  star: vi.fn(async (input: { starred: boolean }) => ({ starred: input.starred })),
  archive: vi.fn(async (input: { archived: boolean }) => ({ archived: input.archived })),
  remove: vi.fn(async () => ({ purgeAfter: new Date() })),
  restore: vi.fn(async () => ({ restored: true as const })),
  update: vi.fn(async () => ({ updated: true as const })),
  push: vi.fn<(href: string) => void>(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: calls.push }) }))

const mutation = (fn: (input: never) => Promise<unknown>) => ({
  mutationOptions: () => ({ mutationFn: fn }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    project: {
      pathKey: () => ['project'],
      list: {
        queryOptions: (input: { view: string; sort: string }) => ({
          queryKey: ['project.list', input],
          queryFn: () => calls.list(input),
        }),
      },
      create: mutation(calls.create),
      star: mutation(calls.star),
      archive: mutation(calls.archive),
      remove: mutation(calls.remove),
      restore: mutation(calls.restore),
      update: mutation(calls.update),
    },
  }),
}))

const NOW = new Date()
let serial = 0
function project(name: string, patch: Partial<ProjectListItem> = {}): ProjectListItem {
  serial += 1
  return {
    id: `0199a3f2-0000-7000-8000-${String(serial).padStart(12, '0')}`,
    name,
    goal: null,
    starred: false,
    archived: false,
    chats: 0,
    hasInstructions: false,
    activityAt: new Date(NOW.getTime() - 12 * 60_000),
    createdAt: NOW,
    purgeAfter: null,
    ...patch,
  }
}

function lists(views: Partial<Record<'all' | 'archive' | 'trash', ProjectListItem[]>>) {
  calls.list.mockImplementation(async ({ view }) => ({
    items: views[view as 'all' | 'archive' | 'trash'] ?? [],
  }))
}

function show() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectsView />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  serial = 0
})
afterEach(cleanup)

describe('«Проекты» (docs/plan/84-projects.md, ПР4)', () => {
  it('before the first project: the question, «Новый проект» and three examples, no tabs', async () => {
    lists({})
    show()
    expect(await screen.findByRole('heading', { name: 'Хотите создать проект?' })).toBeTruthy()
    // P-empty: «Новый проект» of the head is hidden, the one of the screen stays.
    expect(screen.getAllByRole('button', { name: 'Новый проект' })).toHaveLength(1)
    expect(screen.queryByRole('group', { name: 'Показать проекты' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Отчёты и таблицы' }))
    const window_ = await screen.findByRole('dialog', { name: 'Создание проекта' })
    expect(
      within(window_).getByRole<HTMLInputElement>('textbox', { name: /Над чем вы работаете/ })
        .value,
    ).toBe('Отчёты и таблицы')
  })

  it('creates a project under an id of the browser and opens its page', async () => {
    lists({})
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Новый проект' }))
    const window_ = await screen.findByRole('dialog', { name: 'Создание проекта' })
    fireEvent.click(within(window_).getByRole('button', { name: 'Создать проект' }))
    // The name is the one thing a project needs.
    expect(await within(window_).findByText('Назовите проект')).toBeTruthy()
    expect(calls.create).not.toHaveBeenCalled()
    fireEvent.change(within(window_).getByRole('textbox', { name: /Над чем вы работаете/ }), {
      target: { value: '  Сайт   пекарни ' },
    })
    fireEvent.change(within(window_).getByRole('textbox', { name: /Чего вы хотите достичь/ }), {
      target: { value: 'Новое меню' },
    })
    fireEvent.click(within(window_).getByRole('button', { name: 'Создать проект' }))
    await waitFor(() => expect(calls.push).toHaveBeenCalledTimes(1))
    const [input] = calls.create.mock.calls[0]! as unknown as [
      { projectId: string; name: string; goal: string },
    ]
    expect(input).toEqual({
      projectId: expect.stringMatching(/^[0-9a-f-]{14}7/),
      name: 'Сайт пекарни',
      goal: 'Новое меню',
    })
    expect(calls.push).toHaveBeenCalledWith(`/projects/${input.projectId}`)
  })

  it('shows the cards with their chats and time, the tabs with counts, and «Корзина» under them', async () => {
    lists({
      all: [
        project('Сайт пекарни «Колос»', { goal: 'Обновить сайт к зиме', chats: 12, starred: true }),
        project('Рассылка для клиентов', { chats: 4 }),
      ],
      archive: [project('Старый проект', { archived: true })],
      trash: [project('Удалённый', { purgeAfter: new Date('2026-12-15T09:00:00Z') })],
    })
    show()
    const list = await screen.findByRole('list', { name: 'Все' })
    const cards = within(list).getAllByRole('article')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.textContent).toContain('Обновить сайт к зиме')
    expect(cards[0]!.textContent).toContain('12 чатов · обновлён 12 мин назад')
    expect(within(cards[0]!).getByRole('link', { name: 'Сайт пекарни «Колос»' })).toBeTruthy()
    const tabs = screen.getByRole('group', { name: 'Показать проекты' })
    expect(within(tabs).getByRole('button', { name: /Все/ }).textContent).toBe('Все2')
    expect(within(tabs).getByRole('button', { name: /Избранное/ }).textContent).toBe('Избранное1')
    expect(within(tabs).getByRole('button', { name: /Архив/ }).textContent).toBe('Архив1')

    fireEvent.click(within(tabs).getByRole('button', { name: /Избранное/ }))
    expect(
      within(screen.getByRole('list', { name: 'Избранное' })).getAllByRole('article'),
    ).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: /Корзина/ }))
    const trash = await screen.findByRole('list', { name: 'Корзина' })
    expect(within(trash).getByRole('article').textContent).toContain('Удалится навсегда')
    // No link into a project of the trash, and «Вернуть» brings it back.
    expect(within(trash).queryByRole('link')).toBeNull()
    fireEvent.click(within(trash).getByRole('button', { name: 'Вернуть: Удалённый' }))
    await waitFor(() => expect(calls.restore).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Проект «Удалённый» возвращён.')).toBeTruthy()
  })

  it('finds a project by its name or goal from 7 projects on, and not before', async () => {
    const six = Array.from({ length: 6 }, (_, index) => project(`Проект ${index + 1}`))
    lists({ all: six })
    show()
    await screen.findByRole('list', { name: 'Все' })
    expect(screen.queryByRole('textbox', { name: 'Поиск по проектам' })).toBeNull()
    cleanup()
    lists({ all: [...six, project('Отчёты', { goal: 'Сводка для бухгалтерии' })] })
    show()
    const search = await screen.findByRole('textbox', { name: 'Поиск по проектам' })
    fireEvent.change(search, { target: { value: 'бухгалтер' } })
    expect(within(screen.getByRole('list', { name: 'Все' })).getAllByRole('article')).toHaveLength(
      1,
    )
    fireEvent.change(search, { target: { value: 'нет такого' } })
    expect(screen.getByText('Ничего не нашлось.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить поиск' }))
    expect(within(screen.getByRole('list', { name: 'Все' })).getAllByRole('article')).toHaveLength(
      7,
    )
  })

  it('asks the server in the order chosen', async () => {
    lists({ all: [project('А')] })
    show()
    await screen.findByRole('list', { name: 'Все' })
    fireEvent.click(screen.getByRole('button', { name: /Порядок проектов/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'По названию' }))
    await waitFor(() => expect(calls.list).toHaveBeenCalledWith({ view: 'all', sort: 'name' }))
  })

  it('stars, archives and deletes a project from its card, after a question for the last', async () => {
    const kolos = project('Колос')
    lists({ all: [kolos] })
    show()
    const card = (await screen.findAllByRole('article'))[0]!
    fireEvent.click(within(card).getByRole('button', { name: 'Проект «Колос» в избранное' }))
    await waitFor(() =>
      expect(calls.star).toHaveBeenCalledWith(
        { projectId: kolos.id, starred: true },
        expect.anything(),
      ),
    )
    fireEvent.click(within(card).getByRole('button', { name: 'Действия с проектом «Колос»' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'В архив' }))
    await waitFor(() =>
      expect(calls.archive).toHaveBeenCalledWith(
        { projectId: kolos.id, archived: true },
        expect.anything(),
      ),
    )
    fireEvent.click(within(card).getByRole('button', { name: 'Действия с проектом «Колос»' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Удалить/ }))
    const question = await screen.findByRole('dialog', { name: 'Удалить проект «Колос»?' })
    expect(question.textContent).toContain('30 дней')
    fireEvent.click(within(question).getByRole('button', { name: 'В корзину' }))
    await waitFor(() => expect(calls.remove).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Проект «Колос» в корзине.')).toBeTruthy()
  })

  it('renames a project in a small window', async () => {
    const kolos = project('Колос')
    lists({ all: [kolos] })
    show()
    const card = (await screen.findAllByRole('article'))[0]!
    fireEvent.click(within(card).getByRole('button', { name: 'Действия с проектом «Колос»' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Переименовать' }))
    const window_ = await screen.findByRole('dialog', { name: 'Переименовать проект' })
    fireEvent.change(within(window_).getByRole('textbox', { name: 'Название проекта' }), {
      target: { value: 'Пекарня' },
    })
    fireEvent.click(within(window_).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(calls.update).toHaveBeenCalledWith(
        { projectId: kolos.id, name: 'Пекарня' },
        expect.anything(),
      ),
    )
  })
})
