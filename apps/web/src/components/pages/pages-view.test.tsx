// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FeedPage } from '../chat/feed-page'
import { PagesView } from './pages-view'

type Listed = {
  pageId: string
  workspaceId: string
  title: string
  url: string
  kind: 'html' | 'markdown' | 'doc'
  state: 'pending' | 'live' | 'taken_down'
  version: number
  hasPassword: boolean
  takenDownBy: 'client' | 'operator' | null
  chat: { id: string; title: string | null } | null
  canManage: boolean
  updatedAt: string
}

const { listPages, setPassword, takeDown, restore } = vi.hoisted(() => ({
  listPages: vi.fn<() => Promise<{ enabled: boolean; pages: Listed[] }>>(),
  setPassword: vi.fn(async (_input: unknown) => undefined),
  takeDown: vi.fn(async (_input: unknown) => undefined),
  restore: vi.fn(async (_input: unknown) => undefined),
}))

const mutation = (fn: (input: unknown) => Promise<unknown>) => ({
  mutationOptions: (options: object = {}) => ({ mutationFn: fn, ...options }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    pages: {
      list: {
        queryKey: () => ['pages', 'list'],
        queryOptions: () => ({ queryKey: ['pages', 'list'], queryFn: listPages }),
      },
      setPassword: mutation(setPassword),
      takeDown: mutation(takeDown),
      restore: mutation(restore),
    },
  }),
}))

const page = (overrides: Partial<Listed> = {}): Listed => ({
  pageId: '019f1a21-1800-7f00-8abc-000000000001',
  workspaceId: '019f1a21-1800-7f00-8abc-0000000000ff',
  title: 'Прайс на ноябрь',
  url: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/',
  kind: 'html',
  state: 'live',
  version: 3,
  hasPassword: false,
  takenDownBy: null,
  chat: { id: '019f1a21-1800-7f00-8abc-0000000000aa', title: 'Цены на сайте' },
  canManage: true,
  updatedAt: '2026-11-13T10:00:00.000Z',
  ...overrides,
})

function show(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  listPages.mockResolvedValue({ enabled: true, pages: [] })
})

