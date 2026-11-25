// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { newSlideHtml, slidesThemeKey } from '@repo/domain/artifacts'

import type { CabinetArtifact } from '../use-artifact'
import { ArtifactSlides, slidesTexts } from './artifact-slides'
import { showStepOf } from './slide-show'

// «Презентация» in the cabinet (docs/plan/93-artifacts-trim.md, АТ8; docs/plan/88-artifacts.md,
// 88.25б): the rail of thumbnails, the chosen slide large under one toolbar, the folded notes, the
// order by the menu of a thumbnail, a new slide on the theme and «Показать».

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

const openNotes = () =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(slidesTexts.notes) }))

const openSlideMenu = (at: number) =>
  fireEvent.click(screen.getByRole('button', { name: slidesTexts.slideMenu(at) }))

describe('«Презентация» in the cabinet', () => {
  it('lists the slides in a rail and shows the chosen one large, under one toolbar', async () => {
    show(deck())
    const rail = screen.getByRole('navigation', { name: slidesTexts.slides })
    const thumbs = within(rail).getAllByRole('button', { name: /^\d+\. / })
    expect(thumbs.map((each) => each.getAttribute('aria-label'))).toEqual(['1. Обложка', '2. Цены'])
    expect(within(rail).getByRole('button', { name: '1. Обложка' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await waitFor(() =>
      expect(frame).toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: ARTIFACT, frame: 'slide1' }),
      ),
    )
    expect(screen.getByText(slidesTexts.position(1, 2, 'Обложка'))).toBeInTheDocument()
    // One toolbar: the frame brings no devices, modes or files of its own.
    expect(screen.queryByRole('group', { name: /устройств|режим/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Код$/ })).not.toBeInTheDocument()
    const bar = screen.getByRole('toolbar', { name: slidesTexts.slides })
    expect(within(bar).getByRole('button', { name: slidesTexts.show })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: slidesTexts.download })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: slidesTexts.add })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: slidesTexts.more })).toBeInTheDocument()
  })

  it('keeps the speaker notes folded, and writes them on leaving the field', async () => {
    const onChanged = show(deck())
    expect(screen.queryByRole('textbox', { name: slidesTexts.notes })).not.toBeInTheDocument()
    openNotes()
    const notes = screen.getByRole('textbox', { name: slidesTexts.notes })
    expect(notes).toHaveValue('Поздоровайтесь.')
    fireEvent.change(notes, { target: { value: 'Поздоровайтесь и назовите себя.' } })
    fireEvent.blur(notes)
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
    openNotes()
    const second = screen.getByRole('textbox', { name: slidesTexts.notes })
    // Leaving without a change writes nothing.
    fireEvent.blur(second)
    expect(write).toHaveBeenCalledTimes(1)
    fireEvent.change(second, { target: { value: 'Назовите цену.' } })
    fireEvent.blur(second)
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write.mock.calls[1]![0]).toMatchObject({
      batch: { ops: [{ op: 'insert', parent: 'slide2', kind: 'note', content: 'Назовите цену.' }] },
    })
  })

  it('moves a slide by the menu of its thumbnail, keeping the theme first', async () => {
    show(deck())
    openSlideMenu(2)
    fireEvent.click(await screen.findByRole('menuitem', { name: slidesTexts.up }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: { ops: [{ op: 'move', block: 'slide2', ifRev: 5, after: 'a-style' }] },
    })
    openSlideMenu(1)
    fireEvent.click(await screen.findByRole('menuitem', { name: slidesTexts.down }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write.mock.calls[1]![0]).toMatchObject({
      batch: { ops: [{ op: 'move', block: 'slide1', ifRev: 3, after: 'slide2' }] },
    })
  })

  it('removes a slide after the person agrees', async () => {
    show(deck())
    openSlideMenu(2)
    fireEvent.click(await screen.findByRole('menuitem', { name: slidesTexts.remove }))
    const dialog = await screen.findByRole('dialog', { name: slidesTexts.removeTitle })
    expect(within(dialog).getByText(slidesTexts.removeBody('Цены'))).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: slidesTexts.remove }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: { ops: [{ op: 'delete', block: 'slide2', ifRev: 5 }] },
    })
  })

  it('adds a slide on the layouts of the theme after the chosen one', async () => {
    show(deck())
    fireEvent.click(screen.getByRole('button', { name: '2. Цены' }))
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.add }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    const ops = (write.mock.calls[0]![0] as { batch: { ops: { content?: string }[] } }).batch.ops
    expect(ops).toMatchObject([
      { op: 'insert', kind: 'frame', after: 'slide2' },
      { op: 'insert', kind: 'html', content: newSlideHtml },
    ])
    expect(ops[1]!.content).toContain('class="slide s-points"')
  })

  it('brings the theme with the first slide of an empty deck', async () => {
    show({ ...deck(), blocks: [] })
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.add }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: {
        ops: [
          { op: 'insert', kind: 'style', block: slidesThemeKey, after: null },
          { op: 'insert', kind: 'frame', after: slidesThemeKey },
          { op: 'insert', kind: 'html' },
        ],
      },
    })
  })

  it('opens «Править текст» and «Файлы» from the menu «⋯»', async () => {
    show(deck())
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.more }))
    fireEvent.click(await screen.findByRole('menuitem', { name: slidesTexts.editText }))
    await waitFor(() =>
      expect(frame).toHaveBeenCalledWith(
        expect.objectContaining({ frame: 'slide1', mode: 'edit' }),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.editDone }))
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.more }))
    fireEvent.click(await screen.findByRole('menuitem', { name: slidesTexts.files }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('shows the slides over the whole screen: keys, clicks, the next one ready', async () => {
    show(deck())
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.show }))
    const dialog = await screen.findByRole('dialog', { name: slidesTexts.show })
    expect(within(dialog).getByText('1 из 2')).toBeInTheDocument()
    // The next slide is asked for before the step: no black between the slides.
    await waitFor(() =>
      expect(frame).toHaveBeenCalledWith(
        expect.objectContaining({ frame: 'slide2', mode: 'view' }),
      ),
    )
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(await within(dialog).findByText('2 из 2')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Home' })
    expect(await within(dialog).findByText('1 из 2')).toBeInTheDocument()
    // A click on the layer over the slide goes forward; on its left third — back.
    fireEvent.click(within(dialog).getByTestId('slide-show-layer'), { clientX: 1000 })
    expect(await within(dialog).findByText('2 из 2')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByTestId('slide-show-layer'), { clientX: 10 })
    expect(await within(dialog).findByText('1 из 2')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: slidesTexts.close }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: slidesTexts.show })).not.toBeInTheDocument(),
    )
  })

  it('knows the keys of the show', () => {
    expect([' ', 'ArrowRight', 'PageDown', 'ArrowDown'].map(showStepOf)).toEqual([
      'next',
      'next',
      'next',
      'next',
    ])
    expect(['ArrowLeft', 'PageUp'].map(showStepOf)).toEqual(['previous', 'previous'])
    expect(['Home', 'End', 'Escape', 'a'].map(showStepOf)).toEqual(['first', 'last', null, null])
  })

  it('asks core for the PDF and the PowerPoint of the slides from «Скачать»', async () => {
    show(deck('view'))
    fireEvent.click(screen.getByRole('button', { name: slidesTexts.download }))
    fireEvent.click(await screen.findByRole('menuitem', { name: slidesTexts.pdf }))
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
    expect(screen.queryByRole('button', { name: slidesTexts.slideMenu(1) })).not.toBeInTheDocument()
    openNotes()
    expect(screen.queryByRole('textbox', { name: slidesTexts.notes })).not.toBeInTheDocument()
    expect(screen.getByText('Поздоровайтесь.')).toBeInTheDocument()
  })
})
