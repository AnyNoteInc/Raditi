// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { artifactTemplates } from '@repo/domain/artifacts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactsView } from './artifacts-view'

type Row = {
  id: string
  kind: string
  title: string
  project: { id: string; name: string } | null
  version: number
  blocks: number
  excerpt: string
  createdAt: string
  updatedAt: string
  purgeAfter: string | null
}

const { list, create, trash, restore, push, projects, keep, thumbs } = vi.hoisted(() => ({
  list: vi.fn<(input: { filter: string; query?: string }) => Promise<Row[]>>(),
  create: vi.fn(async (_input: unknown) => ({ id: '019f1a21-1800-7f00-8abc-0000000000aa' })),
  trash: vi.fn(async (_input: unknown) => ({ purgeAfter: '2026-12-20T10:00:00.000Z' })),
  restore: vi.fn(async (_input: unknown) => true),
  push: vi.fn(),
  projects: vi.fn(async () => ({
    items: [{ id: '019f1a21-1800-7f00-8abc-0000000000bb', name: 'Пекарня', archived: false }],
  })),
  keep: vi.fn(),
  thumbs: vi.fn(async (_input: { artifactId: string }) => ({
    thumbs: [{ frame: 'home', width: 1280, url: '/api/artifact-thumbs/a/home-1280.jpg' }],
    pending: false,
  })),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/components/chat/chat-draft', () => ({ keepChatDraft: keep }))

const mutation = (fn: (input: unknown) => Promise<unknown>) => ({
  mutationOptions: (options: { onSuccess?: () => void } = {}) => ({
    mutationFn: fn,
    ...options,
  }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: {
      list: {
        pathKey: () => ['artifact', 'list'],
        queryOptions: (input: { filter: string; query?: string }) => ({
          queryKey: ['artifact', 'list', input],
          queryFn: () => list(input),
        }),
      },
      canvasThumbs: {
        queryOptions: (input: { artifactId: string }) => ({
          queryKey: ['artifact', 'canvasThumbs', input],
          queryFn: () => thumbs(input),
        }),
      },
      create: mutation(create),
      trash: mutation(trash),
      restore: mutation(restore),
      // Invitations (plan 88, 88.16-2): none here.
      myInvites: {
        queryKey: () => ['artifact', 'myInvites'],
        queryOptions: () => ({ queryKey: ['artifact', 'myInvites'], queryFn: async () => [] }),
      },
      inviteAccept: mutation(vi.fn()),
      inviteDecline: mutation(vi.fn()),
    },
    project: {
      list: { queryOptions: () => ({ queryKey: ['project', 'list'], queryFn: projects }) },
    },
  }),
}))

const row = (overrides: Partial<Row> = {}): Row => ({
  id: '019f1a21-1800-7f00-8abc-000000000001',
  kind: 'document',
  title: 'Тексты для сайта',
  project: null,
  version: 2,
  blocks: 3,
  excerpt: 'Новогодние пироги с доставкой',
  createdAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-19T10:00:00.000Z',
  purgeAfter: null,
  ...overrides,
})

function show(props: { sharing?: boolean; initialProjectId?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ArtifactsView userId="user-1" {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  list.mockResolvedValue([])
})

describe('«Артефакты» (plan 88, Ар50; plan 93, АТ9)', () => {
  it('shows the empty screen with one template of each kind, and a template opens at once', async () => {
    show()
    expect(await screen.findByText('Здесь будут ваши артефакты')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Показать' })).toBeNull()
    // The first template of each of the four kinds, no more.
    for (const kind of ['document', 'canvas', 'slides', 'image'] as const) {
      const first = artifactTemplates.find((each) => each.kind === kind)!
      expect(screen.getByRole('button', { name: new RegExp(first.title) })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: /Правила возврата/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Коммерческое предложение/ }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        {
          kind: 'document',
          title: 'Коммерческое предложение',
          projectId: null,
          templateId: 'offer',
        },
        expect.anything(),
      ),
    )
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/artifacts/019f1a21-1800-7f00-8abc-0000000000aa'),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists cards with when and where, a picture for a canvas, and searches by a word', async () => {
    list.mockImplementation(async (input) =>
      input.filter === 'trash'
        ? []
        : [
            row(),
            row({
              id: '019f1a21-1800-7f00-8abc-000000000002',
              kind: 'canvas',
              title: 'Сайт пекарни',
              excerpt: '.hero{color:red} <section class="hero">',
              project: { id: '019f1a21-1800-7f00-8abc-0000000000bb', name: 'Пекарня' },
            }),
          ],
    )
    show()
    const link = await screen.findByRole('link', { name: 'Открыть «Тексты для сайта»' })
    expect(link).toHaveAttribute('href', '/artifacts/019f1a21-1800-7f00-8abc-000000000001')
    // The icon says the kind: the line has none, a personal one names no project.
    expect(screen.getByText(/^изменено [^·]+$/)).toBeTruthy()
    expect(screen.getByText(/^изменено .+ · Пекарня$/)).toBeTruthy()
    expect(screen.queryByText(/Документ ·|Без проекта/)).toBeNull()
    // A document shows its text, a canvas its first screen, never its source.
    expect(screen.getByText('Новогодние пироги с доставкой')).toBeTruthy()
    await waitFor(() =>
      expect(thumbs).toHaveBeenCalledWith({ artifactId: '019f1a21-1800-7f00-8abc-000000000002' }),
    )
    const canvas = screen.getByRole('link', { name: 'Открыть «Сайт пекарни»' }).closest('li')!
    await waitFor(() =>
      expect(canvas.querySelector('img')).toHaveAttribute(
        'src',
        '/api/artifact-thumbs/a/home-1280.jpg',
      ),
    )
    expect(screen.queryByText(/\.hero/)).toBeNull()
    // One row of controls: no order, no cards or list, no project select.
    expect(screen.queryByRole('combobox', { name: 'Порядок' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Список' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Проект' })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск по артефактам' }), {
      target: { value: 'пирог' },
    })
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ filter: 'all', query: 'пирог', sort: 'newest' }),
      ),
    )
  })

  it('shows «Доступные мне» only where sharing is open', async () => {
    list.mockResolvedValue([row()])
    show()
    const tabs = await screen.findByRole('group', { name: 'Показать' })
    expect(
      within(tabs)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Все', 'Мои', 'Корзина'])
  })

  it('offers «Доступные мне» with sharing, and filters by a kind', async () => {
    list.mockResolvedValue([row()])
    show({ sharing: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Доступные мне' }))
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ filter: 'shared' })),
    )
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Вид' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Презентация' }))
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ filter: 'shared', kind: 'slides' }),
      ),
    )
  })

  it('opens filtered by the project of «Все артефакты проекта», and the chip takes it off', async () => {
    list.mockResolvedValue([row()])
    show({ initialProjectId: '019f1a21-1800-7f00-8abc-0000000000bb' })
    expect(await screen.findByText('Проект «Пекарня»')).toBeTruthy()
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: '019f1a21-1800-7f00-8abc-0000000000bb' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Проект «Пекарня»' }))
    await waitFor(() => expect(screen.queryByText('Проект «Пекарня»')).toBeNull())
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: null })),
    )
  })

  it('puts an artifact in the trash with «Вернуть», and the trash returns it', async () => {
    list.mockImplementation(async (input) =>
      input.filter === 'trash' ? [row({ purgeAfter: '2026-12-20T10:00:00.000Z' })] : [row()],
    )
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Действия с «Тексты для сайта»' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'В корзину' }))
    await waitFor(() =>
      expect(trash).toHaveBeenCalledWith(
        { artifactId: '019f1a21-1800-7f00-8abc-000000000001' },
        expect.anything(),
      ),
    )
    expect(await screen.findByText(/в корзине: он удалится через 30 дней/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Корзина' }))
    const back = await screen.findByRole('button', { name: 'Вернуть' })
    expect(screen.getByText(/Удалится 20 декабря/)).toBeTruthy()
    fireEvent.click(back)
    await waitFor(() => expect(restore).toHaveBeenCalled())
  })

  it('offers the four kinds and one request, and the agent starts in a new chat', async () => {
    list.mockResolvedValue([row()])
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Создать' }))
    const dialog = await screen.findByRole('dialog', { name: 'Новый артефакт' })
    // The four kinds of the registry, every one can be made (docs/plan/93-artifacts-trim.md, АТ1).
    expect(within(dialog).getAllByRole('radio')).toHaveLength(4)
    expect(within(dialog).getByRole('radio', { name: /Документ/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    // No name and no templates while the agent makes it.
    expect(within(dialog).queryByRole('textbox', { name: 'Название' })).toBeNull()
    expect(within(dialog).queryByText('Шаблон')).toBeNull()
    fireEvent.click(within(dialog).getByRole('radio', { name: /Презентация/ }))
    const ask = within(dialog).getByRole('button', { name: 'Попросить агента' })
    expect(ask).toBeDisabled()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Что сделать?' }), {
      target: { value: 'Расскажите о пекарне на пяти слайдах' },
    })
    fireEvent.click(ask)
    await waitFor(() =>
      expect(keep).toHaveBeenCalledWith(
        'user-1',
        'Презентация: Расскажите о пекарне на пяти слайдах',
      ),
    )
    expect(push).toHaveBeenCalledWith('/chats/new')
    expect(create).not.toHaveBeenCalled()
  })

  it('makes an empty one by its name, kept in a project the user chose', async () => {
    list.mockResolvedValue([row()])
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Создать' }))
    const dialog = await screen.findByRole('dialog', { name: 'Новый артефакт' })
    fireEvent.click(within(dialog).getByRole('radio', { name: /Холст/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать пустой' }))
    const name = within(dialog).getByRole('textbox', { name: 'Название' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    expect(await within(dialog).findByText('Назовите артефакт')).toBeTruthy()
    expect(create).not.toHaveBeenCalled()
    fireEvent.change(name, { target: { value: 'Прототип заказа' } })
    // «Где хранить» stands because the user has a project.
    fireEvent.mouseDown(await within(dialog).findByRole('combobox', { name: 'Где хранить' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Пекарня' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        {
          kind: 'canvas',
          title: 'Прототип заказа',
          projectId: '019f1a21-1800-7f00-8abc-0000000000bb',
          templateId: null,
        },
        expect.anything(),
      ),
    )
  })

  it('hides «Где хранить» from a user without projects', async () => {
    projects.mockResolvedValue({ items: [] })
    list.mockResolvedValue([row()])
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Создать' }))
    const dialog = await screen.findByRole('dialog', { name: 'Новый артефакт' })
    await waitFor(() => expect(projects).toHaveBeenCalled())
    expect(within(dialog).queryByRole('combobox', { name: 'Где хранить' })).toBeNull()
  })
})