describe('«Страницы» (plan 69, Ст30)', () => {
  it('lists the pages with their address, chat, version and state', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page(),
        page({
          pageId: '019f1a21-1800-7f00-8abc-000000000002',
          title: 'Аудит',
          kind: 'doc',
          state: 'pending',
          version: 0,
        }),
      ],
    })
    show(<PagesView />)
    const row = (await screen.findByText('Прайс на ноябрь')).closest('li')!
    expect(
      within(row).getByText('https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/'),
    ).toBeTruthy()
    expect(within(row).getByRole('link', { name: 'Цены на сайте' }).getAttribute('href')).toBe(
      '/chats/019f1a21-1800-7f00-8abc-0000000000aa',
    )
    expect(within(row).getByText('v3')).toBeTruthy()
    expect(
      within(row)
        .getByRole('link', { name: 'Открыть страницу «Прайс на ноябрь»' })
        .getAttribute('target'),
    ).toBe('_blank')
    const draft = screen.getByText('Аудит').closest('li')!
    expect(within(draft).queryByRole('link', { name: /Открыть страницу/ })).toBeNull()
  })

  it('filters by tags over the list and by the title', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page(),
        page({
          pageId: '019f1a21-1800-7f00-8abc-000000000003',
          title: 'Старое меню',
          state: 'taken_down',
          takenDownBy: 'client',
        }),
      ],
    })
    show(<PagesView />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.click(screen.getByRole('button', { name: /Сняты/ }))
    expect(screen.getByRole('button', { name: /Сняты/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText('Прайс на ноябрь')).toBeNull()
    expect(screen.getByText('Старое меню')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Все/ }))
    fireEvent.change(screen.getByLabelText('Найти по названию'), { target: { value: 'прайс' } })
    expect(screen.queryByText('Старое меню')).toBeNull()
  })

  it('takes a page down from its menu, and puts back one the client took down', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [page()] })
    show(<PagesView />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.click(screen.getByRole('button', { name: 'Действия со страницей «Прайс на ноябрь»' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Снять с публикации' }))
    await waitFor(() => expect(takeDown).toHaveBeenCalled())
    expect(takeDown.mock.calls[0]?.[0]).toEqual({ pageId: page().pageId })
  })

  it('sets a password in its dialog, and offers no management to a member', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [page()] })
    show(<PagesView />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.click(screen.getByRole('button', { name: 'Действия со страницей «Прайс на ноябрь»' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Поставить пароль…' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Пароль'), { target: { value: 'секрет-1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(setPassword).toHaveBeenCalled())
    expect(setPassword.mock.calls[0]?.[0]).toEqual({ pageId: page().pageId, password: 'секрет-1' })
  })

  it('shows a member the link only, and a page the support took down as such', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page({ canManage: false }),
        page({
          pageId: '019f1a21-1800-7f00-8abc-000000000004',
          title: 'Жалоба',
          state: 'taken_down',
          takenDownBy: 'operator',
        }),
      ],
    })
    show(<PagesView />)
    await screen.findByText('Прайс на ноябрь')
    expect(screen.getByText('Снята поддержкой')).toBeTruthy()
    const [menu] = screen.getAllByRole('button', { name: /Действия со страницей/ })
    fireEvent.click(menu!)
    expect(await screen.findByRole('menuitem', { name: 'Скопировать ссылку' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Снять с публикации' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Поставить пароль…' })).toBeNull()
  })

  it('offers no empty menu: none for a draft, none for a member on a page taken down', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [
        page({ state: 'pending', version: 0 }),
        page({
          pageId: '019f1a21-1800-7f00-8abc-000000000005',
          title: 'Снятая',
          state: 'taken_down',
          takenDownBy: 'client',
          canManage: false,
        }),
      ],
    })
    show(<PagesView />)
    await screen.findByText('Снятая')
    expect(screen.queryByRole('button', { name: /Действия со страницей/ })).toBeNull()
  })

  it('says when taking a page down did not work', async () => {
    takeDown.mockRejectedValueOnce(new Error('down'))
    listPages.mockResolvedValue({ enabled: true, pages: [page()] })
    show(<PagesView />)
    await screen.findByText('Прайс на ноябрь')
    fireEvent.click(screen.getByRole('button', { name: 'Действия со страницей «Прайс на ноябрь»' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Снять с публикации' }))
    expect(await screen.findByText('Не получилось. Попробуйте ещё раз.')).toBeTruthy()
  })

  it('says when there are no pages, and when the pages are not set up', async () => {
    show(<PagesView />)
    expect(await screen.findByText(/Страниц пока нет/)).toBeTruthy()
  })
})

describe('the card of a page in the chat (plan 69, Ст23)', () => {
  it('names its address and version, and opens it in a new tab', async () => {
    listPages.mockResolvedValue({ enabled: true, pages: [page({ hasPassword: true })] })
    show(<FeedPage pageId={page().pageId} title="Прайс на ноябрь" version={2} kind="html" />)
    expect(
      await screen.findByText('https://aaaaaaaaaaaaaaaaaaaaaaaaaa.pages.raditi.ru/'),
    ).toBeTruthy()
    expect(screen.getByText(/v2 · опубликована · с паролем/)).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'Открыть страницу «Прайс на ноябрь»' }).getAttribute('href'),
    ).toBe(page().url)
    expect(screen.getByRole('button', { name: 'Скопировать ссылку' })).toBeTruthy()
  })

  it('offers nothing to open on a page taken down', async () => {
    listPages.mockResolvedValue({
      enabled: true,
      pages: [page({ state: 'taken_down', takenDownBy: 'client' })],
    })
    show(<FeedPage pageId={page().pageId} title="Прайс на ноябрь" version={2} kind="html" />)
    expect(await screen.findByText(/снята/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Открыть страницу/ })).toBeNull()
  })
})
