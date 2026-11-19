// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { chatDocumentsOf } from '@repo/domain/tasks/chat-documents'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { docId, sampleDoc } from './doc-test-fixtures'
import { ResultsCard, ResultsToggle, useResultsCard } from './results-card'

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

  it('leaves the column room for «План работы» standing over it', () => {
    readDoc.mockResolvedValue(sampleDoc(2))
    show()
    const card = screen.getByRole('complementary', { name: 'Результаты' })
    // jsdom resolves the units against its window: min(60vh, 480px), then min(40vh, 320px).
    const of = (vh: number, most: number) => `${Math.min((vh * window.innerHeight) / 100, most)}px`
    expect(getComputedStyle(card).maxHeight).toBe(of(60, 480))
    cleanup()
    show({ underPlan: true })
    expect(
      getComputedStyle(screen.getByRole('complementary', { name: 'Результаты' })).maxHeight,
    ).toBe(of(40, 320))
  })

  // The column holds «План работы» too (docs/plan/87-agent-todos.md, ТД6, §6.1).
  it.each([
    ['plan', 'Скрыть план работы', 'Показать план работы'],
    ['both', 'Скрыть план и результаты', 'Показать план и результаты'],
    ['results', 'Скрыть результаты', 'Показать результаты'],
  ] as const)('names what the column holds — %s', (holds, hide, show) => {
    const { rerender } = render(<ResultsToggle shown onToggle={() => undefined} holds={holds} />)
    expect(screen.getByRole('button', { name: hide })).toHaveAttribute('aria-pressed', 'true')
    rerender(<ResultsToggle shown={false} onToggle={() => undefined} holds={holds} />)
    expect(screen.getByRole('button', { name: show })).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('the column beside the chat', () => {
  /** The area of the feed as wide as `width`: the observer reports it at once. */
  function feedOfWidth(width: number) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly report: () => void
        constructor(report: () => void) {
          this.report = report
        }
        observe() {
          this.report()
        }
        disconnect() {}
        unobserve() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  }

  let column: ReturnType<typeof useResultsCard>
  function Area({ enabled }: { enabled: boolean }) {
    const area = useRef<HTMLDivElement>(null)
    column = useResultsCard(area, enabled)
    return <div ref={area} />
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('is measured before it says whether it fits', () => {
    feedOfWidth(1200)
    const { rerender } = render(<Area enabled={false} />)
    expect(column).toMatchObject({ fits: false, measured: false, shown: false })
    rerender(<Area enabled />)
    expect(column).toMatchObject({ fits: true, measured: true, shown: true })
  })

  it('waits for a new reading each time it is wanted, not for a frame on the one before', () => {
    // An observer that reports only when told, over a feed whose width the test sets.
    let report = () => {}
    let width = 1200
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          report = callback
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
    const drawn: { fits: boolean; measured: boolean }[] = []
    function Watched({ enabled }: { enabled: boolean }) {
      const area = useRef<HTMLDivElement>(null)
      const { fits, measured } = useResultsCard(area, enabled)
      drawn.push({ fits, measured })
      return <div ref={area} />
    }
    const { rerender } = render(<Watched enabled />)
    act(() => report())
    expect(drawn.at(-1)).toEqual({ fits: true, measured: true })
    rerender(<Watched enabled={false} />)
    expect(drawn.at(-1)).toEqual({ fits: false, measured: false })
    // Wanted again over a feed that is narrow now: no drawing says it fits before the reading.
    width = 900
    drawn.length = 0
    rerender(<Watched enabled />)
    expect(drawn).toContainEqual({ fits: false, measured: false })
    expect(drawn.every((one) => !one.fits && !one.measured)).toBe(true)
    act(() => report())
    expect(drawn.at(-1)).toEqual({ fits: false, measured: true })
  })

  it('does not fit a narrow feed, which it says once measured', () => {
    feedOfWidth(900)
    render(<Area enabled />)
    expect(column).toMatchObject({ fits: false, measured: true, shown: false })
  })

  it('keeps the choice to hide it under a key of its own, not that of «Результаты» alone', () => {
    feedOfWidth(1200)
    // Who once hid «Результаты» still sees the plan (ТД6).
    window.localStorage.setItem('raditi.chat.results.hidden', '1')
    const { unmount } = render(<Area enabled />)
    expect(column.shown).toBe(true)
    act(() => column.toggle())
    expect(column).toMatchObject({ hidden: true, shown: false })
    expect(window.localStorage.getItem('raditi.chat.side.hidden')).toBe('1')
    unmount()
    render(<Area enabled />)
    expect(column).toMatchObject({ hidden: true, shown: false })
  })
})
