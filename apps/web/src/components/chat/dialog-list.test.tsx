// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { plain } from '@/components/billing/testing'

import type { DialogListItem, DialogListPage } from './chat-types'
import { DialogList } from './dialog-list'
import { declared } from './testing'

const { listPage, folders, chatGet, segment, rename, remove, pin, archive, search } = vi.hoisted(
  () => ({
    listPage: vi.fn<(input: { folder?: string; cursor?: string }) => Promise<DialogListPage>>(),
    folders: vi.fn<() => Promise<{ folders: unknown[] }>>(),
    chatGet: vi.fn(),
    segment: { current: null as string | null },
    rename: vi.fn<(input: { taskId: string; title: string }) => Promise<{ title: string }>>(),
    remove: vi.fn<(input: { taskId: string }) => Promise<{ removed: true }>>(),
    pin: vi.fn<(input: { taskId: string; pinned: boolean }) => Promise<{ pinned: boolean }>>(),
    archive:
      vi.fn<(input: { taskId: string; archived: boolean }) => Promise<{ archived: boolean }>>(),
    search: vi.fn<(input: { query: string }) => Promise<{ items: DialogListItem[] }>>(),
  }),
)

const mutation = <I, O>(fn: (input: I) => Promise<O>) => ({
  mutationOptions: () => ({ mutationFn: fn }),
})

vi.mock('next/navigation', () => ({
  useSelectedLayoutSegment: () => segment.current,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/projects',
}))
vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({
    task: {
      list: { query: listPage },
      folders: { query: folders },
      get: { query: chatGet },
      search: { query: search },
    },
  }),
  useTRPC: () => ({
    task: {
      rename: mutation(rename),
      remove: mutation(remove),
      pin: mutation(pin),
      archive: mutation(archive),
    },
    billing: { usage: { queryKey: () => ['billing.usage'] } },
  }),
}))

const PROJECT_ID = '0199a3f2-0000-8000-8000-0000000000a1'
const now = new Date()
const yesterday = new Date(now.getTime() - 36 * 60 * 60_000)

function dialog(id: string, patch: Partial<DialogListItem> = {}): DialogListItem {
  return {
    id: `0199a3f2-0000-7000-8000-${id.padStart(12, '0')}`,
    title: 'Поменять цену капучино',
    status: 'done',
    undo: null,
    answered: false,
    rewound: false,
    failed: false,
    createdAt: now,
    updatedAt: now,
    project: null,
    pinned: false,
    archived: false,
    ...patch,
  }
}

function showList(props: { grouped?: boolean; folder?: string | null } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const list = () => (
    <QueryClientProvider client={queryClient}>
      <DialogList {...props} />
    </QueryClientProvider>
  )
  const { rerender } = render(list())
  /** The column stays mounted: the page beside it moved. */
  return (next: string | null) => {
    segment.current = next
    rerender(list())
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  segment.current = null
})

