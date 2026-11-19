// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { durationOf, RepositoryView, RunView, runText, whenOf } from './repo-runs'

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
  prepareDeploy: vi.fn<(input: unknown) => Promise<unknown>>(),
  confirmDeploy: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
    actionId: '0199a3f2-0000-7000-8000-00000000c0aa',
  })),
  action: vi.fn<() => Promise<unknown>>(),
  prepareRunAction: vi.fn<(input: unknown) => Promise<unknown>>(),
  confirmRunAction: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
    actionId: '0199a3f2-0000-7000-8000-00000000c0ab',
  })),
  prepareRevert: vi.fn<(input: unknown) => Promise<unknown>>(),
  confirmRevert: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
    actionId: '0199a3f2-0000-7000-8000-00000000c0ac',
  })),
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
      prepareDeploy: { mutationOptions: () => ({ mutationFn: calls.prepareDeploy }) },
      confirmDeploy: { mutationOptions: () => ({ mutationFn: calls.confirmDeploy }) },
      action: {
        queryOptions: (input: unknown) => ({ queryKey: ['action', input], queryFn: calls.action }),
      },
      prepareRunAction: { mutationOptions: () => ({ mutationFn: calls.prepareRunAction }) },
      confirmRunAction: { mutationOptions: () => ({ mutationFn: calls.confirmRunAction }) },
      prepareRevert: { mutationOptions: () => ({ mutationFn: calls.prepareRevert }) },
      confirmRevert: { mutationOptions: () => ({ mutationFn: calls.confirmRevert }) },
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

