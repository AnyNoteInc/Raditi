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
  prepareCi: vi.fn<(input: unknown) => Promise<unknown>>(),
  confirmCi: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ actionId: 'c' })),
  declineCi: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ declined: true })),
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
      prepareCiChange: { mutationOptions: () => ({ mutationFn: calls.prepareCi }) },
      confirmCiChange: { mutationOptions: () => ({ mutationFn: calls.confirmCi }) },
      declineCiChange: { mutationOptions: () => ({ mutationFn: calls.declineCi }) },
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
  projectId: '0199a3f2-0000-7000-8000-00000000b001',
  branch: row.branch,
  state: 'local',
  headSha: HEAD,
  sent: false,
  canPush: true,
  ciChange: 'none',
  mergeRequest: null,
  lastRun: null,
  rewinds: false,
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

// docs/plan/84-projects.md, ПР16 (slice 84.20): P-chat-merge, the lower card.
describe('the card «Агент хочет изменить настройки сборки» (plan 84, 84.20)', () => {
  const ready = {
    state: 'ready',
    branch: row.branch,
    headSha: HEAD,
    files: [
      {
        path: '.gitlab-ci.yml',
        additions: 3,
        deletions: 1,
        diff: 'diff --git a/.gitlab-ci.yml b/.gitlab-ci.yml\n-  script: npm run lint\n+  script:\n',
      },
    ],
    ciDiffSha256: 'e'.repeat(64),
    lint: { valid: false, errors: ['jobs:lint script can not be empty'] },
    opensMergeRequest: true,
    proposal: { title: 'Зимнее меню', description: 'Цены', draft: false, reservedId: null },
    confirmToken: 'token-of-the-ci-card',
    expiresAt: new Date(),
  }

  it('offers no «Отправить в ветку»; waits for core, then shows the diff and sends by the card', async () => {
    calls.branch.mockResolvedValue(view({ ciChange: 'needed' }))
    calls.prepareCi.mockResolvedValueOnce({ state: 'loading' }).mockResolvedValue(ready)
    wrap(<FeedRepoChanges taskId={TASK} row={row} />)
    await screen.findByText('Агент хочет изменить настройки сборки')
    expect(screen.queryByRole('button', { name: 'Открыть запрос на слияние' })).toBeNull()
    expect(await screen.findByText('Проверяем изменение настроек сборки…')).toBeTruthy()
    await screen.findByText('.gitlab-ci.yml', {}, { timeout: 4000 })
    expect(screen.getByText('+3 −1')).toBeTruthy()
    expect(screen.getByText(/script: npm run lint/)).toBeTruthy()
    expect(screen.getByText('jobs:lint script can not be empty')).toBeTruthy()
    expect(screen.getByText('Откроется запрос на слияние «Зимнее меню».')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Разрешить и отправить' }))
    await waitFor(() =>
      expect(calls.confirmCi).toHaveBeenCalledWith(
        {
          confirmToken: 'token-of-the-ci-card',
          mergeRequest: {
            title: 'Зимнее меню',
            description: 'Цены',
            draft: false,
            reservedId: null,
          },
        },
        expect.anything(),
      ),
    )
    expect(calls.confirm).not.toHaveBeenCalled()
  })

  it('«Не отправлять» declines it; a declined change and a configuration elsewhere are said', async () => {
    calls.branch.mockResolvedValue(view({ ciChange: 'needed' }))
    calls.prepareCi.mockResolvedValue(ready)
    wrap(<FeedRepoChanges taskId={TASK} row={row} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Не отправлять' }))
    await waitFor(() =>
      expect(calls.declineCi).toHaveBeenCalledWith({ taskId: TASK }, expect.anything()),
    )
    cleanup()
    for (const [state, words] of [
      ['declined', /Вы не разрешили изменить настройки сборки/],
      ['foreign', /лежат в другом репозитории/],
    ] as const) {
      calls.branch.mockResolvedValue(view({ ciChange: state }))
      wrap(<FeedRepoChanges taskId={TASK} row={row} />)
      expect(await screen.findByText(words)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Разрешить и отправить' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Открыть запрос на слияние' })).toBeNull()
      cleanup()
    }
  })
})

describe('the build of the branch in the chat (plan 84, 84.21)', () => {
  it('shows the status of the build and reads it again while it goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const sent = { sent: true, state: 'pushed', mergeRequest: null }
      calls.branch
        .mockResolvedValueOnce(
          view({ ...sent, lastRun: { id: '482', status: 'running', refusal: null, url: 'x' } }),
        )
        .mockResolvedValue(
          view({ ...sent, lastRun: { id: '482', status: 'failed', refusal: null, url: 'x' } }),
        )
      wrap(<FeedRepoChanges taskId={TASK} row={row} />)
      expect(await screen.findByText('Идёт')).toBeTruthy()
      const link = screen.getByRole('link', { name: 'Идёт' })
      expect(link.getAttribute('href')).toBe(
        '/projects/0199a3f2-0000-7000-8000-00000000b001/repository/runs/482',
      )
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await screen.findByText('Упала')).toBeTruthy()
      expect(calls.branch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a build gitlab.com did not start says why, not «Упала»', async () => {
    calls.branch.mockResolvedValue(
      view({
        sent: true,
        state: 'pushed',
        lastRun: { id: '483', status: 'failed', refusal: 'account_unverified', url: 'x' },
      }),
    )
    wrap(<FeedRepoChanges taskId={TASK} row={row} />)
    expect(await screen.findByText(/GitLab просит подтвердить учётную запись/)).toBeTruthy()
    expect(screen.queryByText('Упала')).toBeNull()
  })

  it('after /undo of a merged branch says the changes are in the main branch (ПР25)', async () => {
    calls.branch.mockResolvedValue(view({ state: 'merged', rewinds: true, sent: false }))
    wrap(<FeedRepoChanges taskId={TASK} row={row} />)
    expect(
      await screen.findByText(
        'Изменения уже приняты в основную ветку — отменить их можно новым запросом на слияние.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Отправить в ветку' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Открыть запрос на слияние' })).toBeNull()
  })
})
