// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agentDocEntry,
  agentDocOfEntry,
  agentDocumentIdsOf,
  AgentDocumentView,
  DocRevisions,
  docRevisionsOf,
  useAgentDocumentArrivals,
} from './agent-document'
import { docId, sampleDoc } from './doc-test-fixtures'

const { readDoc, readPage, publishDoc } = vi.hoisted(() => ({
  readDoc: vi.fn(),
  readPage: vi.fn(),
  publishDoc: vi.fn(),
}))

vi.mock('@/trpc/client', async () =>
  (await import('./doc-test-fixtures')).trpcMock({ readDoc, readPage, publishDoc }),
)

function show(props: { onFullscreen?: (on: boolean) => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DocRevisions.Provider value={new Map()}>
        <AgentDocumentView docId={docId} {...props} />
      </DocRevisions.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('a document of the agent in the tab «Документы» (plan 74)', () => {
  it('shows the sections as they come: checked ones in full, the next marked, the rest quiet', async () => {
    readDoc.mockResolvedValue(sampleDoc(0))
    show()
    const view = await screen.findByLabelText('Документ «Аудит скорости сайта»')
    expect(
      within(view).getByRole('heading', { level: 1, name: 'Аудит скорости сайта' }),
    ).toBeTruthy()
    expect(within(view).getByRole('heading', { level: 2, name: 'Итог' })).toBeTruthy()
    expect(within(view).getByText('главные')).toBeTruthy()
    expect(within(view).getByText('Проверяем раздел…')).toBeTruthy()
    expect(within(view).getByText('Пишется')).toBeTruthy()
    expect(within(view).getByRole('status').textContent).toBe('пишется · 2 из 3')
    expect(within(view).getByRole('progressbar', { name: 'Разделы: 2 из 3' })).toBeTruthy()
    // No version yet: nothing to download or publish.
    expect(within(view).queryByRole('link', { name: /Скачать/ })).toBeNull()
  })

  it('shows a finished text document as text, with «Скачать .md»', async () => {
    readDoc.mockResolvedValue(sampleDoc(2))
    show()
    const download = await screen.findByRole('link', { name: 'Скачать .md' })
    expect(download.getAttribute('href')).toBe(`/api/documents/${docId}/markdown`)
    expect(screen.getByRole('status').textContent).toBe('готов · v2')
    expect(screen.getByRole('heading', { level: 2, name: 'Как мерили' })).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(readPage).not.toHaveBeenCalled()
  })

  it('shows a finished page as its page to read, framed without scripts', async () => {
    readDoc.mockResolvedValue(sampleDoc(1, { view: 'page' }))
    readPage.mockResolvedValue({ html: '<!doctype html><title>Аудит</title>', version: 1 })
    show()
    const frame = await screen.findByTitle('Документ «Аудит скорости сайта»')
    expect(frame.getAttribute('srcdoc')).toBe('<!doctype html><title>Аудит</title>')
    expect(frame.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox')
    expect(screen.getByRole('link', { name: 'Скачать .html' })).toBeTruthy()
  })

  it('keeps showing the sections while a finished document is changed again', async () => {
    readDoc.mockResolvedValue(sampleDoc(1, { view: 'page', draft: true }))
    show()
    await screen.findByText('Пишется')
    expect(screen.queryByTitle('Документ «Аудит скорости сайта»')).toBeNull()
    expect(screen.getByRole('link', { name: 'Скачать .html' })).toBeTruthy()
  })

  it('publishes a version by link to its owner (Ст25) and goes full screen', async () => {
    readDoc.mockResolvedValue(sampleDoc(2, { canPublish: true }))
    publishDoc.mockResolvedValue({
      pageId: '0199a3f2-0000-7000-8000-0000000000e1',
      url: 'https://abcdefghijklmnopqrstuvwxyz.pages.raditi.ru/',
      version: 1,
    })
    const onFullscreen = vi.fn()
    show({ onFullscreen })
    fireEvent.click(await screen.findByRole('button', { name: 'На весь экран' }))
    expect(onFullscreen).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Опубликовать по ссылке' }))
    const dialog = await screen.findByRole('dialog', { name: 'Страница опубликована' })
    expect(publishDoc).toHaveBeenCalledWith({ docId })
    expect(
      within(dialog).getByRole('link', {
        name: 'https://abcdefghijklmnopqrstuvwxyz.pages.raditi.ru/',
      }),
    ).toBeTruthy()
  })

  it('offers no publication to a member', async () => {
    readDoc.mockResolvedValue(sampleDoc(2))
    show()
    await screen.findByRole('link', { name: 'Скачать .md' })
    expect(screen.queryByRole('button', { name: 'Опубликовать по ссылке' })).toBeNull()
  })
})

describe('the documents of the agent in the rows of the chat', () => {
  it('lists each document once, oldest first, and names it in the tab’s history', () => {
    expect(
      agentDocumentIdsOf([
        { type: 'feed.doc', docId: 'a' },
        { type: 'feed.request' },
        { type: 'feed.doc', docId: 'b' },
        { type: 'feed.doc', docId: 'a' },
      ]),
    ).toEqual(['a', 'b'])
    expect(agentDocOfEntry(agentDocEntry('a'))).toBe('a')
    expect(agentDocOfEntry('report.md')).toBeNull()
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

  it('tells a document begun while the client looks, never one of the history', () => {
    const onArrive = vi.fn()
    const { rerender } = renderHook(
      ({ ids, ready }: { ids: string[]; ready: boolean }) =>
        useAgentDocumentArrivals(ids, ready, onArrive),
      { initialProps: { ids: ['a'], ready: false } },
    )
    rerender({ ids: ['a'], ready: true })
    expect(onArrive).not.toHaveBeenCalled()
    rerender({ ids: ['a', 'b'], ready: true })
    expect(onArrive).toHaveBeenCalledExactlyOnceWith('b')
    rerender({ ids: ['a', 'b'], ready: true })
    expect(onArrive).toHaveBeenCalledTimes(1)
  })
})
