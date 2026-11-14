// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatsFrame } from './chats-frame'
import type { DialogListPage } from './chat-types'
import type { ChatsGroup } from './chats-group'

const { listPage, folders, replace, mocks } = vi.hoisted(() => ({
  listPage: vi.fn<(input: { folder?: string }) => Promise<DialogListPage>>(),
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
      folders: { query: folders },
      get: { query: vi.fn() },
    },
  }),
  useTRPC: () => ({
    task: {
      rename: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      remove: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      pin: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      archive: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
    },
    billing: { usage: { queryKey: () => ['billing.usage'] } },
  }),
}))

const NOW = new Date()
const chat: DialogListPage['items'][number] = {
  id: '0199a3f2-0000-7000-8000-000000000001',
  title: 'Идеи для названия пекарни',
  status: 'done',
  undo: null,
  answered: false,
  rewound: false,
  failed: false,
  createdAt: NOW,
  updatedAt: NOW,
  project: null,
  pinned: false,
  archived: false,
}

function showFrame(segment: string | null, group: ChatsGroup = 'list') {
  mocks.segment = segment
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatsFrame group={group}>
        <p>Содержимое</p>
      </ChatsFrame>
    </QueryClientProvider>,
  )
}

const list = () => screen.getByRole('navigation', { name: 'Чаты' })
const groupButton = () => screen.queryByRole('button', { name: 'Группировка чатов' })

beforeEach(() => {
  vi.clearAllMocks()
  document.cookie = 'raditi-chats-group=; max-age=0; path=/'
  mocks.search = new URLSearchParams()
  listPage.mockResolvedValue({ pinned: [], items: [chat], nextCursor: null })
  folders.mockResolvedValue({ folders: [{ project: null, count: 1, attention: false }] })
})

describe('the frame of «Чаты»', () => {
  it('heads the page with the list at the root, with «Новый чат» and no way back', async () => {
    showFrame(null)
    expect(within(list()).getByRole('heading', { level: 1, name: 'Чаты' })).toBeTruthy()
    const action = within(list()).getByRole('link', { name: 'Новый чат' })
    expect(action.getAttribute('href')).toBe('/chats/new')
    expect(action.getAttribute('aria-current')).toBeNull()
    expect(screen.queryByRole('link', { name: 'К чатам' })).toBeNull()
    expect(await screen.findByText('Идеи для названия пекарни')).toBeTruthy()
    expect(screen.getByText('Содержимое')).toBeTruthy()
  })

  it('marks «Новый чат» on its address and leaves the page heading to the content', () => {
    showFrame('new')
    expect(
      within(list()).getByRole('link', { name: 'Новый чат' }).getAttribute('aria-current'),
    ).toBe('page')
    expect(within(list()).getByRole('heading', { level: 2, name: 'Чаты' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
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
        <ChatsFrame group="list">
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
        <ChatsFrame group="list">
          <p>Другое</p>
        </ChatsFrame>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(document.activeElement).toBe(content))
    content.remove()
  })

  it('offers no grouping while there is nothing to group', async () => {
    listPage.mockResolvedValue({ pinned: [], items: [], nextCursor: null })
    showFrame('new')
    expect(
      await screen.findByText('Чатов пока нет. Напишите, что нужно сделать, — чат появится здесь.'),
    ).toBeTruthy()
    expect(groupButton()).toBeNull()
  })

  it.each([
    ['is being read', () => new Promise<DialogListPage>(() => {})],
    ['could not be read', () => Promise.reject(new Error('down'))],
  ])(
    'keeps the grouping while the list %s: only an empty answer takes it away',
    async (_case, answer) => {
      listPage.mockImplementation(answer)
      showFrame(null)
      await waitFor(() => expect(listPage).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(groupButton()).toBeTruthy()
    },
  )

  it('marks the list and the way back for the browser that covers them (docs/plan/59, И17)', () => {
    showFrame('0199a3f2-0000-7000-8000-000000000001')
    expect(list().hasAttribute('data-chat-list')).toBe(true)
    expect(screen.getByRole('link', { name: 'К чатам' }).hasAttribute('data-chat-back')).toBe(true)
  })

  it('shows the chats by projects once chosen, and keeps the choice in the cookie', async () => {
    showFrame(null)
    await screen.findByText('Идеи для названия пекарни')
    fireEvent.click(groupButton()!)
    const menu = await screen.findByRole('menu', { name: 'Показывать чаты' })
    const [one, projects] = within(menu).getAllByRole('menuitemradio')
    expect(one!.textContent).toBe('Одним списком')
    expect(one!.getAttribute('aria-checked')).toBe('true')
    expect(projects!.textContent).toBe('По проектам')
    fireEvent.click(projects!)
    expect(document.cookie).toContain('raditi-chats-group=projects')
    expect(await screen.findByRole('button', { name: /Без проекта/ })).toBeTruthy()
  })

  it('opens on the choice of its cookie', async () => {
    showFrame(null, 'projects')
    expect(await screen.findByRole('button', { name: /Без проекта/ })).toBeTruthy()
  })

  it('shows the folder the address asks for, whatever is chosen', async () => {
    const id = '0199a3f2-0000-8000-8000-000000000002'
    mocks.search = new URLSearchParams(`folder=${id}`)
    folders.mockResolvedValue({
      folders: [
        { project: { id, name: 'Кофейня' }, count: 1, attention: false },
        { project: null, count: 1, attention: false },
      ],
    })
    showFrame(null)
    expect(await screen.findByRole('button', { name: /Кофейня/, expanded: true })).toBeTruthy()
    await waitFor(() => expect(listPage).toHaveBeenCalledWith({ folder: id }))
  })

  it('says folders are shown on the address of a folder, and goes back to one list from it', async () => {
    const id = '0199a3f2-0000-8000-8000-000000000002'
    mocks.search = new URLSearchParams(`folder=${id}`)
    folders.mockResolvedValue({
      folders: [{ project: { id, name: 'Кофейня' }, count: 1, attention: false }],
    })
    showFrame(null, 'list')
    await screen.findByRole('button', { name: /Кофейня/, expanded: true })
    fireEvent.click(groupButton()!)
    const menu = await screen.findByRole('menu', { name: 'Показывать чаты' })
    const [one, projects] = within(menu).getAllByRole('menuitemradio')
    expect(projects!.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(one!)
    expect(document.cookie).toContain('raditi-chats-group=list')
    // The address kept the folders: it goes, and one list shows.
    expect(replace).toHaveBeenCalledWith('/chats')
  })

  it('moves no address when the way changes without a folder in it', async () => {
    showFrame(null)
    await screen.findByText('Идеи для названия пекарни')
    fireEvent.click(groupButton()!)
    const menu = await screen.findByRole('menu', { name: 'Показывать чаты' })
    fireEvent.click(within(menu).getAllByRole('menuitemradio')[1]!)
    expect(replace).not.toHaveBeenCalled()
  })
})
