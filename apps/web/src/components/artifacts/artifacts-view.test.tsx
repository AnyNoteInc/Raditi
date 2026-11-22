// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const { list, create, trash, restore, push, projects, keep } = vi.hoisted(() => ({
  list: vi.fn<(input: { filter: string; query?: string }) => Promise<Row[]>>(),
  create: vi.fn(async (_input: unknown) => ({ id: '019f1a21-1800-7f00-8abc-0000000000aa' })),
  trash: vi.fn(async (_input: unknown) => ({ purgeAfter: '2026-12-20T10:00:00.000Z' })),
  restore: vi.fn(async (_input: unknown) => true),
  push: vi.fn(),
  projects: vi.fn(async () => ({
    items: [{ id: '019f1a21-1800-7f00-8abc-0000000000bb', name: 'Пекарня', archived: false }],
  })),
  keep: vi.fn(),
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

function show() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ArtifactsView userId="user-1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  list.mockResolvedValue([])
})

describe('«Артефакты» (plan 88, Ар50)', () => {
  it('shows the empty screen with the templates of a document before the first artifact', async () => {
    show()
    expect(await screen.findByText('Здесь будут ваши артефакты')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Показать' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Правила возврата/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Новый артефакт' })
    expect(within(dialog).getByRole('textbox', { name: 'Название' })).toHaveValue(
      'Правила возврата',
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'document',
          title: 'Правила возврата',
          projectId: null,
          templateId: 'returns',
        }),
        expect.anything(),
      ),
    )
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/artifacts/019f1a21-1800-7f00-8abc-0000000000aa'),
    )
  })

  it('lists the artifacts with their kind and place, and searches by a word', async () => {
    list.mockImplementation(async (input) =>
      input.filter === 'trash'
        ? []
        : [
            row(),
            row({
              id: '019f1a21-1800-7f00-8abc-000000000002',
              title: 'План продвижения',
              project: { id: '019f1a21-1800-7f00-8abc-0000000000bb', name: 'Пекарня' },
            }),
          ],
    )
    show()
    const link = await screen.findByRole('link', { name: 'Открыть «Тексты для сайта»' })
    expect(link).toHaveAttribute('href', '/artifacts/019f1a21-1800-7f00-8abc-000000000001')
    expect(screen.getByText(/Документ · Пекарня/)).toBeTruthy()
    expect(screen.getAllByText(/Без проекта/).length).toBeGreaterThan(0)
    fireEvent.change(screen.getByRole('textbox', { name: 'Поиск по артефактам' }), {
      target: { value: 'пирог' },
    })
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ filter: 'all', query: 'пирог' })),
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

  it('marks the kinds that have not shipped «Скоро», and the agent starts in a new chat', async () => {
    list.mockResolvedValue([row()])
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Создать' }))
    const dialog = await screen.findByRole('dialog', { name: 'Новый артефакт' })
    expect(within(dialog).getByRole('radio', { name: /Изображение/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    // «Схема» shipped with 88.24в.
    expect(within(dialog).getByRole('radio', { name: /Схема/ })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(within(dialog).getByRole('radio', { name: /Документ/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Попросить агента' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Что сделать?' }), {
      target: { value: 'Напишите правила возврата' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    await waitFor(() => expect(keep).toHaveBeenCalledWith('user-1', 'Напишите правила возврата'))
    expect(push).toHaveBeenCalledWith('/chats/new')
    expect(create).not.toHaveBeenCalled()
  })
})
