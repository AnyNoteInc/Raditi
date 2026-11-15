// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { plain } from '@/components/billing/testing'

import type { DialogListItem, DialogListPage } from './chat-types'
import { ArchiveButton, DialogList } from './dialog-list'
import { SearchDialog } from './search-dialog'
import { declared } from './testing'

const { listPage, segment, rename, remove, pin, archive, search } = vi.hoisted(() => ({
  listPage: vi.fn<(input: { cursor?: string }) => Promise<DialogListPage>>(),
  segment: { current: null as string | null },
  rename: vi.fn<(input: { taskId: string; title: string }) => Promise<{ title: string }>>(),
  remove: vi.fn<(input: { taskId: string }) => Promise<{ removed: true }>>(),
  pin: vi.fn<(input: { taskId: string; pinned: boolean }) => Promise<{ pinned: boolean }>>(),
  archive:
    vi.fn<(input: { taskId: string; archived: boolean }) => Promise<{ archived: boolean }>>(),
  search: vi.fn<(input: { query: string }) => Promise<{ items: DialogListItem[] }>>(),
}))

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

const now = new Date()
const yesterday = new Date(now.getTime() - 36 * 60 * 60_000)

function dialog(id: string, patch: Partial<DialogListItem> = {}): DialogListItem {
  return {
    id: `0199a3f2-0000-7000-8000-${id.padStart(12, '0')}`,
    title: 'Поменять цену капучино',
    status: 'done',
    answered: false,
    rewound: false,
    failed: false,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false,
    telegram: false,
    project: null,
    ...patch,
  }
}

function showList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const list = () => (
    <QueryClientProvider client={queryClient}>
      <DialogList />
      {/* The frame pins «Архив» at the bottom of the column (docs/plan/77, Р1). */}
      <ArchiveButton />
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

  it('open «Архив» from the bottom in a window, read it only then, and restore a chat', async () => {
    listPage.mockImplementation(async (input) =>
      (input as { view?: string }).view === 'archive'
        ? {
            pinned: [],
            items: [dialog('5', { title: 'Старый чат', archived: true })],
            nextCursor: null,
          }
        : { pinned: [], items: [dialog('1')], nextCursor: null },
    )
    archive.mockResolvedValue({ archived: false })
    showList()
    await screen.findByText('Поменять цену капучино')
    expect(listPage).not.toHaveBeenCalledWith(expect.objectContaining({ view: 'archive' }))
    fireEvent.click(screen.getByRole('button', { name: 'Архив' }))
    const window_ = await screen.findByRole('dialog', { name: 'Архив чатов' })
    expect(await within(window_).findByText('Старый чат')).toBeTruthy()
    fireEvent.click(within(window_).getByRole('button', { name: 'Восстановить' }))
    await waitFor(() => expect(archive).toHaveBeenCalled())
    expect(archive.mock.calls[0]![0]).toEqual({ taskId: dialog('5').id, archived: false })
    expect(await within(window_).findByText('Чат вернулся в список.')).toBeTruthy()
  })

  it('«Поиск чатов» shows the latest chats, then searches by the words once they rest', async () => {
    listPage.mockResolvedValue({ pinned: [], items: [dialog('1')], nextCursor: null })
    search.mockResolvedValue({ items: [] })
    const onClose = vi.fn()
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SearchDialog open onClose={onClose} />
      </QueryClientProvider>,
    )
    const window_ = await screen.findByRole('dialog', { name: 'Поиск чатов' })
    expect(await within(window_).findByText('Поменять цену капучино')).toBeTruthy()
    const field = within(window_).getByRole('searchbox', { name: 'Найти чат' })
    // One cross of the field's own, and only over words (docs/plan/79, П2).
    expect(within(window_).queryByRole('button', { name: 'Очистить поиск' })).toBeNull()
    fireEvent.change(field, { target: { value: 'капучино' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith({ query: 'капучино' }), {
      timeout: 2000,
    })
    expect(await within(window_).findByText(/Ничего не нашлось/)).toBeTruthy()
    fireEvent.click(within(window_).getByRole('button', { name: 'Очистить поиск' }))
    expect((field as HTMLInputElement).value).toBe('')
  })
})
