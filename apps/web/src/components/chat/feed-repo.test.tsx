// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FeedRepoAction, FeedRepoChanges, repoErrorText, statLine } from './feed-repo'

// The card «Изменения в ветке» (docs/plan/84-projects.md, ПР13, ПР14, ПР26; P-chat): the buttons
// stand on the card of the chat's head only, a press goes through the token of the card, and the
// first push opens the merge request with the title the client left.

const TASK = '0199a3f2-0000-7000-8000-00000000a001'
const HEAD = 'c'.repeat(40)

const calls = vi.hoisted(() => ({
  branch: vi.fn<() => Promise<unknown>>(),
  prepare: vi.fn<(input: unknown) => Promise<unknown>>(),
  confirm: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ actionId: 'a' })),
  diff: vi.fn(async () => ({
    patch: 'diff --git a/menu.html b/menu.html\n+зима\n',
    truncated: false,
  })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    projectRepo: {
      branch: {
        queryOptions: (input: unknown) => ({ queryKey: ['branch', input], queryFn: calls.branch }),
        queryKey: (input: unknown) => ['branch', input],
      },
      diff: {
        queryOptions: (input: unknown) => ({ queryKey: ['diff', input], queryFn: calls.diff }),
      },
      preparePush: { mutationOptions: () => ({ mutationFn: calls.prepare }) },
      confirmPush: { mutationOptions: () => ({ mutationFn: calls.confirm }) },
    },
  }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const wrap = (node: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>,
  )

const row = {
  branch: 'raditi/novoe-menyu-0000a001',
  headSha: HEAD,
  files: 12,
  additions: 86,
  deletions: 23,
  list: Array.from({ length: 12 }, (_, i) => ({
    path: `src/${i}.html`,
    additions: 1,
    deletions: 0,
  })),
}
const view = (over: Record<string, unknown> = {}) => ({
  branch: row.branch,
  state: 'local',
  headSha: HEAD,
  sent: false,
  canPush: true,
  mergeRequest: null,
  lastAction: null,
  ...over,
})

describe('the card «Изменения в ветке» (plan 84, 84.19)', () => {
  it('shows the branch, the counts and ten files, and opens the merge request by the press', async () => {
    calls.branch.mockResolvedValue(view())
    calls.prepare.mockResolvedValue({
      branch: row.branch,
      headSha: HEAD,
      diffSha256: 'd'.repeat(64),
      stat: { files: 12, additions: 86, deletions: 23, list: [] },
      rewinds: false,
      opensMergeRequest: true,
      proposal: { title: 'Зимнее меню', description: 'Цены', draft: false, reservedId: null },
      confirmToken: 'token-of-the-card',
      expiresAt: new Date(),
    })
    wrap(<FeedRepoChanges taskId={TASK} row={row} />)
    expect(screen.getByText('12 файлов · +86 −23')).toBeTruthy()
    expect(screen.getAllByText(/^src\/\d+\.html$/)).toHaveLength(10)
    expect(screen.getByText('и ещё 2')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть запрос на слияние' }))
    await screen.findByText('Открыть запрос на слияние?')
    expect(calls.prepare).toHaveBeenCalledWith({ taskId: TASK }, expect.anything())
    fireEvent.change(screen.getByLabelText('Название запроса'), { target: { value: 'Меню зимы' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Открыть запрос на слияние' }).at(-1)!)
    await waitFor(() =>
      expect(calls.confirm).toHaveBeenCalledWith(
        {
          confirmToken: 'token-of-the-card',
          mergeRequest: { title: 'Меню зимы', description: 'Цены', draft: false, reservedId: null },
        },
        expect.anything(),
      ),
    )
  })

  it('has no button on an older card, on a sent branch, a read-only one or while a press goes', async () => {
    for (const over of [
      { headSha: 'e'.repeat(40) },
      { sent: true },
      { canPush: false },
      { lastAction: { id: 'a', kind: 'push', state: 'running', error: null } },
    ]) {
      calls.branch.mockResolvedValue(view(over))
      wrap(<FeedRepoChanges taskId={TASK} row={row} />)
      await waitFor(() => expect(calls.branch).toHaveBeenCalled())
      await screen.findByRole('button', { name: 'Посмотреть изменения' })
      expect(screen.queryByRole('button', { name: /Отправить в ветку|Открыть запрос/ })).toBeNull()
      cleanup()
    }
  })

  it('says «Отправить в ветку» once the branch has its merge request', async () => {
    calls.branch.mockResolvedValue(
      view({
        mergeRequest: {
          number: 7,
          state: 'open',
          url: 'https://gitlab.example.ru/k/s/-/merge_requests/7',
        },
      }),
    )
    wrap(<FeedRepoChanges taskId={TASK} row={row} />)
    expect(await screen.findByRole('button', { name: 'Отправить в ветку' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Запрос на слияние' })).toBeTruthy()
  })

  it('shows the diff of the card', async () => {
    calls.branch.mockResolvedValue(view())
    wrap(<FeedRepoChanges taskId={TASK} row={row} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Посмотреть изменения' }))
    expect(await screen.findByText(/\+зима/)).toBeTruthy()
    expect(calls.diff).toHaveBeenCalled()
  })

  it('says what a press did in the client’s words', () => {
    wrap(<FeedRepoAction kind="push" state="failed" error="REPO_PUSH_CONFLICT" />)
    expect(screen.getByText(/ветку изменили в репозитории/)).toBeTruthy()
    expect(repoErrorText('SOMETHING_ELSE')).toBe('Не получилось — попробуйте ещё раз.')
    expect(statLine({ files: 1, additions: 2, deletions: 0 })).toBe('1 файл · +2 −0')
  })
})