describe('the list of dialogs', () => {
  it('puts the dialogs that wait for the client first, each with its status in words', async () => {
    listPage.mockResolvedValue({
      pinned: [],
      items: [
        dialog('1', { title: 'Новый баннер', status: 'running' }),
        dialog('2', { title: 'Цена латте', status: 'awaiting_approval' }),
        dialog('3', { title: 'Телефон в шапке', status: 'done', createdAt: yesterday }),
      ],
      nextCursor: null,
    })
    showList()
    const waiting = await screen.findByRole('list', { name: 'Ждёт вашего решения' })
    expect(plain(waiting.textContent)).toContain('Цена латте')
    expect(plain(waiting.textContent)).toContain('Посмотрите и примените')
    expect(plain(screen.getByRole('list', { name: 'Сегодня' }).textContent)).toContain(
      'Новый баннер',
    )
    expect(plain(screen.getByRole('list', { name: 'Ранее' }).textContent)).toContain(
      'Телефон в шапке',
    )
    const link = within(waiting).getByRole('link')
    expect(link.getAttribute('href')).toBe(`/chats/${dialog('2').id}`)
    expect(listPage).toHaveBeenCalledWith({})
  })

  // Like a chat of Claude Code (owner's answer of 26.10.2026): the agent answered and asks
  // nothing — the dialog is not among those that wait, and says so.
  it('says «Агент ответил» of a dialog that waits for nothing, with no hint and not as waiting', async () => {
    listPage.mockResolvedValue({
      pinned: [],
      items: [dialog('4', { title: 'Про сайт', status: 'awaiting_user', answered: true })],
      nextCursor: null,
    })
    showList()
    const today = await screen.findByRole('list', { name: 'Сегодня' })
    expect(plain(today.textContent)).toContain('Агент ответил')
    expect(plain(today.textContent)).not.toContain('Ответьте агенту')
    expect(screen.queryByRole('list', { name: 'Ждёт вашего решения' })).toBeNull()
  })

  it('says that the request is undone of a chat `/undo` left waiting for nothing', async () => {
    listPage.mockResolvedValue({
      pinned: [],
      items: [
        dialog('4', { title: 'Про сайт', status: 'awaiting_user', answered: true, rewound: true }),
      ],
      nextCursor: null,
    })
    showList()
    const today = await screen.findByRole('list', { name: 'Сегодня' })
    expect(plain(today.textContent)).toContain('Запрос отменён')
    expect(plain(today.textContent)).not.toContain('Агент ответил')
    expect(screen.queryByRole('list', { name: 'Ждёт вашего решения' })).toBeNull()
  })

  // The owner, 06.11.2026: «просто помечай, что упало с ошибкой» — nothing to confirm or answer.
  it('says «Ошибка» of a chat whose last pass failed, with no hint and not as waiting', async () => {
    listPage.mockResolvedValue({
      pinned: [],
      items: [dialog('4', { title: 'Про сайт', status: 'awaiting_user', failed: true })],
      nextCursor: null,
    })
    showList()
    const today = await screen.findByRole('list', { name: 'Сегодня' })
    expect(plain(today.textContent)).toContain('Ошибка')
    expect(plain(today.textContent)).not.toContain('Нужен ваш ответ')
    expect(plain(today.textContent)).not.toContain('Ответьте агенту')
    expect(screen.queryByRole('list', { name: 'Ждёт вашего решения' })).toBeNull()
  })

  it('renames a dialog in place from the menu of its row, and deletes one after asking', async () => {
    listPage.mockResolvedValue({
      pinned: [],
      items: [dialog('1'), dialog('2', { title: 'Цена латте' })],
      nextCursor: null,
    })
    rename.mockResolvedValueOnce({ title: 'Цена капучино' })
    remove.mockResolvedValueOnce({ removed: true })
    showList()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия с чатом: Поменять цену капучино' }),
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Переименовать' }))
    const name = screen.getByRole('textbox', { name: 'Название чата' })
    expect((name as HTMLInputElement).value).toBe('Поменять цену капучино')
    fireEvent.change(name, { target: { value: 'Цена капучино' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(1))
    expect(rename.mock.calls[0]![0]).toEqual({ taskId: dialog('1').id, title: 'Цена капучино' })

    fireEvent.click(screen.getByRole('button', { name: 'Действия с чатом: Цена латте' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Удалить' }))
    const ask = await screen.findByRole('dialog', { name: 'Удалить чат?' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    expect(remove.mock.calls[0]![0]).toEqual({ taskId: dialog('2').id })
  })

  it('speaks of the site in the window of deleting only for a chat with a project', async () => {
    listPage.mockResolvedValue({
      pinned: [],
      items: [
        dialog('1', { title: 'Без проекта' }),
        dialog('2', {
          title: 'С проектом',
          project: { id: PROJECT_ID, name: 'Кофейня «Крошка»' },
        }),
      ],
      nextCursor: null,
    })
    showList()
    const asked = async (title: string) => {
      fireEvent.click(await screen.findByRole('button', { name: `Действия с чатом: ${title}` }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Удалить' }))
      return plain((await screen.findByRole('dialog', { name: 'Удалить чат?' })).textContent)
    }
    const without = await asked('Без проекта')
    expect(without).toContain('Чат пропадёт из списка.')
    expect(without).not.toContain('сайт')
    fireEvent.click(screen.getByRole('button', { name: 'Оставить' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await asked('С проектом')).toContain('То, что агент уже сделал на сайте, останется.')
  })

  // MUI lets a menu item shrink to its content from `sm` up by a media query of its own, which wins
  // over a plain height: the pressing area of a finger (DESIGN.md) has to hold on every width.
  it('keeps the items of the menu of a row 44px high on every width', async () => {
    listPage.mockResolvedValue({ pinned: [], items: [dialog('1')], nextCursor: null })
    showList()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия с чатом: Поменять цену капучино' }),
    )
    const items = [
      await screen.findByRole('menuitem', { name: 'Переименовать' }),
      screen.getByRole('menuitem', { name: 'Удалить' }),
    ]
    for (const item of items)
      for (const width of [390, 600, 900, 1200, 1440])
        expect(declared(item, 'min-height', width)).toBe('44px')
  })

  it('keeps the old name on Escape', async () => {
    listPage.mockResolvedValue({ pinned: [], items: [dialog('1')], nextCursor: null })
    showList()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия с чатом: Поменять цену капучино' }),
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Переименовать' }))
    const name = screen.getByRole('textbox', { name: 'Название чата' })
    fireEvent.change(name, { target: { value: 'Другое' } })
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Название чата' })).toBeNull()
    expect(rename).not.toHaveBeenCalled()
  })

  it('marks the open dialog as the current page', async () => {
    listPage.mockResolvedValue({ pinned: [], items: [dialog('1'), dialog('2')], nextCursor: null })
    segment.current = dialog('2').id.toUpperCase()
    showList()
    const links = await screen.findAllByRole('link')
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, 'page'])
  })

  it('reads the next page on request', async () => {
    listPage
      .mockResolvedValueOnce({ pinned: [], items: [dialog('1')], nextCursor: 'c1' })
      .mockResolvedValueOnce({
        pinned: [],
        items: [dialog('2', { title: 'Второй' })],
        nextCursor: null,
      })
    showList()
    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
    expect(await screen.findByText('Второй')).toBeTruthy()
    expect(listPage).toHaveBeenLastCalledWith({ cursor: 'c1' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull())
  })

  it('names a dialog without a title and says when there are none', async () => {
    listPage.mockResolvedValueOnce({
      pinned: [],
      items: [dialog('1', { title: null })],
      nextCursor: null,
    })
    showList()
    expect(await screen.findByText('Чат без названия')).toBeTruthy()
  })

  it('says there are no dialogs yet', async () => {
    listPage.mockResolvedValue({ pinned: [], items: [], nextCursor: null })
    showList()
    expect(
      await screen.findByText('Чатов пока нет. Напишите, что нужно сделать, — чат появится здесь.'),
    ).toBeTruthy()
  })

  it('offers to read the list again when it failed', async () => {
    listPage.mockRejectedValueOnce(new Error('offline'))
    listPage.mockResolvedValue({ pinned: [], items: [dialog('1')], nextCursor: null })
    showList()
    expect(await screen.findByText('Не удалось загрузить чаты.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByText('Поменять цену капучино')).toBeTruthy()
  })
})

describe('the row of a chat', () => {
  it('names the project of a chat in one list, and nothing for a chat without one', async () => {
    listPage.mockResolvedValue({
      pinned: [],
      items: [
        dialog('1', {
          title: 'С проектом',
          project: { id: PROJECT_ID, name: 'Кофейня «Крошка»' },
        }),
        dialog('2', { title: 'Без проекта вовсе' }),
      ],
      nextCursor: null,
    })
    showList()
    expect(plain((await screen.findByRole('link', { name: /С проектом/ })).textContent)).toContain(
      '· Кофейня «Крошка»',
    )
    expect(screen.getByRole('link', { name: /Без проекта вовсе/ }).textContent).not.toContain('·')
  })
})

describe('the chats by projects (docs/plan/61-chats-first.md, К23)', () => {
  const OTHER_ID = '0199a3f2-0000-8000-8000-0000000000b2'
  const kroshka = { id: PROJECT_ID, name: 'Кофейня «Крошка»' }
  const grand = { id: OTHER_ID, name: 'Автосервис «Гранд»' }
  const folder = (name: RegExp, expanded?: boolean) =>
    screen.findByRole('button', { name, ...(expanded === undefined ? {} : { expanded }) })

  beforeEach(() => {
    folders.mockResolvedValue({
      folders: [
        { project: kroshka, count: 2, attention: false },
        { project: grand, count: 1, attention: true },
        { project: null, count: 3, attention: false },
      ],
    })
    listPage.mockImplementation(async ({ folder: asked }) => ({
      pinned: [],
      items:
        asked === OTHER_ID
          ? [dialog('7', { title: 'Цены на диагностику', project: grand })]
          : asked === 'none'
            ? [dialog('8', { title: 'Идеи для пекарни' })]
            : [dialog('9', { title: 'Новость о дегустации', project: kroshka })],
      nextCursor: null,
    }))
  })

  it('stands the folders as the server counted them, read only once one is open', async () => {
    showList({ grouped: true })
    await screen.findByRole('button', { name: /Кофейня/ })
    // «Архив» under the folders opens too, and is not a folder (docs/plan/75, ВВ21).
    const names = screen
      .getAllByRole('button')
      .filter(
        (button) =>
          button.hasAttribute('aria-expanded') && !plain(button.textContent).startsWith('Архив'),
      )
    expect(names.map((button) => plain(button.textContent))).toEqual([
      expect.stringContaining('Кофейня «Крошка»'),
      expect.stringContaining('Автосервис «Гранд»'),
      expect.stringContaining('Без проекта'),
    ])
    expect(names[0]!.textContent).toMatch(/2$/)
    expect(listPage).not.toHaveBeenCalled()
  })

  it('reads a folder once it is opened, closes it, and shows no project in its rows', async () => {
    showList({ grouped: true })
    fireEvent.click(await folder(/Кофейня/, false))
    const row = await screen.findByRole('link', { name: /Новость о дегустации/ })
    expect(listPage).toHaveBeenCalledWith({ folder: PROJECT_ID })
    expect(row.textContent).not.toContain('·')
    fireEvent.click(await folder(/Кофейня/, true))
    expect(screen.queryByRole('link', { name: /Новость о дегустации/ })).toBeNull()
  })

  it('asks for the chats without a project by the word of the server', async () => {
    showList({ grouped: true })
    fireEvent.click(await folder(/Без проекта/, false))
    expect(await screen.findByRole('link', { name: /Идеи для пекарни/ })).toBeTruthy()
    expect(listPage).toHaveBeenCalledWith({ folder: 'none' })
  })

  it('says of a closed folder that a chat in it waits, and stops once it is open', async () => {
    showList({ grouped: true })
    const closed = await folder(/Есть чаты, которые ждут вас/, false)
    expect(closed.textContent).toContain('Автосервис «Гранд»')
    expect(screen.getAllByText(/Есть чаты, которые ждут вас/)).toHaveLength(1)
    fireEvent.click(closed)
    await screen.findByRole('link', { name: /Цены на диагностику/ })
    expect(screen.queryByText(/Есть чаты, которые ждут вас/)).toBeNull()
  })

  it('opens the folder of the open chat', async () => {
    const id = dialog('7').id
    segment.current = id
    chatGet.mockResolvedValue({ project: grand })
    showList({ grouped: true })
    const row = await screen.findByRole('link', { name: /Цены на диагностику/ })
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(chatGet).toHaveBeenCalledWith({ taskId: id })
    expect(await folder(/Гранд/, true)).toBeTruthy()
    expect(await folder(/Кофейня/, false)).toBeTruthy()
  })

  it('lets the client close the folder of the open chat, and it stays closed', async () => {
    segment.current = dialog('7').id
    chatGet.mockResolvedValue({ project: grand })
    showList({ grouped: true })
    fireEvent.click(await folder(/Гранд/, true))
    expect(await folder(/Гранд/, false)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Цены на диагностику/ })).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await folder(/Гранд/, false)).toBeTruthy()
  })

  it('opens again the folder the client closed on a move to a chat in it', async () => {
    const shown = dialog('7').id
    segment.current = shown
    chatGet.mockResolvedValue({ project: grand })
    const moveTo = showList({ grouped: true })
    fireEvent.click(await folder(/Гранд/, true))
    await folder(/Гранд/, false)
    moveTo('new')
    moveTo(shown)
    const row = await screen.findByRole('link', { name: /Цены на диагностику/ })
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(await folder(/Гранд/, true)).toBeTruthy()
  })

  it('opens the folder without a project for a chat without one', async () => {
    segment.current = dialog('8').id
    chatGet.mockResolvedValue({ project: null })
    showList({ grouped: true })
    expect(await folder(/Без проекта/, true)).toBeTruthy()
  })

  it('leaves the folders closed on a new chat, and asks nothing about it', async () => {
    segment.current = 'new'
    showList({ grouped: true })
    expect(await folder(/Кофейня/, false)).toBeTruthy()
    expect(chatGet).not.toHaveBeenCalled()
  })

  it('opens the folder the address names', async () => {
    showList({ grouped: true, folder: OTHER_ID.toUpperCase() })
    expect(await folder(/Гранд/, true)).toBeTruthy()
  })

  it('opens the only folder there is', async () => {
    folders.mockResolvedValue({ folders: [{ project: null, count: 1, attention: false }] })
    showList({ grouped: true })
    expect(await folder(/Без проекта/, true)).toBeTruthy()
  })

  it('says there are no chats when there is no folder', async () => {
    folders.mockResolvedValue({ folders: [] })
    showList({ grouped: true })
    expect(
      await screen.findByText('Чатов пока нет. Напишите, что нужно сделать, — чат появится здесь.'),
    ).toBeTruthy()
  })
})

describe('pinned, archived and found chats (docs/plan/75, ВВ21)', () => {
  it('stand the pinned at the head of the list, under their own heading', async () => {
    listPage.mockResolvedValue({
      pinned: [dialog('9', { title: 'Закреплённый чат', pinned: true })],
      items: [dialog('1')],
      nextCursor: null,
    })
    showList()
    const heading = await screen.findByText('Закреплённые')
    const group = heading.parentElement as HTMLElement
    expect(within(group).getByText('Закреплённый чат')).toBeTruthy()
  })

  it('pin a chat from its menu', async () => {
    listPage.mockResolvedValue({ pinned: [], items: [dialog('1')], nextCursor: null })
    pin.mockResolvedValue({ pinned: true })
    showList()
    fireEvent.click(await screen.findByRole('button', { name: /Действия с чатом/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Закрепить' }))
    await waitFor(() =>
      expect(pin).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: dialog('1').id, pinned: true }),
        expect.anything(),
      ),
    )
  })

  it('open «Архив» on press and read it only then', async () => {
    listPage.mockImplementation(async (input) =>
      (input as { view?: string }).view === 'archive'
        ? {
            pinned: [],
            items: [dialog('5', { title: 'Старый чат', archived: true })],
            nextCursor: null,
          }
        : { pinned: [], items: [dialog('1')], nextCursor: null },
    )
    showList()
    await screen.findByText('Поменять цену капучино')
    expect(listPage).not.toHaveBeenCalledWith(expect.objectContaining({ view: 'archive' }))
    fireEvent.click(screen.getByRole('button', { name: /Архив/ }))
    expect(await screen.findByText('Старый чат')).toBeTruthy()
  })

  it('search by the words once they rest, and say when nothing is found', async () => {
    listPage.mockResolvedValue({ pinned: [], items: [dialog('1')], nextCursor: null })
    search.mockResolvedValue({ items: [] })
    showList()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Найти чат' }), {
      target: { value: 'капучино' },
    })
    await waitFor(() => expect(search).toHaveBeenCalledWith({ query: 'капучино' }), {
      timeout: 2000,
    })
    expect(await screen.findByText(/Ничего не нашлось/)).toBeTruthy()
  })
})
