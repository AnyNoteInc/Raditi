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
    url: `https://pages.example/v/${input.mode}.${input.frame ?? 'screen'}`,
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
vi.mock('@/trpc/client', async () => {
  const { notesTrpcMock } = await import('../notes-trpc.testing')
  const notes = notesTrpcMock()
  return {
    useTRPC: () => ({
      user: {
        me: { queryOptions: () => ({ queryKey: ['me'], queryFn: async () => ({ id: 'u1' }) }) },
      },
      artifact: {
        ...notes.artifact,
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
    useTRPCClient: () => ({ artifact: notes.client }),
  }
})

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

/** A calculator: one screen and the settings its script reads (АТ6). */
const calculator = (): CabinetArtifact => ({
  ...canvas(),
  title: 'Калькулятор',
  blocks: [
    block('prices', 'settings', null, {}, '{"pricePerSquareMeter":6500}'),
    block('home', 'frame', null, { name: 'Калькулятор', path: '/', x: 0, y: 0 }),
    block('home-html', 'html', 'home', {}, '<h1>Цена</h1>'),
  ],
})

function show(value: CabinetArtifact = canvas()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ArtifactCanvas artifact={value} presence={null} onChanged={vi.fn()} place="page" />
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
    // «Открыть» is the one action in sight; the rest is in «⋯».
    expect(
      within(bar)
        .getAllByRole('button')
        .map((each) => each.textContent),
    ).toEqual(['Открыть', ''])
    fireEvent.click(within(bar).getByRole('button', { name: 'Ещё: Главная' }))
    expect(screen.getByRole('menuitem', { name: 'Изменить в чате' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Сделать вариант' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Добавить экран' }))
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
    // The screen stands in place of the list, no window over the page; «Все экраны» goes back.
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() =>
      expect(frame).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'view', frame: 'uslugi' }),
      ),
    )
    const bar = screen.getByRole('toolbar', { name: 'Действия с экраном' })
    expect(within(bar).getByText('Услуги')).toBeTruthy()
    // A phone: the phone view first.
    expect(screen.getByRole('button', { name: 'Телефон, 390' })).toHaveProperty(
      'ariaPressed',
      'true',
    )
    fireEvent.click(within(bar).getByRole('button', { name: 'Все экраны' }))
    expect(await screen.findByRole('list', { name: 'Экраны холста' })).toBeTruthy()
  })

  it('keeps a light board header: tools, «Добавить экран», the zoom, and «⋯»', async () => {
    width.value = 1200
    show()
    const header = screen.getByRole('toolbar', { name: 'Холст: действия' })
    const tools = within(header).getByRole('group', { name: 'Инструменты холста' })
    expect(
      within(tools)
        .getAllByRole('button')
        .map((each) => each.getAttribute('aria-label')),
    ).toEqual(['Выбор', 'Стикер', 'Стикер на экране'])
    expect(within(header).queryByRole('button', { name: 'Весь холст' })).toBeNull()
    const surface = screen.getByTestId('canvas-surface')
    fireEvent.click(within(header).getByRole('button', { name: 'Крупнее' }))
    const before = surface.style.transform
    fireEvent.click(within(header).getByRole('button', { name: /^Масштаб:/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Весь холст' }))
    await waitFor(() => expect(surface.style.transform).not.toBe(before))
    fireEvent.click(within(header).getByRole('button', { name: 'Ещё' }))
    expect(await screen.findByRole('menuitem', { name: 'Файлы' })).toBeTruthy()
    // No settings block: no «Настройки».
    expect(screen.queryByRole('menuitem', { name: 'Настройки' })).toBeNull()
  })

  it('opens a screen in place of the board, and «Все экраны» brings the board back', async () => {
    width.value = 1200
    show()
    const board = screen.getByRole('application', { name: /Холст/ })
    fireEvent.keyDown(board, { key: 'ArrowRight' })
    fireEvent.keyDown(board, { key: 'Enter' })
    expect(await screen.findByTitle('Экран «Сайт пекарни»')).toBeTruthy()
    expect(screen.queryByRole('application')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Все экраны' }))
    expect(screen.getByRole('application', { name: /Холст/ })).toBeTruthy()
  })
})

describe('«Холст» of one screen (АТ6)', () => {
  it('opens straight on the live screen with «Настройки» beside it', async () => {
    width.value = 1200
    show(calculator())
    expect(screen.queryByRole('application')).toBeNull()
    const iframe = await screen.findByTitle('Экран «Калькулятор»')
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame).toHaveBeenCalledWith(expect.objectContaining({ mode: 'view', frame: 'home' }))
    expect(screen.getByRole('button', { name: 'Компьютер, 1440' })).toHaveProperty(
      'ariaPressed',
      'true',
    )
    expect(screen.getByRole('complementary', { name: 'Настройки' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'pricePerSquareMeter' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Добавить экран' })).toBeTruthy()
  })

  it('shows the board on «Экраны», with «Настройки» in its «⋯»', async () => {
    width.value = 1200
    show(calculator())
    fireEvent.click(screen.getByRole('button', { name: 'Экраны' }))
    const board = screen.getByRole('application', { name: /Холст/ })
    expect(within(board).getAllByTestId('canvas-screen')).toHaveLength(1)
    const header = screen.getByRole('toolbar', { name: 'Холст: действия' })
    fireEvent.click(within(header).getByRole('button', { name: 'Ещё' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Настройки' }))
    expect(await screen.findByRole('textbox', { name: 'pricePerSquareMeter' })).toBeTruthy()
  })

  it('grows into a board when a screen is added', async () => {
    width.value = 1200
    show(calculator())
    fireEvent.click(screen.getByRole('button', { name: 'Добавить экран' }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    const { batch } = write.mock.calls[0]![0] as { batch: { ops: { kind: string }[] } }
    expect(batch.ops.map((op) => op.kind)).toEqual(['frame', 'html'])
  })
})
