// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CabinetArtifact } from '../use-artifact'
import { ArtifactFrame, type ArtifactFrameProps } from './artifact-frame'
import { ViewFrame } from './view-frame'

// A screen of a canvas in the cabinet (docs/plan/93-artifacts-trim.md, АТ6, АТ7;
// docs/plan/88-artifacts.md, §7.7, Ар9, Ар28, Ар29): the frame of the root of the pages with `allow-scripts` alone, its code to read, «Настройки» saved as a
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

vi.mock('@/trpc/client', async () => {
  const { notesTrpcMock } = await import('../notes-trpc.testing')
  const notes = notesTrpcMock()
  return {
    useTRPC: () => ({
      artifact: {
        ...notes.artifact,
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
    useTRPCClient: () => ({ artifact: notes.client }),
  }
})

class Observer {
  observe() {}
  disconnect() {}
}

const calculator = (): CabinetArtifact => ({
  id: ARTIFACT,
  kind: 'canvas',
  title: 'Калькулятор',
  seq: 8,
  role: 'owner',
  version: 1,
  project: null,
  updatedAt: '2026-11-20T10:00:00.000Z',
  blocks: [
    {
      key: 'b3',
      kind: 'settings',
      parent: null,
      rank: 'a',
      props: {},
      rev: 2,
      heading: null,
      content: '{"pricePerSquareMeter":6500,"note":"Замер бесплатно","dark":false,"list":[1]}',
      checking: false,
      hold: null,
    },
    {
      key: 'calc',
      kind: 'frame',
      parent: null,
      rank: 'b',
      props: { name: 'Калькулятор', path: '/', x: 0, y: 0 },
      rev: 1,
      heading: null,
      content: null,
      checking: false,
      hold: null,
    },
    {
      key: 'b1',
      kind: 'style',
      parent: 'calc',
      rank: 'a',
      props: {},
      rev: 1,
      heading: null,
      content: 'h1{}',
      checking: false,
      hold: null,
    },
    {
      key: 'b2',
      kind: 'html',
      parent: 'calc',
      rank: 'b',
      props: {},
      rev: 1,
      heading: null,
      content: '<h1>Цена</h1>',
      checking: false,
      hold: null,
    },
  ],
})

type Shown = Partial<ArtifactFrameProps> & { key?: string }

function show(value: CabinetArtifact, extra: Shown = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const changed = vi.fn()
  const view = ({ key, ...props }: Shown) => (
    <QueryClientProvider client={queryClient}>
      <ArtifactFrame
        key={key}
        artifact={value}
        presence={null}
        onChanged={changed}
        place="page"
        frame="calc"
        {...props}
      />
    </QueryClientProvider>
  )
  const { rerender } = render(view(extra))
  return { changed, rerender: (props: Shown) => rerender(view(props)) }
}

/** A canvas whose settings hold nothing the form shows. */
const withoutFields = (): CabinetArtifact => {
  const value = calculator()
  return {
    ...value,
    blocks: value.blocks.map((block) =>
      block.kind === 'settings' ? { ...block, content: '{"list":[1]}' } : block,
    ),
  }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', Observer)
  frame.mockClear()
  write.mockClear()
})

describe('a screen of a canvas (АТ7)', () => {
  it('shows the screen in a frame of the root of the pages with scripts alone', async () => {
    show(calculator())
    const iframe = await screen.findByTitle('Экран «Калькулятор»')
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('src')).toBe('https://pages.example/v/view.token')
    expect(screen.getByRole('button', { name: 'Компьютер, 1440' })).toHaveProperty(
      'ariaPressed',
      'true',
    )
    // Two devices, the ones the board and the layout check know; no hint row while only viewing.
    expect(
      screen.getByRole('group', { name: 'Устройство' }).querySelectorAll('button'),
    ).toHaveLength(2)
    expect(screen.queryByTestId('frame-hint')).toBeNull()
  })

  it('opens the edit frame without scripts for «Править текст»', async () => {
    show(calculator())
    fireEvent.click(screen.getByRole('button', { name: 'Править текст' }))
    const iframe = await screen.findByTitle('Экран «Калькулятор» для правки текста')
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(iframe.getAttribute('src')).toBe('https://pages.example/v/edit.token')
    expect(screen.getByTestId('frame-hint').textContent).toMatch(
      /кнопки и расчёты на экране не работают/,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Править текст' }))
    await screen.findByTitle('Экран «Калькулятор»')
    expect(screen.queryByTestId('frame-hint')).toBeNull()
  })

  it('keeps the code and the choice of an element in «⋯», each with its way back', async () => {
    show(calculator())
    expect(screen.queryByRole('button', { name: 'Код' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Показать код' }))
    expect(screen.getByRole('region', { name: 'HTML' }).textContent).toContain('<h1>Цена</h1>')
    expect(screen.queryByRole('textbox', { name: 'HTML' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Вернуться к экрану' }))
    expect(screen.queryByRole('region', { name: 'HTML' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Выбрать элемент для заметки' }))
    await screen.findByTitle('Экран «Калькулятор» для правки текста')
    expect(screen.getByTestId('frame-hint').textContent).toMatch(/оставить заметку/)
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    await screen.findByTitle('Экран «Калькулятор»')
  })

  it('opens «Файлы» from «⋯»', async () => {
    show(calculator())
    fireEvent.click(screen.getByRole('button', { name: 'Ещё' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Файлы' }))
    expect(await screen.findByRole('dialog', { name: 'Файлы артефакта' })).toBeTruthy()
  })

  it('opens «Настройки» beside the screen when they have fields, and folds them', () => {
    show(calculator())
    expect(screen.getByRole('complementary', { name: 'Настройки' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }))
    expect(screen.queryByRole('complementary', { name: 'Настройки' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }))
    expect(screen.getByRole('complementary', { name: 'Настройки' })).toBeTruthy()
  })

  it('keeps «Настройки» folded when nothing in them is a field', () => {
    show(withoutFields())
    expect(screen.queryByRole('complementary', { name: 'Настройки' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Настройки' })).toHaveProperty('ariaPressed', 'false')
  })

  it('is bare for a host with its own controls, which opens it in «Править текст»', async () => {
    const changes = vi.fn()
    const own = { bare: true, onTextEditingChange: changes, slide: { width: 1080, height: 1080 } }
    const { rerender } = show(calculator(), own)
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ещё' })).toBeNull()
    await screen.findByTitle('Экран «Калькулятор»')
    rerender({ ...own, key: 'text', startMode: 'text' })
    expect(await screen.findByTitle('Экран «Калькулятор» для правки текста')).toBeTruthy()
    // The hint row stays, with its own way out, which the host hears.
    fireEvent.click(screen.getByRole('button', { name: 'Закончить правку' }))
    expect(changes).toHaveBeenCalledWith(false)
    await screen.findByTitle('Экран «Калькулятор»')
  })

  it('saves «Настройки» as a replace of the JSON under the revision read, keeping the rest', async () => {
    const { changed } = show(calculator())
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
    render(<ViewFrame src="about:blank" width={390} scale={1} title="Экран" />)
    const iframe = screen.getByTitle('Экран') as HTMLIFrameElement
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
    expect(screen.getByTestId('frame-link-address').textContent).toBe('https://example.com/zakaz')
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть' }))
    expect(open).toHaveBeenCalledWith('https://example.com/zakaz', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })

  it('takes a height measured at the width of the view, and refuses `javascript:`', async () => {
    render(<ViewFrame src="about:blank" width={390} scale={1} title="Экран" />)
    const iframe = screen.getByTitle('Экран') as HTMLIFrameElement
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
