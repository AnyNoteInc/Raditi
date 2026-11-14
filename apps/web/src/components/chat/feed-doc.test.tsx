// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DocRevisions, docRevisionsOf, FeedDoc } from './feed-doc'

const { readDoc, publishDoc } = vi.hoisted(() => ({ readDoc: vi.fn(), publishDoc: vi.fn() }))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    pages: {
      doc: {
        queryKey: (input: { docId: string }) => ['pages', 'doc', input.docId],
        queryOptions: (input: { docId: string }) => ({
          queryKey: ['pages', 'doc', input.docId],
          queryFn: () => readDoc(input),
        }),
      },
      publishDoc: {
        mutationOptions: () => ({ mutationFn: (input: { docId: string }) => publishDoc(input) }),
      },
      list: { queryKey: () => ['pages', 'list'] },
    },
  }),
}))

const docId = '0199a3f2-0000-7000-8000-0000000000d1'
const doc = (version: number) => ({
  docId,
  title: 'Аудит скорости сайта',
  version,
  revision: 4,
  progress: { written: 1, total: 3 },
  sections: [
    {
      key: 'summary',
      intent: 'Итог',
      state: 'shown',
      heading: 'Итог',
      markdown: 'Три **главные** причины.',
    },
    { key: 'method', intent: 'Как мерили', state: 'unchecked', heading: null, markdown: null },
    { key: 'sources', intent: 'Источники', state: 'pending', heading: null, markdown: null },
  ],
  page: null,
  canPublish: false,
})

function show(revision?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const card = (value: number | undefined) => (
    <QueryClientProvider client={client}>
      <DocRevisions.Provider value={new Map(value === undefined ? [] : [[docId, value]])}>
        <FeedDoc docId={docId} />
      </DocRevisions.Provider>
    </QueryClientProvider>
  )
  const view = render(card(revision))
  return { rerender: (value: number) => view.rerender(card(value)) }
}

beforeEach(() => vi.clearAllMocks())

describe('the live card of a document (plan 69, Ст19, Ст22)', () => {
  it('shows the progress, the checked text and quiet lines for the rest', async () => {
    readDoc.mockResolvedValue(doc(0))
    show()
    const card = await screen.findByRole('article', { name: 'Документ «Аудит скорости сайта»' })
    expect(within(card).getAllByText('Разделы: 1 из 3').length).toBeGreaterThan(0)
    expect(within(card).getByText('главные')).toBeTruthy()
    expect(within(card).getByText('Написан — покажем в конце хода')).toBeTruthy()
    expect(within(card).getByText('Пишется')).toBeTruthy()
    // No version yet: nothing to download.
    expect(within(card).queryByRole('link', { name: 'Скачать .md' })).toBeNull()
  })

  it('offers «Скачать .md» once there is a version, and shows the document whole', async () => {
    readDoc.mockResolvedValue(doc(2))
    show()
    const download = await screen.findByRole('link', { name: 'Скачать .md' })
    expect(download.getAttribute('href')).toBe(`/api/documents/${docId}/markdown`)
    expect(screen.getByText(/готов · v2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть документ «Аудит скорости сайта»' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Аудит скорости сайта')).toBeTruthy()
    expect(within(dialog).getByText('Как мерили')).toBeTruthy()
  })

  it('publishes a version by link to its owner, and shows the address (Ст25)', async () => {
    readDoc.mockResolvedValue({ ...doc(2), canPublish: true })
    publishDoc.mockResolvedValue({
      pageId: '0199a3f2-0000-7000-8000-0000000000e1',
      url: 'https://abcdefghijklmnopqrstuvwxyz.pages.raditi.ru/',
      version: 1,
    })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать по ссылке' }))
    const dialog = await screen.findByRole('dialog', { name: 'Страница опубликована' })
    expect(publishDoc).toHaveBeenCalledWith({ docId })
    expect(
      within(dialog).getByRole('link', {
        name: 'https://abcdefghijklmnopqrstuvwxyz.pages.raditi.ru/',
      }),
    ).toBeTruthy()
  })

  it('offers no publication to a member, nor of a document still written', async () => {
    readDoc.mockResolvedValue(doc(2))
    show()
    await screen.findByRole('link', { name: 'Скачать .md' })
    expect(screen.queryByRole('button', { name: 'Опубликовать по ссылке' })).toBeNull()
  })

  it('says why a publication was refused, in the server’s words', async () => {
    readDoc.mockResolvedValue({ ...doc(1), canPublish: true })
    publishDoc.mockRejectedValue(new Error('Эта страница снята. Верните её в разделе «Страницы»'))
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать по ссылке' }))
    const dialog = await screen.findByRole('dialog', { name: 'Не удалось опубликовать' })
    expect(within(dialog).getByRole('alert').textContent).toContain('Эта страница снята')
  })

  it('reads the document again when a newer change of it comes in the feed', async () => {
    readDoc.mockResolvedValue(doc(0))
    const { rerender } = show(4)
    await screen.findByText('Пишется')
    expect(readDoc).toHaveBeenCalledTimes(1)
    readDoc.mockResolvedValue({ ...doc(1), revision: 5 })
    rerender(5)
    expect(await screen.findByText(/готов · v1/)).toBeTruthy()
    expect(readDoc).toHaveBeenCalledTimes(2)
  })

  it('keeps the latest revision of every document of the feed', () => {
    expect(
      docRevisionsOf([
        { type: 'feed.doc_touch', docId: 'a', revision: 2 },
        { type: 'feed.doc_touch', docId: 'a', revision: 5 },
        { type: 'feed.doc_touch', docId: 'b', revision: 1 },
        { type: 'feed.request' },
      ]),
    ).toEqual(
      new Map([
        ['a', 5],
        ['b', 1],
      ]),
    )
  })
})
