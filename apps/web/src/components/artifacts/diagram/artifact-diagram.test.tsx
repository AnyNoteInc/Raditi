// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CabinetArtifact } from '../use-artifact'
import { ArtifactDiagram, diagramTexts } from './artifact-diagram'

// «Схема» in the cabinet (docs/plan/88-artifacts.md, §7.7, §7.13, 88.24в): the server's picture as
// <img>, the line of an error with the text, the text written with its revision.

const ARTIFACT = '019f1a21-1800-7f00-8abc-0000000000d1'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"/>'

const { diagram, write } = vi.hoisted(() => ({
  diagram: vi.fn(async (_input: unknown): Promise<unknown> => ({ state: 'drawing' })),
  write: vi.fn(async (_input: unknown) => ({ seq: 2 })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: {
      diagram: {
        queryOptions: (input: unknown) => ({
          queryKey: ['diagram', input],
          queryFn: () => diagram(input),
        }),
      },
      write: { mutationOptions: () => ({ mutationFn: write }) },
    },
  }),
}))

const text = 'flowchart LR\n  A[Заявка] --> B[Счёт]\n  B --> ((('

function artifactOf(
  content: string | null,
  role: CabinetArtifact['role'] = 'owner',
): CabinetArtifact {
  return {
    id: ARTIFACT,
    kind: 'diagram',
    title: 'Путь клиента',
    seq: 1,
    role,
    version: 1,
    project: null,
    updatedAt: '2026-11-22T10:00:00.000Z',
    blocks:
      content === null
        ? []
        : [
            {
              key: 'd1',
              kind: 'diagram',
              parent: null,
              rank: '01',
              props: {},
              rev: 3,
              heading: null,
              content,
              checking: false,
              hold: null,
            },
          ],
  } as CabinetArtifact
}

function show(artifact: CabinetArtifact, onChanged = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ArtifactDiagram
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
  diagram.mockReset()
  write.mockClear()
})

describe('«Схема» in the cabinet', () => {
  it('shows the picture the server drew as an image of its own size, never Mermaid', async () => {
    diagram.mockResolvedValue({ state: 'drawn', svg: SVG, width: 320, height: 120 })
    show(artifactOf('flowchart LR\n  A --> B'))
    const picture = await screen.findByRole('img', { name: 'Путь клиента' })
    expect(picture).toHaveAttribute('width', '320')
    expect(picture.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(diagram).toHaveBeenCalledWith({ artifactId: ARTIFACT, block: 'd1', rev: 3 })
    expect(screen.getByRole('button', { name: diagramTexts.svg })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: diagramTexts.png })).toBeInTheDocument()
  })

  it('names the line of an error and marks it in the text', async () => {
    diagram.mockResolvedValue({ state: 'failed', line: 3 })
    show(artifactOf(text))
    expect(await screen.findByText('Схема не нарисована: ошибка в строке 3')).toBeInTheDocument()
    const marked = document.querySelector('[data-error="true"]')
    expect(marked?.textContent).toBe('  B --> (((')
  })

  it('writes the text with its revision, and lets a reader only look', async () => {
    diagram.mockResolvedValue({ state: 'failed', line: 3 })
    const onChanged = show(artifactOf(text))
    fireEvent.click(await screen.findByRole('button', { name: diagramTexts.edit }))
    fireEvent.change(screen.getByRole('textbox', { name: diagramTexts.text }), {
      target: { value: 'flowchart LR\n  A --> B' },
    })
    fireEvent.click(screen.getByRole('button', { name: diagramTexts.save }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: {
        artifactId: ARTIFACT,
        ops: [{ op: 'replace', block: 'd1', ifRev: 3, content: 'flowchart LR\n  A --> B' }],
      },
    })
  })

  it('starts an empty diagram by its text, and shows a reader no editing', async () => {
    show(artifactOf(null))
    fireEvent.click(screen.getByRole('button', { name: diagramTexts.write }))
    fireEvent.change(screen.getByRole('textbox', { name: diagramTexts.text }), {
      target: { value: 'flowchart LR\n  A --> B' },
    })
    fireEvent.click(screen.getByRole('button', { name: diagramTexts.save }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: { ops: [{ op: 'insert', after: null, kind: 'diagram' }] },
    })
  })

  it('gives a reader of «Смотрит» no editing', async () => {
    diagram.mockResolvedValue({ state: 'drawn', svg: SVG, width: 320, height: 120 })
    show(artifactOf('flowchart LR\n  A --> B', 'view'))
    await screen.findByRole('img', { name: 'Путь клиента' })
    expect(screen.queryByRole('button', { name: diagramTexts.edit })).not.toBeInTheDocument()
  })
})
