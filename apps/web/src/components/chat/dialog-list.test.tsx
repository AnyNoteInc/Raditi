// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { plain } from '@/components/billing/testing'

import type { DialogListItem, DialogListPage } from './chat-types'
import { DialogList } from './dialog-list'
import { SITE_ID } from './testing'

const { listPage, segment } = vi.hoisted(() => ({
  listPage: vi.fn<(input: { siteId: string; cursor?: string }) => Promise<DialogListPage>>(),
  segment: { current: null as string | null },
}))

vi.mock('next/navigation', () => ({ useSelectedLayoutSegment: () => segment.current }))
vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({ task: { list: { query: listPage } } }),
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
