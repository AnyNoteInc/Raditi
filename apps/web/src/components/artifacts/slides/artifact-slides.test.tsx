// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CabinetArtifact } from '../use-artifact'
import { ArtifactSlides, slidesTexts } from './artifact-slides'

// «Презентация» in the cabinet (docs/plan/88-artifacts.md, §7.7, 88.25б): the strip of slides by
// their thumbnails, the chosen one large, its notes, the order, a new slide and «Показать».

const ARTIFACT = '019f1a21-1800-7f00-8abc-0000000000e1'

const { write, frame, exportStart } = vi.hoisted(() => ({
  exportStart: vi.fn(async (_input: unknown) => ({
    exportId: '019f1a21-1800-7f00-8abc-0000000000f1',
  })),
  write: vi.fn(async (_input: unknown) => ({ seq: 2 })),
  frame: vi.fn(async (_input: unknown) => ({
    url: 'https://pages.test/v/token',
    expiresAt: '2026-11-22T11:00:00.000Z',
  })),
}))

vi.mock('@/trpc/client', async () => {
  const { notesTrpcMock } = await import('../notes-trpc.testing')
  const notes = notesTrpcMock(vi.fn())
  return {
    useTRPC: () => ({
      artifact: {
        ...notes.artifact,
        write: { mutationOptions: () => ({ mutationFn: write }) },
        exportStart: { mutationOptions: () => ({ mutationFn: exportStart }) },
        editText: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
        files: { queryOptions: () => ({ queryKey: ['artifact.files'], queryFn: async () => [] }) },
        fileStart: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
        frame: {
          queryOptions: (input: unknown) => ({
            queryKey: ['frame', input],
            queryFn: () => frame(input),
          }),
        },
        canvasThumbs: {
          queryOptions: (input: unknown) => ({
            queryKey: ['thumbs', input],
            queryFn: async () => ({
              thumbs: [
                { frame: 'slide1', width: 1280, url: '/api/artifact-thumbs/x/a-1280.jpg' },
                { frame: 'slide2', width: 1280, url: null },
              ],
              pending: false,
            }),
          }),
        },
      },
    }),
    useTRPCClient: () => ({
      artifact: { ...notes.client, exportStatus: { query: async () => ({ state: 'ready' }) } },
    }),
  }
})

const block = (
  key: string,
  kind: string,
  parent: string | null,
  content: string | null,
  props: Record<string, string> = {},
  rev = 1,
) => ({
  key,
  kind,
  parent,
  rank: key,
  props,
  rev,
  heading: null,
  content,
  checking: false,
  hold: null,
})

function deck(role: CabinetArtifact['role'] = 'owner'): CabinetArtifact {
  return {
    id: ARTIFACT,
    kind: 'slides',
    title: 'Презентация компании',
    seq: 4,
    role,
    version: 1,
    project: null,
    updatedAt: '2026-11-22T10:00:00.000Z',
    blocks: [
      block('a-style', 'style', null, 'body{}'),
      block('slide1', 'frame', null, '', { name: 'Обложка' }, 3),
      block('slide1-html', 'html', 'slide1', '<section>Обложка</section>'),
      block('slide1-note', 'note', 'slide1', 'Поздоровайтесь.', {}, 2),
      block('slide2', 'frame', null, '', { name: 'Цены' }, 5),
      block('slide2-html', 'html', 'slide2', '<section>Цены</section>'),
    ],
  } as CabinetArtifact
}

function show(artifact: CabinetArtifact, onChanged = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ArtifactSlides
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

class Observer {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', Observer)
  write.mockClear()
  frame.mockClear()
})

describe('«Презентация» in the cabinet', () => {
  it('lists the slides by their thumbnails and shows the chosen one at 1280×720', async () => {
    show(deck())
    const strip = screen.getByRole('navigation', { name: slidesTexts.slides })
    expect(
      within(strip)
        .getAllByRole('button')
        .map((each) => each.getAttribute('aria-label')),
    ).toEqual(['1. Обложка', '2. Цены'])
    expect(within(strip).getByRole('button', { name: '1. Обложка' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await waitFor(() =>
      expect(frame).toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: ARTIFACT, frame: 'slide1' }),
      ),
    )
    expect(screen.getByRole('textbox', { name: slidesTexts.notes })).toHaveValue('Поздоровайтесь.')
    // No choice of a device for a slide.
    expect(screen.queryByRole('group', { name: /устройств/i })).not.toBeInTheDocument()
  })

  it('writes the notes of a slide with their revision, and adds the first ones', async () => {
    const onChanged = show(deck())
    fireEvent.change(screen.getByRole('textbox', { name: slidesTexts.notes }), {
      target: { value: 'Поздоровайтесь и назовите себя.' },
    })
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.save }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: {
        ops: [
          {
            op: 'replace',
            block: 'slide1-note',
            ifRev: 2,
            content: 'Поздоровайтесь и назовите себя.',
          },
        ],
      },
    })
    fireEvent.click(screen.getByRole('button', { name: '2. Цены' }))
    fireEvent.change(screen.getByRole('textbox', { name: slidesTexts.notes }), {
      target: { value: 'Назовите цену.' },
    })
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.save }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write.mock.calls[1]![0]).toMatchObject({
      batch: { ops: [{ op: 'insert', parent: 'slide2', kind: 'note', content: 'Назовите цену.' }] },
    })
  })

  it('moves a slide by its revision and adds a new one after the chosen', async () => {
    show(deck())
    fireEvent.click(screen.getByRole('button', { name: '2. Цены' }))
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.up }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: { ops: [{ op: 'move', block: 'slide2', ifRev: 5, after: null }] },
    })
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.add }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write.mock.calls[1]![0]).toMatchObject({
      batch: {
        ops: [
          { op: 'insert', kind: 'frame', after: 'slide2' },
          { op: 'insert', kind: 'html' },
        ],
      },
    })
  })

  it('shows the slides over the whole screen, by the arrows', async () => {
    show(deck())
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.show }))
    const dialog = await screen.findByRole('dialog', { name: slidesTexts.show })
    expect(within(dialog).getByText('1 из 2')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(await within(dialog).findByText('2 из 2')).toBeInTheDocument()
    await waitFor(() =>
      expect(frame).toHaveBeenCalledWith(
        expect.objectContaining({ frame: 'slide2', mode: 'view' }),
      ),
    )
  })

  it('asks core for the PDF and the PPTX of the slides', async () => {
    show(deck('view'))
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.pdf }))
    await waitFor(() =>
      expect(exportStart).toHaveBeenCalledWith(
        { artifactId: ARTIFACT, format: 'pdf' },
        expect.anything(),
      ),
    )
  })

  it('lets a reader look and show, never change', () => {
    show(deck('view'))
    expect(screen.getByRole('button', { name: slidesTexts.show })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: slidesTexts.add })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: slidesTexts.notes })).not.toBeInTheDocument()
    expect(screen.getByText('Поздоровайтесь.')).toBeInTheDocument()
  })
})
