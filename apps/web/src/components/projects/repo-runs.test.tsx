// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { durationOf, RepositoryView, RunView, whenOf } from './repo-runs'

// The repository and its builds in the cabinet (docs/plan/84-projects.md, ПР17, §4.8; slice 84.21;
// P-repo, P-pipeline): Russian statuses, the client's names of stages, the log folded until it is
// opened, `loading` first and the text on the next read.

const PROJECT = '0199a3f2-0000-7000-8000-00000000c001'
const CHAT = '0199a3f2-0000-7000-8000-00000000c002'

const calls = vi.hoisted(() => ({
  get: vi.fn<() => Promise<unknown>>(),
  runs: vi.fn<(input: unknown) => Promise<unknown>>(),
  run: vi.fn<(input: unknown) => Promise<unknown>>(),
  jobLog: vi.fn<(input: unknown) => Promise<unknown>>(),
  work: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    projectRepo: {
      get: { queryOptions: (input: unknown) => ({ queryKey: ['get', input], queryFn: calls.get }) },
      runs: {
        queryOptions: (input: unknown) => ({
          queryKey: ['runs', input],
          queryFn: () => calls.runs(input),
        }),
      },
      run: {
        queryOptions: (input: unknown) => ({
          queryKey: ['run', input],
          queryFn: () => calls.run(input),
        }),
      },
      jobLog: {
        queryOptions: (input: unknown) => ({
          queryKey: ['jobLog', input],
          queryFn: () => calls.jobLog(input),
        }),
      },
      work: {
        queryOptions: (input: unknown) => ({ queryKey: ['work', input], queryFn: calls.work }),
      },
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

const repository = {
  id: '0199a3f2-0000-7000-8000-00000000c003',
  provider: 'gitlab' as const,
  host: 'gitlab.com',
  path: 'kolos-bakery/site',
  webUrl: 'https://gitlab.com/kolos-bakery/site',
  defaultBranch: 'main',
  mode: 'write' as const,
  mirrorState: 'ready' as const,
  connection: { id: 'c', kind: 'gitlab_oauth' as const, login: 'Елена К.', state: 'ok' },
  refusal: null,
  secretsFound: [],
  fetchedAt: null,
}
const project = { id: PROJECT, name: 'Сайт пекарни «Колос»', repository }
const runRow = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'Обновить меню на зиму',
  ref: 'raditi/novoe-menyu-0000c002',
  sha: 'e'.repeat(40),
  event: 'push',
  status,
  refusal: null,
  url: `https://gitlab.com/kolos-bakery/site/-/pipelines/${id}`,
  createdAt: new Date(Date.now() - 8 * 60_000),
  startedAt: new Date(Date.now() - 8 * 60_000),
  finishedAt: new Date(Date.now() - 8 * 60_000 + 100_000),
  chat: { id: CHAT, title: 'Новое меню на зиму' },
  stages: ['check', 'test', 'build', 'deploy'],
  ...over,
})
const job = (id: string, name: string, stage: string, status: string, over = {}) => ({
  id,
  name,
  stage,
  status,
  manual: status === 'manual',
  refusal: null,
  url: `https://gitlab.com/kolos-bakery/site/-/jobs/${id}`,
  startedAt: null,
  finishedAt: null,
  ...over,
})

describe('P-repo (plan 84, 84.21)', () => {
  it('lists the builds with Russian statuses, the client’s stages and the chat', async () => {
    calls.get.mockResolvedValue(repository)
    calls.work.mockResolvedValue({ mergeRequests: [], branches: [] })
    calls.runs.mockResolvedValue({
      items: [runRow('484', 'running'), runRow('483', 'manual'), runRow('481', 'failed')],
      next: null,
      polledAt: new Date(),
      refreshing: false,
    })
    wrap(<RepositoryView project={project} />)
    expect(await screen.findByText('Идёт')).toBeTruthy()
    expect(screen.getByText('Ждёт ручного запуска')).toBeTruthy()
    expect(screen.getAllByText('Упала').length).toBeGreaterThan(0)
    expect(screen.getAllByText('check · test · build · deploy').length).toBe(3)
    expect(screen.getAllByText(/из чата «Новое меню на зиму»/).length).toBe(3)
    expect(screen.getByText(/имена из вашей настройки сборки/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Открыть в GitLab' }).getAttribute('href')).toBe(
      repository.webUrl,
    )
    // «Упали» shows only the failed one.
    fireEvent.click(screen.getByRole('tab', { name: 'Упали 1' }))
    expect(screen.queryByText('Идёт')).toBeNull()
  })
})

describe('P-pipeline (plan 84, 84.21)', () => {
  it('shows stages and jobs, the log folded, loading and then as the build wrote it', async () => {
    calls.run.mockResolvedValue({
      run: runRow('481', 'failed'),
      jobs: [
        job('4814', 'deploy-production', 'deploy', 'manual'),
        job('4813', 'unit-tests', 'test', 'failed'),
        job('4812', 'e2e-smoke', 'test', 'success'),
        job('4811', 'lint', 'check', 'success'),
      ],
    })
    calls.jobLog.mockResolvedValueOnce({ state: 'loading' }).mockResolvedValue({
      state: 'ready',
      text: 'Tests  1 failed | 33 passed (34)\nERROR: Job failed: exit code 1',
      truncated: true,
      fetchedAt: new Date(),
    })
    wrap(<RunView project={project} runId="481" />)
    expect(await screen.findByText('Сборка #481')).toBeTruthy()
    expect(screen.getByText('check')).toBeTruthy()
    expect(screen.getByText('deploy')).toBeTruthy()
    fireEvent.click(screen.getByText('unit-tests'))
    expect(screen.getByText('Журнал задания «unit-tests»')).toBeTruthy()
    expect(calls.jobLog).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Показать журнал' }))
    expect(await screen.findByText('Получаем журнал…')).toBeTruthy()
    expect(await screen.findByText(/ERROR: Job failed/, {}, { timeout: 4000 })).toBeTruthy()
    expect(screen.getByText('Показаны последние 64 КБ')).toBeTruthy()
    expect(screen.getByText('Журнал показан как есть, на языке сборки')).toBeTruthy()
    expect(calls.jobLog).toHaveBeenCalledWith({ projectId: PROJECT, runId: '481', jobId: '4813' })
  })

  it('a build gitlab.com did not start says why', async () => {
    calls.run.mockResolvedValue({
      run: runRow('483', 'failed', { refusal: 'account_unverified' }),
      jobs: [job('4831', 'unit-tests', 'test', 'failed', { refusal: 'account_unverified' })],
    })
    wrap(<RunView project={project} runId="483" />)
    expect(
      await screen.findByText(
        'GitLab просит подтвердить учётную запись, чтобы запускать сборки на своих серверах: подтвердите её в GitLab или подключите свой раннер',
      ),
    ).toBeTruthy()
  })
})

describe('the words of time', () => {
  it('says durations and moments', () => {
    expect(durationOf(new Date(0), new Date(52_000))).toBe('52 с')
    expect(durationOf(new Date(0), new Date(100_000))).toBe('1 мин 40 с')
    expect(durationOf(null, null)).toBeNull()
    const now = new Date('2026-11-16T12:00:00Z')
    expect(whenOf(new Date('2026-11-16T11:59:40Z'), now)).toBe('сейчас')
    expect(whenOf(new Date('2026-11-16T11:52:00Z'), now)).toBe('8 мин назад')
    expect(whenOf(new Date('2026-11-16T11:00:00Z'), now)).toBe('1 ч назад')
  })
})
