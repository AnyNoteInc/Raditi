// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactQuickEdit, quickEditTexts, useQuickEdits } from './artifact-quick-edit'

// «Исправить» on a note (docs/plan/98-quick-edits.md, БПр9, БПр12).

const ARTIFACT = '019f1a21-1800-7f00-8abc-000000000001'
const THREAD = '019f1a21-1800-7f00-8abc-000000000002'
const EDIT = '019f1a21-1800-7f00-8abc-000000000003'

const { quickEdit, listEdits } = vi.hoisted(() => ({
  quickEdit: vi.fn(async (_input: unknown) => ({ quickEditId: '' })),
  listEdits: vi.fn(async () => [] as unknown[]),
}))

vi.mock('@/trpc/client', () => {
  const mutation = (fn: (input: unknown) => Promise<unknown>) => ({
    mutationOptions: () => ({ mutationFn: fn }),
  })
  const trpc = {
    artifact: {
      quickEdit: mutation(quickEdit),
      undoTurn: mutation(async () => ({ undone: 1, kept: 0 })),
      quickEdits: {
        queryOptions: () => ({ queryKey: ['quickEdits'], queryFn: listEdits }),
      },
    },
  }
  return { useTRPC: () => trpc }
})

const refusal = (domainCode: string) =>
  Object.assign(new Error(domainCode), { data: { domainCode } })

/** A notes panel of one note; `noteShown` drops the note as a resolved note leaves the list. */
function Panel(props: { own: boolean; moved: boolean; noteShown: boolean; onDone: () => void }) {
  const quick = useQuickEdits({ artifactId: ARTIFACT, onDone: props.onDone })
  return (
    <>
      {quick.notices}
      {props.noteShown && (
        <ArtifactQuickEdit
          quick={quick}
          threadId={THREAD}
          own={props.own}
          authorName="Мария"
          moved={props.moved}
        />
      )}
    </>
  )
}

function show(props: { own: boolean; moved?: boolean }) {
  const onDone = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (noteShown: boolean) => (
    <QueryClientProvider client={client}>
      <Panel own={props.own} moved={props.moved ?? false} noteShown={noteShown} onDone={onDone} />
    </QueryClientProvider>
  )
  const view = render(tree(true))
  return { onDone, dropNote: () => view.rerender(tree(false)) }
}

describe('«Исправить» on a note', () => {
  beforeEach(() => {
    quickEdit.mockReset()
    quickEdit.mockResolvedValue({ quickEditId: EDIT })
    listEdits.mockReset()
    listEdits.mockResolvedValue([])
  })

  it('starts an edit of the clicker’s own note at once and shows it applied', async () => {
    listEdits.mockResolvedValue([
      {
        id: EDIT,
        taskId: ARTIFACT,
        attempt: 2,
        state: 'applied',
        reason: null,
        createdAt: '2026-11-28T10:00:00.000Z',
        finishedAt: '2026-11-28T10:00:04.000Z',
      },
    ])
    const { onDone } = show({ own: true })
    fireEvent.click(screen.getByRole('button', { name: quickEditTexts.label }))
    // The mutation function also gets the context of react-query: the input is its first argument.
    await waitFor(() =>
      expect(quickEdit.mock.calls[0]?.[0]).toMatchObject({
        artifactId: ARTIFACT,
        threadIds: [THREAD],
        confirmOthers: false,
      }),
    )
    expect(await screen.findByText(quickEditTexts.done)).toBeTruthy()
    expect(onDone).toHaveBeenCalled()
  })

  it('keeps «Отменить» when the edit closed its note and the note left the list', async () => {
    listEdits.mockResolvedValue([
      {
        id: EDIT,
        taskId: ARTIFACT,
        attempt: 3,
        state: 'applied',
        reason: null,
        createdAt: '2026-11-28T10:00:00.000Z',
        finishedAt: null,
      },
    ])
    const { dropNote } = show({ own: true })
    fireEvent.click(screen.getByRole('button', { name: quickEditTexts.label }))
    await waitFor(() => expect(quickEdit).toHaveBeenCalled())
    // The note is resolved by the edit and leaves the list before the panel sees the end.
    dropNote()
    listEdits.mockResolvedValue([
      {
        id: EDIT,
        taskId: ARTIFACT,
        attempt: 3,
        state: 'applied',
        reason: null,
        createdAt: '2026-11-28T10:00:00.000Z',
        finishedAt: '2026-11-28T10:00:04.000Z',
      },
    ])
    expect(await screen.findByText(quickEditTexts.done, {}, { timeout: 4000 })).toBeTruthy()
    expect(screen.getByRole('button', { name: quickEditTexts.undo })).toBeTruthy()
  })

  it('asks before acting on a note of another person', async () => {
    show({ own: false })
    fireEvent.click(screen.getByRole('button', { name: quickEditTexts.label }))
    expect(screen.getByText(quickEditTexts.confirmTitle)).toBeTruthy()
    expect(quickEdit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: quickEditTexts.confirmYes }))
    await waitFor(() => expect(quickEdit.mock.calls[0]?.[0]).toMatchObject({ confirmOthers: true }))
  })

  it('is off where the place of the note changed', () => {
    show({ own: true, moved: true })
    expect(
      (screen.getByRole('button', { name: quickEditTexts.label }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('tells a refusal in plain words', async () => {
    quickEdit.mockRejectedValue(refusal('QUICK_EDIT_BUSY'))
    show({ own: true })
    fireEvent.click(screen.getByRole('button', { name: quickEditTexts.label }))
    expect(await screen.findByText(quickEditTexts.busy)).toBeTruthy()
  })
})
