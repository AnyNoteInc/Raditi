// @vitest-environment jsdom
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactNotesPanel } from './artifact-comments'
import { ArtifactDocument, documentFileName, documentMarkdown } from './artifact-document'
import type { ArtifactPresence, CabinetArtifact } from './use-artifact'

// The document of an artifact in the cabinet (docs/plan/88-artifacts.md, Ар17, Ар18, 88.10): a
// section opens in its editor only once it is held for the person; one an agent writes waits,
// or is taken back; a save that met another change merges, and where it cannot — «Разошлись».

const { hold, release, take, write, listNotes, resolveNote, replyToNote } = vi.hoisted(() => ({
  replyToNote: vi.fn(async (_input: unknown, _options: { signal: AbortSignal }) => ({
    id: 'reply',
  })),
  listNotes: vi.fn<() => Promise<unknown[]>>(async () => []),
  resolveNote: vi.fn(async (_input: unknown) => undefined),
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

vi.mock('@/trpc/client', () => {
  const mutation = (fn: (input: unknown) => Promise<unknown>) => ({
    mutationOptions: () => ({ mutationFn: fn }),
  })
  const queryKey = ['artifact', 'comments']
  const trpc = {
    artifact: {
      hold: mutation(hold),
      release: mutation(release),
      take: mutation(take),
      write: mutation(write),
      comments: {
        queryKey: () => queryKey,
        queryOptions: () => ({ queryKey, queryFn: listNotes }),
      },
      addComment: mutation(async () => ({ id: 'note' })),
      resolveComment: mutation(resolveNote),
    },
  }
  return {
    useTRPC: () => trpc,
    useTRPCClient: () => ({ artifact: { addCommentReply: { mutate: replyToNote } } }),
  }
})

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
      parent: null,
      props: {},
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
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const changed = vi.fn()
  const lost = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <ArtifactDocument
        artifact={value}
        presence={presence}
        onChanged={changed}
        onAccessLost={lost}
      />
    </QueryClientProvider>,
  )
  return { changed, lost, queryClient }
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

  it.each(['note removed', 'access lost'])(
    'refreshes access and clears cached notes: %s',
    async (outcome) => {
      const anchor = { kind: 'quote', block: 'dostavka', rev: 3, quote: 'Звоним за полчаса.' }
      const notes = [
        {
          id: 'first',
          anchor,
          body: 'Уточнить адрес',
          shared: false,
          author: { name: 'Анна', own: true },
          resolved: false,
          moved: false,
          replies: [],
        },
        {
          id: 'second',
          anchor,
          body: 'Уточнить время',
          shared: false,
          author: { name: 'Анна', own: true },
          resolved: false,
          moved: false,
          replies: [],
        },
      ]
      listNotes.mockResolvedValue(notes)
      try {
        const { changed, lost } = show(artifact())
        const list = await screen.findByRole('region', { name: 'Заметки к документу' })
        expect(await within(list).findByText('Уточнить адрес')).toBeTruthy()
        const refreshed = Promise.withResolvers<unknown[]>()
        listNotes.mockReturnValueOnce(refreshed.promise)
        resolveNote.mockRejectedValueOnce(refusal('ARTIFACT_NOT_FOUND'))
        fireEvent.click(within(list).getAllByRole('button', { name: 'Отметить решённой' })[0]!)
        await waitFor(() => expect(changed).toHaveBeenCalled())
        expect(lost).not.toHaveBeenCalled()
        await waitFor(() => expect(screen.queryByText('Уточнить время')).toBeNull())

        if (outcome === 'access lost') {
          await act(() => refreshed.reject(refusal('ARTIFACT_NOT_FOUND')))
          await waitFor(() => expect(lost).toHaveBeenCalledOnce())
          expect(screen.queryByRole('region', { name: 'Заметки к документу' })).toBeNull()
        } else {
          refreshed.resolve(notes.slice(1))
          expect(await screen.findByText('Уточнить время')).toBeTruthy()
          expect(screen.queryByText('Уточнить адрес')).toBeNull()
        }
      } finally {
        listNotes.mockReset()
      }
    },
  )

  it('discards private notes when the session expires, even if the next read fails', async () => {
    const queryKey = ['artifact', 'comments']
    const anchor = { kind: 'quote', block: 'dostavka', rev: 3, quote: 'Звоним за полчаса.' }
    listNotes.mockResolvedValue([
      {
        id: 'note',
        anchor,
        body: 'Уточнить адрес',
        shared: false,
        author: { name: 'Анна', own: true },
        resolved: false,
        moved: false,
        replies: [],
      },
    ])
    try {
      const { lost, queryClient } = show(artifact())
      expect(await screen.findByText('Уточнить адрес')).toBeTruthy()

      listNotes.mockRejectedValue(Object.assign(new Error(), { data: { code: 'UNAUTHORIZED' } }))
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey })
      })
      await waitFor(() => expect(lost).toHaveBeenCalledOnce())
      expect(queryClient.getQueryData(queryKey)).toBeNull()
      expect(screen.queryByText('Уточнить адрес')).toBeNull()

      listNotes.mockRejectedValue(new Error('Temporary connection loss'))
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey })
      })
      expect(queryClient.getQueryData(queryKey)).toBeNull()
      expect(screen.queryByText('Уточнить адрес')).toBeNull()
    } finally {
      listNotes.mockReset()
    }
  })

  it('keeps a failed offline reply local until the user explicitly retries', async () => {
    const anchor = { kind: 'quote', block: 'dostavka', rev: 3, quote: 'Звоним за полчаса.' }
    listNotes.mockResolvedValue([
      {
        id: 'note',
        anchor,
        body: 'Уточнить адрес',
        shared: false,
        author: { name: 'Анна', own: true },
        resolved: false,
        moved: false,
        replies: [],
      },
    ])
    try {
      const { queryClient } = show(artifact())
      fireEvent.click(await screen.findByRole('button', { name: 'Ответить' }))
      const dialog = screen.getByRole('dialog', { name: 'Ответ на заметку' })
      const field = within(dialog).getByRole('textbox', { name: 'Ответ' })
      const save = within(dialog).getByRole('button', { name: 'Сохранить ответ' })
      act(() => onlineManager.setOnline(false))
      replyToNote.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      fireEvent.change(field, { target: { value: '  После девяти  ' } })
      fireEvent.click(save)
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Не удалось сохранить ответ. Попробуйте ещё раз.',
      )
      expect(save).toBeEnabled()
      expect(field).toHaveValue('  После девяти  ')
      expect(queryClient.getMutationCache().getAll()).toEqual([])
      const [input] = replyToNote.mock.calls[0]!
      expect(input).toMatchObject({ body: 'После девяти', requestId: expect.any(String) })

      await act(async () => onlineManager.setOnline(true))
      expect(replyToNote).toHaveBeenCalledOnce()
      fireEvent.change(field, { target: { value: 'После девяти' } })
      fireEvent.click(save)
      await waitFor(() => expect(replyToNote).toHaveBeenCalledTimes(2))
      expect(replyToNote.mock.calls[1]![0]).toEqual(input)
      await waitFor(() => expect(dialog).not.toBeInTheDocument())
    } finally {
      act(() => onlineManager.setOnline(true))
      listNotes.mockReset()
    }
  })

  it('reuses an unconfirmed reply key after another text also fails', async () => {
    const anchor = { kind: 'quote', block: 'dostavka', rev: 3, quote: 'Звоним за полчаса.' }
    listNotes.mockResolvedValue([
      {
        id: 'note',
        anchor,
        body: 'Уточнить адрес',
        shared: false,
        author: { name: 'Анна', own: true },
        resolved: false,
        moved: false,
        replies: [],
      },
    ])
    try {
      show(artifact())
      fireEvent.click(await screen.findByRole('button', { name: 'Ответить' }))
      const dialog = screen.getByRole('dialog', { name: 'Ответ на заметку' })
      const field = within(dialog).getByRole('textbox', { name: 'Ответ' })
      const save = within(dialog).getByRole('button', { name: 'Сохранить ответ' })
      replyToNote
        .mockRejectedValueOnce(new TypeError('Response lost'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      for (const body of ['После девяти', 'После десяти']) {
        fireEvent.change(field, { target: { value: body } })
        fireEvent.click(save)
        await within(dialog).findByRole('alert')
      }
      fireEvent.change(field, { target: { value: '  После девяти  ' } })
      fireEvent.click(save)
      await waitFor(() => expect(dialog).not.toBeInTheDocument())

      const inputs = replyToNote.mock.calls.map(([input]) => input)
      expect(inputs).toEqual([
        expect.objectContaining({ body: 'После девяти', requestId: expect.any(String) }),
        expect.objectContaining({ body: 'После десяти', requestId: expect.any(String) }),
        inputs[0],
      ])
      expect(inputs[1]).not.toMatchObject({
        requestId: (inputs[0] as { requestId: string }).requestId,
      })
    } finally {
      listNotes.mockReset()
    }
  })

  it('aborts a pending reply and ignores its late success after access was lost', async () => {
    const queryKey = ['artifact', 'comments']
    const anchor = { kind: 'quote', block: 'dostavka', rev: 3, quote: 'Звоним за полчаса.' }
    listNotes.mockResolvedValue([
      {
        id: 'note',
        anchor,
        body: 'Уточнить адрес',
        shared: false,
        author: { name: 'Анна', own: true },
        resolved: false,
        moved: false,
        replies: [],
      },
    ])
    const reply = Promise.withResolvers<{ id: string }>()
    replyToNote.mockReturnValueOnce(reply.promise)
    try {
      const { lost, queryClient } = show(artifact())
      fireEvent.click(await screen.findByRole('button', { name: 'Ответить' }))
      const dialog = screen.getByRole('dialog', { name: 'Ответ на заметку' })
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Ответ' }), {
        target: { value: 'После девяти' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить ответ' }))
      await waitFor(() => expect(replyToNote).toHaveBeenCalledOnce())
      const { signal } = replyToNote.mock.calls[0]![1]
      expect(signal.aborted).toBe(false)
      expect(queryClient.getMutationCache().getAll()).toEqual([])

      listNotes.mockRejectedValueOnce(refusal('ARTIFACT_NOT_FOUND'))
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey })
      })
      await waitFor(() => expect(lost).toHaveBeenCalledOnce())
      expect(screen.queryByRole('dialog', { name: 'Ответ на заметку' })).toBeNull()
      expect(queryClient.getQueryData(queryKey)).toBeNull()
      expect(signal.aborted).toBe(true)
      const reads = listNotes.mock.calls.length

      await act(async () => reply.resolve({ id: 'reply' }))
      expect(listNotes).toHaveBeenCalledTimes(reads)
      expect(queryClient.getQueryData(queryKey)).toBeNull()
      expect(screen.queryByText('Уточнить адрес')).toBeNull()
    } finally {
      reply.resolve({ id: 'reply' })
      listNotes.mockReset()
    }
  })

  it('shows a section the agent writes as checking, and offers no editing to a viewer', () => {
    show({ ...artifact({ content: null, checking: true, hold: 'checking' }), role: 'view' })
    expect(screen.getByText(/текст появится, как только мы его проверим/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Править/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Добавить раздел' })).toBeNull()
  })
})

