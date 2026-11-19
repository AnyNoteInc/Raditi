// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatsFrame } from './chats-frame'
import type { DialogListPage } from './chat-types'

const { listPage, folders, replace, mocks } = vi.hoisted(() => ({
  listPage: vi.fn<(input: { cursor?: string }) => Promise<DialogListPage>>(),
  folders: vi.fn(),
  replace: vi.fn(),
  mocks: { segment: null as string | null, search: new URLSearchParams() },
}))

vi.mock('next/navigation', () => ({
  useSelectedLayoutSegment: () => mocks.segment,
  useSearchParams: () => mocks.search,
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => '/chats',
}))
vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({
    task: {
      list: { query: listPage },
      get: { query: vi.fn() },
      folders: { query: folders },
    },
  }),
  useTRPC: () => ({
    task: {
      rename: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      remove: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      pin: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      archive: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      moveToProject: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
    },
    project: { pathKey: () => ['project'] },
    billing: { usage: { queryKey: () => ['billing.usage'] } },
  }),
}))

const NOW = new Date()
const chat: DialogListPage['items'][number] = {
  id: '0199a3f2-0000-7000-8000-000000000001',
  title: 'Идеи для названия пекарни',
  status: 'done',
  answered: false,
  rewound: false,
  failed: false,
  createdAt: NOW,
  updatedAt: NOW,
  pinned: false,
  archived: false,
  telegram: false,
  project: null,
  schedule: null,
  repo: null,
}

function showFrame(segment: string | null, group?: 'list' | 'projects') {
  mocks.segment = segment
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatsFrame {...(group ? { group } : {})}>
        <p>Содержимое</p>
      </ChatsFrame>
    </QueryClientProvider>,
  )
}

const list = () => screen.getByRole('navigation', { name: 'Чаты' })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.search = new URLSearchParams()
  listPage.mockResolvedValue({ pinned: [], items: [chat], nextCursor: null })
})

describe('the frame of «Чаты»', () => {
  it('heads the page with the list at the root, with «Создать» and no way back', async () => {
    showFrame(null)
    expect(within(list()).getByRole('heading', { level: 1, name: 'Чаты' })).toBeTruthy()
    const action = within(list()).getByRole('link', { name: 'Создать чат' })
    expect(action.textContent).toBe('Создать')
    expect(action.getAttribute('href')).toBe('/chats/new')
    expect(action.getAttribute('aria-current')).toBeNull()
    expect(screen.queryByRole('link', { name: 'К чатам' })).toBeNull()
    expect(await screen.findByText('Идеи для названия пекарни')).toBeTruthy()
    expect(screen.getByText('Содержимое')).toBeTruthy()
  })

  it('marks «Создать» on its address and leaves the page heading to the content', () => {
    showFrame('new')
    expect(
      within(list()).getByRole('link', { name: 'Создать чат' }).getAttribute('aria-current'),
    ).toBe('page')
    expect(within(list()).getByRole('heading', { level: 2, name: 'Чаты' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('shows the chats by projects from «Показывать чаты», and remembers it (19.11.2026)', async () => {
    folders.mockResolvedValue({
      folders: [{ project: { id: chat.id, name: 'Колос' }, count: 1, attention: false }],
    })
    document.cookie = 'raditi-chats-group=; max-age=0; path=/'
    showFrame(null)
    expect(await screen.findByText('Идеи для названия пекарни')).toBeTruthy()
    fireEvent.click(within(list()).getByRole('button', { name: 'Группировка чатов' }))
    const menu = await screen.findByRole('menu', { name: 'Показывать чаты' })
    expect(
      within(menu)
        .getByRole('menuitemradio', { name: 'Одним списком' })
        .getAttribute('aria-checked'),
    ).toBe('true')
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'По проектам' }))
    expect(await within(list()).findByRole('button', { name: /Колос/ })).toBeTruthy()
    expect(document.cookie).toContain('raditi-chats-group=projects')
  })

  it('draws the folders at once when the cookie chose them', async () => {
    folders.mockResolvedValue({ folders: [{ project: null, count: 1, attention: false }] })
    showFrame(null, 'projects')
    expect(await within(list()).findByRole('button', { name: /Без проекта/ })).toBeTruthy()
  })

  it('leads back to the list from an item, outside the list itself', () => {
    showFrame('0199a3f2-0000-7000-8000-000000000001')
    const back = screen.getByRole('link', { name: 'К чатам' })
    expect(back.getAttribute('href')).toBe('/chats')
    expect(list().contains(back)).toBe(false)
  })

  it('moves the focus to the content when the link that had it goes', async () => {
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatsFrame>
          <p>Содержимое</p>
        </ChatsFrame>
      </QueryClientProvider>,
    )
    const content = document.createElement('main')
    content.id = 'chats-content'
    content.tabIndex = -1
    document.body.append(content)
    mocks.segment = 'new'
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ChatsFrame>
          <p>Другое</p>
        </ChatsFrame>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(document.activeElement).toBe(content))
    content.remove()
  })

  it('opens «Поиск чатов» by the loupe of the head and closes it (docs/plan/79, П1)', async () => {
    showFrame(null)
    const loupe = await screen.findByRole('button', { name: 'Найти чат' })
    expect(screen.queryByRole('dialog', { name: 'Поиск чатов' })).toBeNull()
    fireEvent.click(loupe)
    const window_ = await screen.findByRole('dialog', { name: 'Поиск чатов' })
    expect(within(window_).getByRole('searchbox', { name: 'Найти чат' })).toBeTruthy()
    fireEvent.click(within(window_).getByRole('button', { name: 'Закрыть' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Поиск чатов' })).toBeNull())
    // «Архив» stands in the column whatever the list holds (docs/plan/77, Р1).
    expect(screen.getByRole('button', { name: 'Архив' })).toBeTruthy()
  })

  it('marks the list and the way back for the browser that covers them (docs/plan/59, И17)', () => {
    showFrame('0199a3f2-0000-7000-8000-000000000001')
    expect(list().hasAttribute('data-chat-list')).toBe(true)
    expect(screen.getByRole('link', { name: 'К чатам' }).hasAttribute('data-chat-back')).toBe(true)
  })
})
