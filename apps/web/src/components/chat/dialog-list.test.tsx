// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { plain } from '@/components/billing/testing'

import type { DialogListItem, DialogListPage } from './chat-types'
import { DialogList } from './dialog-list'
import { declared, SITE_ID } from './testing'

const { listPage, segment, rename, remove } = vi.hoisted(() => ({
  listPage: vi.fn<(input: { siteId: string; cursor?: string }) => Promise<DialogListPage>>(),
  segment: { current: null as string | null },
  rename: vi.fn<(input: { taskId: string; title: string }) => Promise<{ title: string }>>(),
  remove: vi.fn<(input: { taskId: string }) => Promise<{ removed: true }>>(),
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
  useTRPCClient: () => ({ task: { list: { query: listPage } } }),
  useTRPC: () => ({
    task: { rename: mutation(rename), remove: mutation(remove) },
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
    mode: 'work',
    undo: null,
    answered: false,
    createdAt: now,
    updatedAt: now,
    ...patch,
  }
}

function showList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <DialogList siteId={SITE_ID} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  segment.current = null
})

describe('the list of dialogs', () => {
  it('puts the dialogs that wait for the client first, each with its status in words', async () => {
    listPage.mockResolvedValue({
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
    expect(link.getAttribute('href')).toBe(`/projects/${SITE_ID}/chat/${dialog('2').id}`)
    expect(listPage).toHaveBeenCalledWith({ siteId: SITE_ID })
  })

  // Like a chat of Claude Code (owner's answer of 26.10.2026): the agent answered and asks
  // nothing — the dialog is not among those that wait, and says so.
  it('says «Агент ответил» of a dialog that waits for nothing, with no hint and not as waiting', async () => {
    listPage.mockResolvedValue({
      items: [dialog('4', { title: 'Про сайт', status: 'awaiting_user', answered: true })],
      nextCursor: null,
    })
    showList()
    const today = await screen.findByRole('list', { name: 'Сегодня' })
    expect(plain(today.textContent)).toContain('Агент ответил')
    expect(plain(today.textContent)).not.toContain('Ответьте агенту')
    expect(screen.queryByRole('list', { name: 'Ждёт вашего решения' })).toBeNull()
  })

  it('renames a dialog in place from the menu of its row, and deletes one after asking', async () => {
    listPage.mockResolvedValue({
      items: [dialog('1'), dialog('2', { title: 'Цена латте' })],
      nextCursor: null,
    })
    rename.mockResolvedValueOnce({ title: 'Цена капучино' })
    remove.mockResolvedValueOnce({ removed: true })
    showList()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия с диалогом: Поменять цену капучино' }),
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Переименовать' }))
    const name = screen.getByRole('textbox', { name: 'Название диалога' })
    expect((name as HTMLInputElement).value).toBe('Поменять цену капучино')
    fireEvent.change(name, { target: { value: 'Цена капучино' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(1))
    expect(rename.mock.calls[0]![0]).toEqual({ taskId: dialog('1').id, title: 'Цена капучино' })

    fireEvent.click(screen.getByRole('button', { name: 'Действия с диалогом: Цена латте' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Удалить' }))
    const ask = await screen.findByRole('dialog', { name: 'Удалить диалог?' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    expect(remove.mock.calls[0]![0]).toEqual({ taskId: dialog('2').id })
  })

  // MUI lets a menu item shrink to its content from `sm` up by a media query of its own, which wins
  // over a plain height: the pressing area of a finger (DESIGN.md) has to hold on every width.
  it('keeps the items of the menu of a row 44px high on every width', async () => {
    listPage.mockResolvedValue({ items: [dialog('1')], nextCursor: null })
    showList()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия с диалогом: Поменять цену капучино' }),
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
    listPage.mockResolvedValue({ items: [dialog('1')], nextCursor: null })
    showList()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Действия с диалогом: Поменять цену капучино' }),
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Переименовать' }))
    const name = screen.getByRole('textbox', { name: 'Название диалога' })
    fireEvent.change(name, { target: { value: 'Другое' } })
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Название диалога' })).toBeNull()
    expect(rename).not.toHaveBeenCalled()
  })

  it('marks the open dialog as the current page', async () => {
    listPage.mockResolvedValue({ items: [dialog('1'), dialog('2')], nextCursor: null })
    segment.current = dialog('2').id.toUpperCase()
    showList()
    const links = await screen.findAllByRole('link')
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, 'page'])
  })

  it('reads the next page on request', async () => {
    listPage
      .mockResolvedValueOnce({ items: [dialog('1')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [dialog('2', { title: 'Второй' })], nextCursor: null })
    showList()
    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
    expect(await screen.findByText('Второй')).toBeTruthy()
    expect(listPage).toHaveBeenLastCalledWith({ siteId: SITE_ID, cursor: 'c1' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull())
  })

  it('names a dialog without a title and says when there are none', async () => {
    listPage.mockResolvedValueOnce({ items: [dialog('1', { title: null })], nextCursor: null })
    showList()
    expect(await screen.findByText('Диалог без названия')).toBeTruthy()
  })

  it('says there are no dialogs yet', async () => {
    listPage.mockResolvedValue({ items: [], nextCursor: null })
    showList()
    expect(
      await screen.findByText(
        'Диалогов пока нет. Опишите, что поменять на сайте, — диалог появится здесь.',
      ),
    ).toBeTruthy()
  })

  it('offers to read the list again when it failed', async () => {
    listPage.mockRejectedValueOnce(new Error('offline'))
    listPage.mockResolvedValue({ items: [dialog('1')], nextCursor: null })
    showList()
    expect(await screen.findByText('Не удалось загрузить диалоги.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByText('Поменять цену капучино')).toBeTruthy()
  })
})
