// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactQuickEdit, quickEditTexts } from './artifact-quick-edit'

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

function show(props: { own: boolean; moved?: boolean }) {
  const onDone = vi.fn()
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ArtifactQuickEdit
        artifactId={ARTIFACT}
        threadId={THREAD}
        own={props.own}
        authorName="Мария"
        moved={props.moved ?? false}
        onDone={onDone}
      />
    </QueryClientProvider>,
  )
  return { onDone }
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
