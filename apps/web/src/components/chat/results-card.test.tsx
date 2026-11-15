// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { chatDocumentsOf } from '@repo/domain/tasks/chat-documents'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { docId, sampleDoc } from './doc-test-fixtures'
import { ResultsCard, ResultsToggle } from './results-card'

const { readDoc } = vi.hoisted(() => ({ readDoc: vi.fn() }))

vi.mock('@/trpc/client', async () => (await import('./doc-test-fixtures')).trpcMock({ readDoc }))

const fileId = '0199a3f2-0000-7000-8000-0000000000f1'
const fileRows = [
  {
    id: '5',
    at: '2026-11-14T10:00:00.000Z',
    type: 'feed.file',
    fileId,
    name: 'отчёт.md',
    sizeBytes: 120,
  },
]

function show(props: Partial<Parameters<typeof ResultsCard>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onOpenAgentDoc = vi.fn()
  const onOpenFile = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <ResultsCard
        agentDocs={[docId]}
        documents={chatDocumentsOf(fileRows as never)}
        shownAgentDoc={null}
        onOpenAgentDoc={onOpenAgentDoc}
        onOpenFile={onOpenFile}
        {...props}
      />
    </QueryClientProvider>,
  )
  return { onOpenAgentDoc, onOpenFile }
}

beforeEach(() => vi.clearAllMocks())

describe('«Результаты» beside the chat (14.11.2026)', () => {
  it('names the document being written with how far it is, and opens it', async () => {
    readDoc.mockResolvedValue(sampleDoc(0))
    const { onOpenAgentDoc } = show()
    const card = screen.getByRole('complementary', { name: 'Результаты' })
    const line = await within(card).findByRole('button', {
      name: 'Открыть «Аудит скорости сайта»',
    })
    expect(line.textContent).toContain('пишется · 2 из 3')
    fireEvent.click(line)
    expect(onOpenAgentDoc).toHaveBeenCalledWith(docId)
  })

  it('names a finished document by its version, and a file of the chat too', async () => {
    readDoc.mockResolvedValue(sampleDoc(2))
    const { onOpenFile } = show()
    const line = await screen.findByRole('button', { name: 'Открыть «Аудит скорости сайта»' })
    expect(line.textContent).toContain('v2')
    fireEvent.click(screen.getByRole('button', { name: 'Открыть «отчёт»' }))
    expect(onOpenFile).toHaveBeenCalledWith(fileId)
  })

  it('is hidden and shown by the icon in the head of the chat', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<ResultsToggle shown onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть результаты' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<ResultsToggle shown={false} onToggle={onToggle} />)
    expect(screen.getByRole('button', { name: 'Показать результаты' })).toBeTruthy()
  })
})