describe('a lighter document (docs/plan/93-artifacts-trim.md, АТ9)', () => {
  const two = (): CabinetArtifact => {
    const one = artifact()
    return {
      ...one,
      blocks: [
        one.blocks[0]!,
        {
          ...one.blocks[0]!,
          key: 'oplata',
          rank: '00bj',
          heading: 'Оплата',
          content: 'Картой или наличными.',
        },
      ],
    }
  }

  it('has no panel of notes while there are none', async () => {
    show(artifact())
    await waitFor(() => expect(listNotes).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Заметки к документу' })).toBeNull()
  })

  it('shows the notes on the page only while «Заметки · N» keeps them open', async () => {
    listNotes.mockResolvedValue([
      {
        id: '019f1a21-1800-7f00-8abc-0000000000c1',
        anchor: { kind: 'quote', block: 'dostavka', rev: 3, quote: 'с 8 до 21' },
        body: 'Уточнить время',
        shared: false,
        author: { name: 'Вы', own: true },
        resolved: false,
        moved: false,
        replies: [],
      },
    ])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <ArtifactNotesPanel.Provider value={{ open, setOpen: vi.fn() }}>
          <ArtifactDocument
            artifact={artifact()}
            presence={nobody}
            onChanged={vi.fn()}
            onAccessLost={vi.fn()}
          />
        </ArtifactNotesPanel.Provider>
      </QueryClientProvider>
    )
    const { rerender } = render(view(false))
    await waitFor(() => expect(listNotes).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Заметки к документу' })).toBeNull()
    rerender(view(true))
    const notes = await screen.findByRole('region', { name: 'Заметки к документу' })
    expect(within(notes).getByText('Уточнить время')).toBeTruthy()
    listNotes.mockResolvedValue([])
  })

  it('adds a section between two others', async () => {
    show(two())
    fireEvent.click(screen.getByRole('button', { name: 'Добавить раздел после «Доставка»' }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    const { batch } = write.mock.calls[0]![0] as {
      batch: { ops: { op: string; after: string | null; kind: string }[] }
    }
    expect(batch.ops[0]).toMatchObject({ op: 'insert', after: 'dostavka', kind: 'section' })
  })

  it('keeps the tools of a section in a box shown on hover and focus', () => {
    show(artifact())
    const edit = screen.getByRole('button', { name: 'Править раздел «Доставка»' })
    expect(edit.closest('.section-tools')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Действия с разделом «Доставка»' })).toBeTruthy()
  })

  it('is downloaded as Markdown: the title, then each written section', () => {
    const value = two()
    value.blocks.push({ ...value.blocks[0]!, key: 'pishet', heading: 'Пишет агент', content: null })
    expect(documentMarkdown(value)).toBe(
      '# Тексты для лендинга\n\n## Доставка\n\nПривозим с 8 до 21.\n\nЗвоним за полчаса.\n\n## Оплата\n\nКартой или наличными.\n',
    )
    expect(documentFileName('Прайс: весна/лето')).toBe('Прайс весна лето.md')
    expect(documentFileName('  ')).toBe('Без заголовка.md')
  })
})
