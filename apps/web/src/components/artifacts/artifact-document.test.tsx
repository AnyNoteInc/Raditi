// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactDocument } from './artifact-document'
import type { ArtifactPresence, CabinetArtifact } from './use-artifact'

// The document of an artifact in the cabinet (docs/plan/88-artifacts.md, Ар17, Ар18, 88.10): a
// section opens in its editor only once it is held for the person; one an agent writes waits,
// or is taken back; a save that met another change merges, and where it cannot — «Разошлись».

const { hold, release, take, write } = vi.hoisted(() => ({
  hold: vi.fn(async (_input: unknown) => ({ rev: 3, until: '2026-11-20T10:00:30.000Z' })),
  release: vi.fn(async (_input: unknown) => undefined),
  take: vi.fn(async (_input: unknown) => ({ rev: 4 })),
  write: vi.fn(async (_input: unknown) => ({
    artifactId: ARTIFACT,
    opId: 'x',
    seq: 9,
    blocks: [{ key: 'dostavka', rev: 4, state: 'applied' as const }],
    title: null,
    repeated: false,
  })),
}))

const ARTIFACT = '019f1a21-1800-7f00-8abc-000000000001'

const mutation = (fn: (input: unknown) => Promise<unknown>) => ({
  mutationOptions: () => ({ mutationFn: fn }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: {
      hold: mutation(hold),
      release: mutation(release),
      take: mutation(take),
      write: mutation(write),
    },
  }),
}))

const refusal = (domainCode: string, artifact?: unknown) =>
  Object.assign(new Error(domainCode), { data: { domainCode, ...(artifact ? { artifact } : {}) } })

const artifact = (overrides: Partial<CabinetArtifact['blocks'][number]> = {}): CabinetArtifact => ({
  id: ARTIFACT,
  kind: 'document',
  title: 'Тексты для лендинга',
  seq: 8,
  role: 'owner',
  version: 5,
  project: null,
  updatedAt: '2026-11-20T10:00:00.000Z',
  blocks: [
    {
      key: 'dostavka',
      kind: 'section',
      rank: '00bi',
      rev: 3,
      heading: 'Доставка',
      content: 'Привозим с 8 до 21.\n\nЗвоним за полчаса.\n',
      checking: false,
      hold: null,
      ...overrides,
    },
  ],
})

const nobody: ArtifactPresence = { people: [], morePeople: 0, agents: [] }

function show(value: CabinetArtifact, presence: ArtifactPresence = nobody) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const changed = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <ArtifactDocument artifact={value} presence={presence} onChanged={changed} />
    </QueryClientProvider>,
  )
  return { changed }
}

