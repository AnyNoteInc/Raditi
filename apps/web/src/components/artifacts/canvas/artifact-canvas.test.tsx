// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CabinetArtifact } from '../use-artifact'
import { ArtifactCanvas } from './artifact-canvas'

// «Холст» in the cabinet (docs/plan/88-artifacts.md, Ар8, Ар49, §7.7; slice 88.15): the board shows
// the screens by their thumbnails, no frame on the overview; a screen is chosen from the keyboard,
// a new screen and a variant are a batch of the person; on a phone the board is a list.

const { frame, write, width } = vi.hoisted(() => ({
  frame: vi.fn(async (input: { mode: string; frame?: string }) => ({
    url: `https://pages.example/v/${input.mode}.${input.frame ?? 'mockup'}`,
    expiresAt: '2026-11-20T10:05:00.000Z',
  })),
  write: vi.fn(async (_input: unknown) => ({
    artifactId: 'a',
    opId: 'x',
    seq: 9,
    blocks: [],
    title: null,
    repeated: false,
  })),
  width: { value: 0 },
}))

const ARTIFACT = '019f1a21-1800-7f00-8abc-000000000001'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    user: {
      me: { queryOptions: () => ({ queryKey: ['me'], queryFn: async () => ({ id: 'u1' }) }) },
    },
    artifact: {
      frame: {
        queryOptions: (input: { mode: string; frame?: string }) => ({
          queryKey: ['artifact.frame', input],
          queryFn: () => frame(input),
        }),
      },
      canvasThumbs: {
        queryOptions: () => ({
          queryKey: ['artifact.canvasThumbs'],
          queryFn: async () => ({
            pending: false,
            thumbs: ['home', 'uslugi'].flatMap((key) =>
              [1440, 390].map((each) => ({
                frame: key,
                width: each,
                url: `/api/artifact-thumbs/${ARTIFACT}/${'a'.repeat(26)}-${each}.jpg`,
              })),
            ),
          }),
        }),
      },
      files: { queryOptions: () => ({ queryKey: ['artifact.files'], queryFn: async () => [] }) },
      fileStart: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      editText: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      write: { mutationOptions: () => ({ mutationFn: write }) },
    },
  }),
}))

class Observer {
  readonly callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe() {
    if (width.value > 0)
      this.callback(
        [{ contentRect: { width: width.value, height: 800 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
  }
  disconnect() {}
}

const block = (
  key: string,
  kind: string,
  parent: string | null,
  props: Record<string, string | number | boolean> = {},
  content = '',
) => ({
  key,
  kind,
  parent,
  props,
  content,
  rank: key,
  rev: 1,
  heading: null,
  checking: false,
  hold: null,
})

const canvas = (): CabinetArtifact => ({
  id: ARTIFACT,
  kind: 'canvas',
  title: 'Сайт пекарни',
  seq: 8,
  role: 'owner',
  version: 1,
  project: null,
  updatedAt: '2026-11-20T10:00:00.000Z',
  blocks: [
    block('home', 'frame', null, { name: 'Главная', x: 0, y: 0 }),
    block('home-html', 'html', 'home', {}, '<h1>Пекарня</h1>'),
    block('uslugi', 'frame', null, { name: 'Услуги', x: 0, y: 2400 }),
    block('uslugi-html', 'html', 'uslugi', {}, '<h1>Услуги</h1>'),
    block('sticky', 'note', null, { x: -400, y: 0 }, 'Позвонить пекарю'),
  ],
})

function show() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ArtifactCanvas artifact={canvas()} presence={null} onChanged={vi.fn()} place="page" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  width.value = 0
  vi.stubGlobal('ResizeObserver', Observer)
  frame.mockClear()
  write.mockClear()
})

describe('«Холст» (slice 88.15)', () => {
  it('shows each screen in two views by its thumbnails, and no frame on the overview', async () => {
    show()
    const board = screen.getByRole('application', { name: /Холст/ })
    const screens = within(board).getAllByTestId('canvas-screen')
    expect(screens).toHaveLength(2)
    await waitFor(() => expect(board.querySelectorAll('img')).toHaveLength(4))
    expect(board.querySelectorAll('iframe')).toHaveLength(0)
    // Each view lies under a cover: the board takes the pointer and the wheel, never the frame.
    expect(board.querySelectorAll('[data-canvas-cover]')).toHaveLength(4)
    expect(screen.getByTestId('canvas-note').textContent).toBe('Позвонить пекарю')
  })

  it('makes the frames in view live once nearer, four at most, each under its cover (spike 6)', async () => {
    width.value = 1200
    show()
    const board = screen.getByRole('application', { name: /Холст/ })
    expect(board.querySelectorAll('iframe')).toHaveLength(0)
    for (let step = 0; step < 8; step += 1) fireEvent.keyDown(board, { key: '+' })
    await waitFor(() => expect(board.querySelectorAll('iframe').length).toBeGreaterThan(0), {
      timeout: 3000,
    })
    expect(board.querySelectorAll('iframe').length).toBeLessThanOrEqual(4)
    for (const iframe of board.querySelectorAll('iframe')) {
      expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
      expect((iframe as HTMLIFrameElement).style.pointerEvents).toBe('none')
    }
  })

  it('chooses a screen from the keyboard and makes a variant of it by one batch', async () => {
    show()
    const board = screen.getByRole('application', { name: /Холст/ })
    fireEvent.keyDown(board, { key: 'ArrowRight' })
    const bar = await screen.findByRole('toolbar', { name: 'Выбранный экран' })
    expect(within(bar).getByText('Главная')).toBeTruthy()
    fireEvent.click(within(bar).getByRole('button', { name: 'Сделать вариант' }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    const { batch } = write.mock.calls[0]![0] as {
      batch: {
        ops: { op: string; kind?: string; parent?: string; props?: Record<string, unknown> }[]
      }
    }
    expect(batch.ops[0]).toMatchObject({ op: 'replace', props: { name: 'Главная', variant: 'А' } })
    expect(batch.ops[1]).toMatchObject({
      op: 'insert',
      kind: 'frame',
      props: { name: 'Главная', variant: 'Б' },
    })
    expect(batch.ops[2]).toMatchObject({
      op: 'insert',
      kind: 'html',
      parent: batch.ops[1] && (batch.ops[1] as { block?: string }).block,
    })
  })

  it('adds a new screen with a part of HTML', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Новый экран' }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    const { batch } = write.mock.calls[0]![0] as { batch: { ops: { kind: string }[] } }
    expect(batch.ops.map((op) => op.kind)).toEqual(['frame', 'html'])
  })

  it('is a list of the phone views on a phone, and a screen opens whole', async () => {
    width.value = 390
    show()
    const list = await screen.findByRole('list', { name: 'Экраны холста' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('application')).toBeNull()
    fireEvent.click(within(list).getByRole('button', { name: 'Открыть: Услуги' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(frame).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'view', frame: 'uslugi' }),
      ),
    )
    expect(within(dialog).getByText('Услуги')).toBeTruthy()
  })
})
