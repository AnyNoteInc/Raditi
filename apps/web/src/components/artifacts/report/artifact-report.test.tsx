// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CabinetArtifact } from '../use-artifact'
import { ArtifactReport, reportTexts } from './artifact-report'

// «Отчёт» in the cabinet (docs/plan/88-artifacts.md, §7.7, 88.28): sections, charts drawn on the
// server shown as images, and the table, in the order of the blocks.

const ARTIFACT = '019f1a21-1800-7f00-8abc-0000000000c9'

const { write, chart } = vi.hoisted(() => ({
  write: vi.fn(async (_input: unknown) => ({ seq: 2 })),
  chart: vi.fn(async (_input: unknown): Promise<unknown> => ({
    state: 'drawn',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360"/>',
    width: 720,
    height: 360,
  })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: {
      write: { mutationOptions: () => ({ mutationFn: write }) },
      chart: {
        queryOptions: (input: unknown) => ({
          queryKey: ['chart', input],
          queryFn: () => chart(input),
        }),
      },
    },
  }),
}))

const block = (
  key: string,
  kind: string,
  content: string,
  heading: string | null = null,
  rev = 1,
) => ({
  key,
  kind,
  parent: null,
  rank: key,
  props: heading ? { heading } : {},
  rev,
  heading,
  content,
  checking: false,
  hold: null,
})

function report(role: CabinetArtifact['role'] = 'owner'): CabinetArtifact {
  return {
    id: ARTIFACT,
    kind: 'report',
    title: 'Отчёт о продажах',
    seq: 2,
    role,
    version: 1,
    project: null,
    updatedAt: '2026-11-22T10:00:00.000Z',
    blocks: [
      block('a', 'section', 'Выручка выросла на **12 %**.', 'Итоги', 3),
      block('b', 'chart', '{"type":"bar"}'),
      block('c', 'columns', JSON.stringify([{ key: 'item', name: 'Товар', type: 'text' }])),
      block('d', 'row', JSON.stringify({ item: 'Хлеб' })),
    ],
  } as CabinetArtifact
}

function show(artifact: CabinetArtifact, onChanged = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ArtifactReport
        artifact={artifact}
        presence={null}
        onChanged={onChanged}
        onAccessLost={vi.fn()}
        place="page"
      />
    </QueryClientProvider>,
  )
  return onChanged
}

beforeEach(() => {
  write.mockClear()
  chart.mockClear()
})

describe('«Отчёт» in the cabinet', () => {
  it('shows the sections, the chart the server drew and the table in their order', async () => {
    show(report())
    expect(screen.getByRole('heading', { name: 'Итоги' })).toBeInTheDocument()
    expect(screen.getByText('12 %')).toBeInTheDocument()
    // A chart is decoration of the text around it: an image without a name.
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    expect(document.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(chart).toHaveBeenCalledWith({ artifactId: ARTIFACT, block: 'b', rev: 1 })
    expect(screen.getByRole('columnheader', { name: 'Товар' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Хлеб' })).toBeInTheDocument()
  })

  it('says a chart was not drawn, and writes a section with its revision', async () => {
    chart.mockResolvedValueOnce({ state: 'failed' })
    const onChanged = show(report())
    expect(await screen.findByText(reportTexts.chartFailed)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: reportTexts.edit }))
    fireEvent.change(screen.getByRole('textbox', { name: reportTexts.text }), {
      target: { value: 'Выручка выросла на 15 %.' },
    })
    fireEvent.click(screen.getByRole('button', { name: reportTexts.save }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: {
        ops: [
          {
            op: 'replace',
            block: 'a',
            ifRev: 3,
            content: 'Выручка выросла на 15 %.',
            props: { heading: 'Итоги' },
          },
        ],
      },
    })
  })

  it('lets a reader only read', () => {
    show(report('view'))
    expect(screen.queryByRole('button', { name: reportTexts.edit })).not.toBeInTheDocument()
  })
})
