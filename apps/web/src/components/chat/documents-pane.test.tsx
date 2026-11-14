// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PAGE_SANDBOX } from '@repo/domain/pages'

import { TASK_ID } from './testing'

const params: { taskId?: string } = { taskId: TASK_ID }
vi.mock('next/navigation', () => ({ useParams: () => params }))

const { pageView, text } = vi.hoisted(() => ({
  pageView:
    vi.fn<
      (input: { taskId: string; fileId: string }) => Promise<{ url: string; expiresAt: string }>
    >(),
  text: vi.fn<
    (input: {
      taskId: string
      fileId: string
    }) => Promise<{ readable: true; text: string; truncated: boolean } | { readable: false }>
  >(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    document: {
      pageView: { mutationOptions: () => ({ mutationFn: pageView }) },
      text: {
        queryOptions: (input: { taskId: string; fileId: string }) => ({
          queryKey: ['document.text', input] as QueryKey,
          queryFn: () => text(input),
        }),
      },
    },
  }),
}))

import { DocumentsPane, documentWindowHref } from './documents-pane'
import { FeedDocuments } from './feed-document'
import { chatDocumentsOf } from '@repo/domain/tasks/chat-documents'

const uuid = (n: number) => `0199a3f2-0000-8000-8000-${String(n).padStart(12, '0')}`
const file = (id: number, name: string) => ({
  id: String(id),
  type: 'feed.file',
  fileId: uuid(id),
  name,
  sizeBytes: 10,
})

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const TEXTS: Record<string, string> = {
  [uuid(1)]: '# Оглавление\n\n- [Цены](02-цены.md#доставка)\n- [Нет такого](09-нет.md)',
  [uuid(2)]: '# Цены\n\n## Доставка\n\nБесплатно.\n\n![Схема](схема.png)',
  [uuid(4)]: '# Цены, вторая версия',
}

beforeEach(() => {
  pageView.mockReset().mockResolvedValue({
    url: 'http://pages.localhost:3000/v/a.b',
    expiresAt: new Date().toISOString(),
  })
  text.mockReset().mockImplementation(async ({ fileId }) => ({
    readable: true,
    text: TEXTS[fileId] ?? '# ?',
    truncated: false,
  }))
  Element.prototype.scrollIntoView = vi.fn()
})

const rows = [
  { id: '0', type: 'feed.request' },
  file(1, '00-оглавление.md'),
  file(2, '02-цены.md'),
  file(3, 'схема.png'),
  file(4, '02-цены.md'),
  file(5, 'Отчёт.html'),
]

describe('«Документы» (docs/plan/67-agent-documents.md, Д4–Д7)', () => {
  it('opens the table of contents of a set and follows its links, back and forth', async () => {
    render(wrap(<DocumentsPane taskId={TASK_ID} rows={rows} target={null} />))
    expect(await screen.findByRole('heading', { level: 1, name: 'Оглавление' })).toBeTruthy()
    // A link to a document the chat lacks is its words, with the hint.
    expect(screen.getByTitle('Такого документа в чате нет.').textContent).toBe('Нет такого')
    fireEvent.click(screen.getByRole('link', { name: 'Цены' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Цены, вторая версия' }),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Оглавление' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Вперёд' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Цены, вторая версия' }),
    ).toBeTruthy()
  })

  it('shows an older version with the picture as it was then', async () => {
    render(
      wrap(
        <DocumentsPane
          taskId={TASK_ID}
          rows={rows}
          target={{ name: '02-цены.md', fileId: uuid(2), seq: 1 }}
        />,
      ),
    )
    expect(await screen.findByRole('heading', { level: 2, name: 'Доставка' })).toBeTruthy()
    // The picture of row 3 came after version 1 (row 2): it is not shown for it.
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Схема')).toBeTruthy()
  })

  it('frames a page from the domain of pages, sandboxed, never by the cabinet’s origin', async () => {
    render(
      wrap(
        <DocumentsPane
          taskId={TASK_ID}
          rows={rows}
          target={{ name: 'Отчёт.html', fileId: null, seq: 1 }}
        />,
      ),
    )
    const frame = (await screen.findByTitle('Документ «Отчёт»')) as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('http://pages.localhost:3000/v/a.b')
    expect(frame.getAttribute('sandbox')).toBe(PAGE_SANDBOX)
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(pageView).toHaveBeenCalledWith({ taskId: TASK_ID, fileId: uuid(5) }, expect.anything())
    const tab = screen.getByRole('link', { name: 'Открыть в новой вкладке' })
    expect(tab.getAttribute('href')).toBe(documentWindowHref(TASK_ID, uuid(5)))
    // «Обновить» asks a fresh address.
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))
    await waitFor(() => expect(pageView).toHaveBeenCalledTimes(2))
  })

  it('says a document is not UTF-8 and offers to download it', async () => {
    text.mockResolvedValue({ readable: false })
    render(wrap(<DocumentsPane taskId={TASK_ID} rows={rows} target={null} />))
    expect(
      await screen.findByText('Не удалось прочитать документ. Его можно скачать.'),
    ).toBeTruthy()
  })
})

describe('the documents in the feed (Д4)', () => {
  const documents = chatDocumentsOf(rows)
  it('shows one card for a turn, each document with its version, «Открыть» and «Скачать»', () => {
    const onOpen = vi.fn()
    render(<FeedDocuments fileIds={[uuid(4), uuid(5)]} documents={documents} onOpen={onOpen} />)
    expect(screen.getByText('Документы · 2')).toBeTruthy()
    expect(screen.getByText('Документ · версия 2')).toBeTruthy()
    expect(screen.getByText('Документ · версия 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть документ «Отчёт»' }))
    expect(onOpen).toHaveBeenCalledWith(uuid(5))
    const download = screen.getByRole('link', { name: 'Скачать документ «02-цены»' })
    expect(download.getAttribute('href')).toBe(`/api/tasks/${TASK_ID}/files/${uuid(4)}`)
  })
})
