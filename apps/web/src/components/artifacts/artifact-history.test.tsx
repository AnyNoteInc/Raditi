// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactHistoryButton } from './artifact-history'
import type { CabinetArtifact } from './use-artifact'

// «История версий» (docs/plan/88-artifacts.md, Ар13, 88.11а; plan 93, АТ9): one list of versions,
// what «Вернуть» overwrites before it is pressed, and «Отменить правки агента» of a version after an
// answer of the agent — no inner journal, no «ход».

const ID = '019f1a21-1800-7f00-8abc-000000000001'
const TASK = '019f1a21-1800-7f00-8abc-0000000000aa'

const { restore, undoTurn, save } = vi.hoisted(() => ({
  restore: vi.fn(async (_input: unknown) => ({ no: 8, changed: 2 })),
  undoTurn: vi.fn(async (_input: unknown) => ({ undone: 1, kept: 1 })),
  save: vi.fn(async (_input: unknown) => ({ no: 9 })),
}))

const query = (path: string, fn: (input: unknown) => unknown) => ({
  queryKey: (input: unknown) => [path, input],
  queryOptions: (input: unknown) => ({ queryKey: [path, input], queryFn: async () => fn(input) }),
})
const mutation = (fn: (input: unknown) => Promise<unknown>) => ({
  mutationOptions: () => ({ mutationFn: fn }),
})

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: {
      versions: query('versions', () => [
        {
          no: 7,
          label: null,
          named: false,
          author: 'turn',
          chat: 'Тексты',
          taskId: TASK,
          turnNo: 4,
          createdAt: '2026-11-20T10:00:00.000Z',
          current: true,
        },
        {
          no: 5,
          label: 'Показала маме',
          named: true,
          author: 'user',
          chat: null,
          taskId: null,
          turnNo: null,
          createdAt: '2026-11-19T10:00:00.000Z',
          current: false,
        },
      ]),
      version: query('version', () => ({
        no: 5,
        label: 'Показала маме',
        createdAt: '2026-11-19T10:00:00.000Z',
        blocks: [{ key: 'a', kind: 'section', heading: 'Цены', content: 'Старая цена' }],
      })),
      restorePreview: query('preview', () => ({
        blocks: 2,
        people: ['Анна'],
        chats: ['Тексты'],
        agents: 0,
        held: 0,
      })),
      restoreVersion: mutation(restore),
      undoTurn: mutation(undoTurn),
      saveVersion: mutation(save),
    },
  }),
}))

const artifact = { id: ID, role: 'owner' } as unknown as CabinetArtifact

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const changed = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <ArtifactHistoryButton artifact={artifact} onChanged={changed} />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'История версий' }))
  return { changed }
}

beforeEach(() => vi.clearAllMocks())

describe('«История версий» (88.11а)', () => {
  it('names who made each version, and returns one after saying whose edits it overwrites', async () => {
    const { changed } = show()
    expect(await screen.findByText('Ответ агента · чат «Тексты»')).toBeTruthy()
    expect(screen.getByText('Вы')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByText(/ход/)).toBeNull()
    fireEvent.click(screen.getByText('«Показала маме»'))
    expect(await screen.findByText('Старая цена')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть эту версию' }))
    const dialog = await screen.findByRole('dialog', { name: 'Вернуть версию 5?' })
    expect(
      await within(dialog).findByText('Будут перезаписаны правки: Анна, агента в чате «Тексты».'),
    ).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Вернуть' }))
    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith({ artifactId: ID, no: 5 }, expect.anything()),
    )
    expect(await screen.findByText('Готово: сохранено как версия 8.')).toBeTruthy()
    expect(changed).toHaveBeenCalled()
  })

  it('takes back the edits of the agent of a version, and saves the current one with a label', async () => {
    show()
    fireEvent.click(await screen.findByText(/Версия 7/))
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить правки агента' }))
    await waitFor(() =>
      expect(undoTurn).toHaveBeenCalledWith(
        { artifactId: ID, taskId: TASK, turnNo: 4 },
        expect.anything(),
      ),
    )
    expect(await screen.findByText(/1 уже изменили после агента/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить текущую как версию…' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Название версии' }), {
      target: { value: 'Черновик' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ artifactId: ID, label: 'Черновик' }, expect.anything()),
    )
  })
})