/** The Tiptap editor behind its element: what a person types goes through it. */
async function editorOf() {
  const element = await waitFor(() => {
    const found = document.querySelector('.ProseMirror')
    if (!found) throw new Error('no editor yet')
    return found as HTMLElement & {
      editor?: { commands: Record<string, (...args: never[]) => unknown> }
    }
  })
  return element.editor!
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the document of an artifact (88.10)', () => {
  it('shows its sections, and opens one in its editor once it is held', async () => {
    show(artifact())
    expect(screen.getByRole('heading', { name: 'Доставка' })).toBeTruthy()
    expect(screen.getByText('Привозим с 8 до 21.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Править раздел «Доставка»' }))
    await waitFor(() =>
      expect(hold).toHaveBeenCalledWith(
        { artifactId: ARTIFACT, block: 'dostavka' },
        expect.anything(),
      ),
    )
    expect(await screen.findByRole('textbox', { name: 'Заголовок раздела' })).toHaveValue(
      'Доставка',
    )
    await editorOf()
    expect(screen.getByRole('button', { name: 'Жирный' })).toBeTruthy()
  })

  it('waits while an agent writes the section, and takes it back on «Забрать правку»', async () => {
    hold.mockRejectedValueOnce(refusal('ARTIFACT_BLOCK_HELD'))
    show(artifact({ hold: 'claim' }), {
      ...nobody,
      agents: [
        { label: 'Тексты для лендинга', own: true, blocks: [{ key: 'dostavka', intent: null }] },
      ],
    })
    expect(screen.getByText('Пишет агент · Тексты для лендинга')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Править раздел «Доставка»' }))
    expect(await screen.findByText('Агент пишет — вы ждёте')).toBeTruthy()
    expect(
      screen.getByText(
        'Этот раздел сейчас пишет агент «Тексты для лендинга». Ваша правка подождёт.',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Забрать правку' }))
    await waitFor(() => expect(take).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('Агент пишет — вы ждёте')).toBeNull())
  })

  it('saves in the canonical form on «Готово», with the revision it was made from', async () => {
    const { changed } = show(artifact())
    fireEvent.click(screen.getByRole('button', { name: 'Править раздел «Доставка»' }))
    const editor = await editorOf()
    act(() => {
      editor.commands.insertContentAt?.(1 as never, 'Ежедневно. ' as never)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    const [{ batch }] = write.mock.calls[0] as unknown as [
      { batch: { ops: { op: string; ifRev: number; content: string }[] } },
    ]
    expect(batch.ops[0]).toMatchObject({ op: 'replace', ifRev: 3 })
    expect(batch.ops[0]!.content).toBe('Ежедневно. Привозим с 8 до 21.\n\nЗвоним за полчаса.\n')
    await waitFor(() => expect(changed).toHaveBeenCalled())
  })

  it('merges a change of other lines, and shows «Разошлись» when both changed one line', async () => {
    show(artifact())
    fireEvent.click(screen.getByRole('button', { name: 'Править раздел «Доставка»' }))
    const editor = await editorOf()
    // Someone else changed the second paragraph meanwhile: both changes are kept.
    write.mockRejectedValueOnce(
      refusal('ARTIFACT_STALE', {
        rev: 5,
        content: 'Привозим с 8 до 21.\n\nЗвоним за час.\n',
      }),
    )
    act(() => {
      editor.commands.insertContentAt?.(1 as never, 'Ежедневно. ' as never)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    const second = (
      write.mock.calls[1] as unknown as [{ batch: { ops: { ifRev: number; content: string }[] } }]
    )[0]
    expect(second.batch.ops[0]).toMatchObject({
      ifRev: 5,
      content: 'Ежедневно. Привозим с 8 до 21.\n\nЗвоним за час.\n',
    })
  })

  it('lets the person choose when the same line changed both ways', async () => {
    show(artifact())
    fireEvent.click(screen.getByRole('button', { name: 'Править раздел «Доставка»' }))
    const editor = await editorOf()
    write.mockRejectedValueOnce(
      refusal('ARTIFACT_STALE', { rev: 5, content: 'Привозим с 9 до 21.\n\nЗвоним за полчаса.\n' }),
    )
    act(() => {
      editor.commands.insertContentAt?.(1 as never, 'Ежедневно. ' as never)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    const dialog = await screen.findByRole('dialog', { name: 'Разошлись' })
    expect(within(dialog).getByText('Раздел изменили, пока вы правили')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Оставить мой' }))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    const second = (
      write.mock.calls[1] as unknown as [{ batch: { ops: { ifRev: number; content: string }[] } }]
    )[0]
    expect(second.batch.ops[0]).toMatchObject({
      ifRev: 5,
      content: 'Ежедневно. Привозим с 8 до 21.\n\nЗвоним за полчаса.\n',
    })
  })

  it('shows a section the agent writes as checking, and offers no editing to a viewer', () => {
    show({ ...artifact({ content: null, checking: true, hold: 'checking' }), role: 'view' })
    expect(screen.getByText(/текст появится, как только мы его проверим/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Править/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Добавить раздел' })).toBeNull()
  })
})
