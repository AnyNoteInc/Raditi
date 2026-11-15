// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { docId, sampleDoc } from './doc-test-fixtures'
import { DocRevisions, FeedDoc } from './feed-doc'

const { readDoc } = vi.hoisted(() => ({ readDoc: vi.fn() }))

vi.mock('@/trpc/client', async () => (await import('./doc-test-fixtures')).trpcMock({ readDoc }))

function show({
  revision,
  onOpen,
  open,
}: { revision?: number; onOpen?: (id: string) => void; open?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const card = (value: number | undefined) => (
    <QueryClientProvider client={client}>
      <DocRevisions.Provider value={new Map(value === undefined ? [] : [[docId, value]])}>
        <FeedDoc docId={docId} {...(onOpen ? { onOpen } : {})} open={open} />
      </DocRevisions.Provider>
    </QueryClientProvider>
  )
  const view = render(card(revision))
  return { rerender: (value: number) => view.rerender(card(value)) }
}

beforeEach(() => vi.clearAllMocks())

describe('the card of a document in the feed (plan 74)', () => {
  it('is one line: the title and «Документ», no progress of the writing (14.11.2026)', async () => {
    readDoc.mockResolvedValue(sampleDoc(0))
    show({ onOpen: vi.fn() })
    const card = await screen.findByRole('article', { name: 'Документ «Аудит скорости сайта»' })
    expect(within(card).getByText('Документ')).toBeTruthy()
    expect(within(card).queryByRole('progressbar')).toBeNull()
    // The text is in the tab beside the chat, not in the feed.
    expect(within(card).queryByText('главные')).toBeNull()
  })

  it('opens the document in the tab beside the chat', async () => {
    readDoc.mockResolvedValue(sampleDoc(1))
    const onOpen = vi.fn()
    show({ onOpen })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Открыть документ «Аудит скорости сайта»' }),
    )
    expect(onOpen).toHaveBeenCalledWith(docId)
    expect(screen.getByText('Документ · v1')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('says it is open beside the chat while the tab shows it', async () => {
    readDoc.mockResolvedValue(sampleDoc(0))
    show({ onOpen: vi.fn(), open: true })
    expect(await screen.findByText('Открыт справа')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Открыть документ/ })).toBeNull()
  })

  it('offers the download in the view the agent chose where there is no tab', async () => {
    readDoc.mockResolvedValue(sampleDoc(2, { view: 'page' }))
    show()
    const download = await screen.findByRole('link', { name: 'Скачать .html' })
    expect(download.getAttribute('href')).toBe(`/api/documents/${docId}/markdown`)
  })

  it('reads the document again when a newer change of it comes in the feed', async () => {
    readDoc.mockResolvedValue(sampleDoc(0))
    const { rerender } = show({ revision: 4, onOpen: vi.fn() })
    await screen.findByText('Документ')
    expect(readDoc).toHaveBeenCalledTimes(1)
    readDoc.mockResolvedValue({ ...sampleDoc(1), revision: 5 })
    rerender(5)
    expect(await screen.findByText('Документ · v1')).toBeTruthy()
    expect(readDoc).toHaveBeenCalledTimes(2)
  })
})
