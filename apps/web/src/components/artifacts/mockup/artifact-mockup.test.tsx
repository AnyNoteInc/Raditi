// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CabinetArtifact } from '../use-artifact'
import { ArtifactMockup } from './artifact-mockup'
import { ViewFrame } from './view-frame'

// «Макет» in the cabinet (docs/plan/88-artifacts.md, §7.7, Ар9, Ар28, Ар29; slice 88.13): the frame
// of the root of the pages with `allow-scripts` alone, its code to read, «Настройки» saved as a
// replace of the JSON, and the bridge — a link opens only after the person agrees, and only the
// frame's own window is heard.

const { frame, write } = vi.hoisted(() => ({
  frame: vi.fn(async (input: { mode: string }) => ({
    url: `https://pages.example/v/${input.mode}.token`,
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
}))

const ARTIFACT = '019f1a21-1800-7f00-8abc-000000000001'

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: {
      frame: {
        queryOptions: (input: { mode: string }) => ({
          queryKey: ['artifact.frame', input],
          queryFn: () => frame(input),
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
  observe() {}
  disconnect() {}
}

const mockup = (): CabinetArtifact => ({
  id: ARTIFACT,
  kind: 'mockup',
  title: 'Калькулятор',
  seq: 8,
  role: 'owner',
  version: 1,
  project: null,
  updatedAt: '2026-11-20T10:00:00.000Z',
  blocks: [
    {
      key: 'b1',
      kind: 'style',
      rank: 'a',
      rev: 1,
      heading: null,
      content: 'h1{}',
      checking: false,
      hold: null,
    },
    {
      key: 'b2',
      kind: 'html',
      rank: 'b',
      rev: 1,
      heading: null,
      content: '<h1>Цена</h1>',
      checking: false,
      hold: null,
    },
    {
      key: 'b3',
      kind: 'settings',
      rank: 'c',
      rev: 2,
      heading: null,
      content: '{"pricePerSquareMeter":6500,"note":"Замер бесплатно","dark":false,"list":[1]}',
      checking: false,
      hold: null,
    },
  ],
})

function show(value: CabinetArtifact) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const changed = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <ArtifactMockup artifact={value} presence={null} onChanged={changed} place="page" />
    </QueryClientProvider>,
  )
  return { changed }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', Observer)
  frame.mockClear()
  write.mockClear()
})

describe('«Макет» (slice 88.13)', () => {
  it('shows the mockup in a frame of the root of the pages with scripts alone', async () => {
    show(mockup())
    const iframe = await screen.findByTitle('Макет «Калькулятор»')
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('src')).toBe('https://pages.example/v/view.token')
    expect(screen.getByRole('button', { name: 'Компьютер, 1440' })).toHaveProperty(
      'ariaPressed',
      'true',
    )
  })

  it('opens the edit frame without scripts for «Править текст»', async () => {
    show(mockup())
    fireEvent.click(screen.getByRole('button', { name: 'Править текст' }))
    const iframe = await screen.findByTitle('Макет «Калькулятор» для правки текста')
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(iframe.getAttribute('src')).toBe('https://pages.example/v/edit.token')
    expect(screen.getByText(/В режиме правки скрипты макета выключены/)).toBeTruthy()
  })

  it('shows the code to read only', () => {
    show(mockup())
    fireEvent.click(screen.getByRole('button', { name: 'Код' }))
    expect(screen.getByRole('region', { name: 'HTML' }).textContent).toContain('<h1>Цена</h1>')
    expect(screen.queryByRole('textbox', { name: 'HTML' })).toBeNull()
  })

  it('saves «Настройки» as a replace of the JSON under the revision read, keeping the rest', async () => {
    const { changed } = show(mockup())
    const price = screen.getByRole('textbox', { name: 'pricePerSquareMeter' })
    fireEvent.change(price, { target: { value: '7200,5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    const batch = (
      write.mock.calls[0]![0] as { batch: { ops: { content: string; ifRev: number }[] } }
    ).batch
    expect(batch.ops[0]!.ifRev).toBe(2)
    expect(JSON.parse(batch.ops[0]!.content)).toEqual({
      pricePerSquareMeter: 7200.5,
      note: 'Замер бесплатно',
      dark: false,
      list: [1],
    })
    await waitFor(() => expect(changed).toHaveBeenCalled())
  })
})

describe('the bridge (Ар28, Ар29)', () => {
  it('opens a link only after the person agrees, and only from the frame’s own window', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<ViewFrame src="about:blank" width={390} scale={1} title="Макет" />)
    const iframe = screen.getByTitle('Макет') as HTMLIFrameElement
    // Another window says the same: nothing happens.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { bridge: 'raditi-artifact', type: 'link', href: 'https://evil.example/' },
        source: window,
      }),
    )
    expect(screen.queryByText('Открыть ссылку?')).toBeNull()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { bridge: 'raditi-artifact', type: 'link', href: 'https://example.com/zakaz' },
        source: iframe.contentWindow,
      }),
    )
    expect(await screen.findByText('Открыть ссылку?')).toBeTruthy()
    expect(screen.getByTestId('mockup-link-address').textContent).toBe('https://example.com/zakaz')
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть' }))
    expect(open).toHaveBeenCalledWith('https://example.com/zakaz', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })

  it('takes a height measured at the width of the view, and refuses `javascript:`', async () => {
    render(<ViewFrame src="about:blank" width={390} scale={1} title="Макет" />)
    const iframe = screen.getByTitle('Макет') as HTMLIFrameElement
    const say = (data: unknown) =>
      window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }))
    say({ bridge: 'raditi-artifact', type: 'size', height: 3000, width: 1440 })
    expect(iframe.style.height).toBe('844px')
    say({ bridge: 'raditi-artifact', type: 'size', height: 1500, width: 390 })
    await waitFor(() => expect(iframe.style.height).toBe('1500px'))
    say({ bridge: 'raditi-artifact', type: 'link', href: 'javascript:alert(1)' })
    expect(screen.queryByText('Открыть ссылку?')).toBeNull()
  })
})