describe('the tabs of merge requests and branches (ревью P7)', () => {
  it('say a failed read and read again by «Ещё раз»', async () => {
    calls.get.mockResolvedValue(repository)
    calls.runs.mockResolvedValue({ items: [], next: null, polledAt: new Date(), refreshing: false })
    calls.work.mockRejectedValueOnce(new Error('down'))
    calls.work.mockResolvedValue({ mergeRequests: [], branches: [] })
    wrap(<RepositoryView project={project} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Запросы на слияние/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Ещё раз' }))
    expect(await screen.findByText(runText.noRequests)).toBeTruthy()
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

describe('«Выкатить» on P-repo (plan 84, 84.22)', () => {
  const quiet = () => {
    calls.work.mockResolvedValue({ mergeRequests: [], branches: [] })
    calls.runs.mockResolvedValue({ items: [], next: null, polledAt: new Date(), refreshing: false })
  }

  it('waits for core, names the commit of the main branch and plays the chosen job by its token', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      quiet()
      calls.get.mockResolvedValue(repository)
      calls.prepareDeploy.mockResolvedValueOnce({ state: 'loading' }).mockResolvedValue({
        state: 'ready',
        ref: 'main',
        sha: 'a1b2c3d'.padEnd(40, '0'),
        actions: [
          { id: '4812', kind: 'manual_job', name: 'deploy-production', confirmToken: 'tok-prod' },
          { id: '4813', kind: 'manual_job', name: 'deploy-staging', confirmToken: 'tok-stage' },
        ],
        expiresAt: new Date(),
      })
      calls.action.mockResolvedValue({
        id: '0199a3f2-0000-7000-8000-00000000c0aa',
        kind: 'deploy',
        state: 'done',
        error: null,
      })
      wrap(<RepositoryView project={project} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Выкатить' }))
      expect(await screen.findByText('Читаем сборки основной ветки…')).toBeTruthy()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await screen.findByText('Выкатится коммит a1b2c3d.')).toBeTruthy()
      expect(screen.getByText(/Отката платформа не делает/)).toBeTruthy()
      fireEvent.click(screen.getByRole('radio', { name: 'deploy-staging' }))
      fireEvent.click(screen.getByRole('button', { name: 'Запустить выкладку' }))
      await waitFor(() =>
        expect(calls.confirmDeploy).toHaveBeenCalledWith(
          { confirmToken: 'tok-stage' },
          expect.anything(),
        ),
      )
      expect(await screen.findByText(/Выкладка запущена/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers nothing to play when the newest build of main has no manual jobs', async () => {
    quiet()
    calls.get.mockResolvedValue(repository)
    calls.prepareDeploy.mockResolvedValue({
      state: 'ready',
      ref: 'main',
      sha: null,
      actions: [],
      expiresAt: new Date(),
    })
    wrap(<RepositoryView project={project} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Выкатить' }))
    expect(await screen.findByText(/нет ручных заданий выкладки и процессов/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Запустить выкладку' })).toBeNull()
  })

  it('no «Выкатить» for a repository read by a link', async () => {
    const repo = { ...repository, mode: 'read' as const, connection: null }
    quiet()
    calls.get.mockResolvedValue(repo)
    wrap(<RepositoryView project={{ ...project, repository: repo }} />)
    await screen.findByText(repo.path)
    expect(screen.queryByRole('button', { name: 'Выкатить' })).toBeNull()
  })

  it('«Выкатить» on GitHub starts a workflow of the main branch, said in its own words (84.25)', async () => {
    const repo = { ...repository, provider: 'github' as const, host: 'github.com' }
    quiet()
    calls.get.mockResolvedValue(repo)
    calls.prepareDeploy.mockResolvedValue({
      state: 'ready',
      ref: 'main',
      sha: 'c'.repeat(40),
      actions: [{ id: '3', kind: 'workflow_dispatch', name: 'Deploy', confirmToken: 't' }],
      expiresAt: new Date(),
    })
    wrap(<RepositoryView project={{ ...project, repository: repo }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Выкатить' }))
    expect(await screen.findByText(/процесс GitHub Actions на основной ветке/)).toBeTruthy()
  })
})

describe('the cards of a build and of «Отменить» (plan 84, 84.26)', () => {
  it('a build that ended reruns by its card; one of main says it is a deploy', async () => {
    calls.run.mockResolvedValue({ run: runRow('481', 'failed', { ref: 'main' }), jobs: [] })
    calls.prepareRunAction.mockResolvedValue({
      kind: 'rerun',
      runId: '481',
      name: 'pipeline',
      ref: 'main',
      sha: 'e'.repeat(40),
      status: 'failed',
      deploy: true,
      repeats: false,
      confirmToken: 'token-rerun',
      expiresAt: new Date(Date.now() + 600_000),
    })
    calls.action.mockResolvedValue({ id: 'x', kind: 'rerun', state: 'done', error: null })
    wrap(<RunView project={project} runId="481" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Запустить снова' }))
    expect(await screen.findByText(/повтор может выкатить её версию/)).toBeTruthy()
    expect(screen.getByText('Ветка main, версия eeeeeee.')).toBeTruthy()
    expect(calls.prepareRunAction.mock.calls[0]![0]).toEqual({
      projectId: PROJECT,
      runId: '481',
      kind: 'rerun',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }))
    await waitFor(() =>
      expect(calls.confirmRunAction.mock.calls[0]![0]).toEqual({ confirmToken: 'token-rerun' }),
    )
    expect(await screen.findByText('Сборка запущена снова — она появится в списке.')).toBeTruthy()
  })

  it('a build of a plain branch that passed warns that its rerun runs every automatic job again', async () => {
    calls.run.mockResolvedValue({ run: runRow('486', 'success'), jobs: [] })
    calls.prepareRunAction.mockResolvedValue({
      kind: 'rerun',
      runId: '486',
      name: 'pipeline',
      ref: 'raditi/novoe-menyu-0000c002',
      sha: 'e'.repeat(40),
      status: 'success',
      deploy: false,
      repeats: true,
      confirmToken: 'token-rerun',
      expiresAt: new Date(Date.now() + 600_000),
    })
    wrap(<RunView project={project} runId="486" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Запустить снова' }))
    expect(await screen.findByText('Сборка запустится снова на той же версии.')).toBeTruthy()
    expect(screen.getByText(/повтор снова выполнит все автоматические задания/)).toBeTruthy()
    expect(screen.getByText(/включая выкладку, если вы не запускаете её вручную/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }))
    await waitFor(() =>
      expect(calls.confirmRunAction.mock.calls[0]![0]).toEqual({ confirmToken: 'token-rerun' }),
    )
  })

  it('a press refused for a sign-in names the provider of its repository (§10, «Остаток списка»)', async () => {
    calls.run.mockResolvedValue({ run: runRow('482', 'failed'), jobs: [] })
    calls.prepareRunAction.mockResolvedValue({
      kind: 'rerun',
      runId: '482',
      name: 'pipeline',
      ref: 'raditi/novoe-menyu-0000c002',
      sha: 'e'.repeat(40),
      status: 'failed',
      deploy: false,
      repeats: false,
      confirmToken: 'token-rerun',
      expiresAt: new Date(Date.now() + 600_000),
    })
    calls.action.mockResolvedValue({
      id: 'x',
      kind: 'rerun',
      state: 'failed',
      error: 'GIT_CONNECTION_REAUTH',
      provider: 'github',
    })
    wrap(<RunView project={project} runId="482" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Запустить снова' }))
    await screen.findByText('Ветка raditi/novoe-menyu-0000c002, версия eeeeeee.')
    // A build that did not pass: no warning that every automatic job runs again.
    expect(screen.queryByText(/снова выполнит все автоматические задания/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }))
    expect(await screen.findByText('Нужно войти в GitHub заново.')).toBeTruthy()
  })

  it('a build that goes offers «Остановить»; a repository read by a link offers nothing', async () => {
    calls.run.mockResolvedValue({ run: runRow('484', 'running'), jobs: [] })
    wrap(<RunView project={project} runId="484" />)
    expect(await screen.findByRole('button', { name: 'Остановить' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Запустить снова' })).toBeNull()
    cleanup()
    wrap(
      <RunView
        project={{ ...project, repository: { ...repository, mode: 'read', connection: null } }}
        runId="484"
      />,
    )
    expect(await screen.findByText('Сборка #484')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Остановить' })).toBeNull()
  })

  it('a merged request offers «Отменить» — a new merge request, by its card', async () => {
    calls.get.mockResolvedValue(repository)
    calls.runs.mockResolvedValue({ items: [], next: null, polledAt: new Date(), refreshing: false })
    calls.work.mockResolvedValue({
      mergeRequests: [
        {
          number: 7,
          title: 'Новое меню',
          state: 'merged',
          checks: 'success',
          sourceBranch: 'raditi/novoe-menyu-0000c002',
          url: 'https://gitlab.com/kolos-bakery/site/-/merge_requests/7',
          chat: null,
        },
        {
          number: 8,
          title: 'Ещё',
          state: 'open',
          checks: 'pending',
          sourceBranch: 'raditi/eshche-0000c003',
          url: 'https://gitlab.com/kolos-bakery/site/-/merge_requests/8',
          chat: null,
        },
      ],
      branches: [],
    })
    calls.prepareRevert.mockResolvedValue({
      number: 7,
      title: 'Новое меню',
      target: 'main',
      mergeSha: 'd'.repeat(40),
      url: 'https://gitlab.com/kolos-bakery/site/-/merge_requests/7',
      confirmToken: 'token-revert',
      expiresAt: new Date(Date.now() + 600_000),
    })
    calls.action.mockResolvedValue({ id: 'x', kind: 'revert', state: 'queued', error: null })
    wrap(<RepositoryView project={project} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Запросы на слияние/ }))
    // Only the merged one.
    expect((await screen.findAllByRole('button', { name: 'Отменить' })).length).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(await screen.findByText(/Откроем новый запрос на слияние/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть запрос на отмену' }))
    await waitFor(() =>
      expect(calls.confirmRevert.mock.calls[0]![0]).toEqual({ confirmToken: 'token-revert' }),
    )
    expect(await screen.findByText('Выполняем…')).toBeTruthy()
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
