import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DomainError } from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MCP_ACCESS, type McpAccessStore, type McpTurnAccess } from '../access/mcp-access.ts'
import { AppModule } from '../app.module.ts'
import { MCP_ENDPOINT } from '../server/mcp-runtime.ts'
import { mountMcp } from '../server/mount-mcp.ts'
import { fakeInfra, testMcpConfig } from '../testing/fakes.ts'
import { McpRepoService, type McpRepoLog, type McpRepoStore } from './repo-service.ts'
import { MCP_REPO } from './repo.tokens.ts'

// The repository of a chat's project through the gateway (docs/plan/84-projects.md, ПР13, ПР14,
// §4.4): offered to a turn whose plan names one, read from the database, a merge request only
// proposed — the client opens it with a button.

const token = `mcp_${'d'.repeat(64)}`
const repository = {
  projectId: '01960000-0000-7000-8000-0000000000f1',
  projectRepositoryId: '01960000-0000-7000-8000-0000000000f2',
  mode: 'write' as const,
  branch: 'raditi/novoe-menyu-0000000f',
  baseSha: 'a'.repeat(40),
}
const base: McpTurnAccess = {
  keyId: '01960000-0000-7000-8000-000000000031',
  taskId: '01960000-0000-7000-8000-000000000032',
  workspaceId: '01960000-0000-7000-8000-000000000033',
  sessionId: 'synthetic',
  turn: 2,
  firstEpoch: 1,
  epoch: 1,
  requirements: { repository: true, browser: false },
  memory: null,
  repository,
}

let app: INestApplication | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await app?.close()
  app = undefined
})

function fakeStore() {
  return {
    status: vi.fn(async (_input: Parameters<McpRepoStore['status']>[0]) => ({
      provider: 'gitlab',
      path: 'kolos/site',
      defaultBranch: 'main',
      branch: repository.branch,
      state: 'pushed' as const,
      mergeRequest: {
        number: 7,
        state: 'open',
        checks: 'pending',
        url: 'https://gitlab.example.ru/kolos/site/-/merge_requests/7',
      },
    })),
    reserve: vi.fn(async (_input: Parameters<McpRepoStore['reserve']>[0]) => ({
      reservationId: '01960000-0000-7000-8000-0000000000e9',
    })),
    runs: vi.fn(async (_input: Parameters<McpRepoStore['runs']>[0]) => [
      {
        id: '482',
        name: '#482',
        ref: repository.branch,
        sha: 'b'.repeat(40),
        status: 'failed' as const,
        refusal: null,
        jobs: [
          {
            id: '4822',
            name: 'unit-tests',
            stage: 'test',
            status: 'failed' as const,
            refusal: null,
          },
        ],
      },
    ]),
    defaultBranch: vi.fn(async () => 'main' as string | null),
    log: vi.fn(async (_input: Parameters<McpRepoStore['log']>[0]): Promise<McpRepoLog> => ({
      state: 'ready',
      text: 'x'.repeat(2000) + '\nERROR: Job failed',
      truncated: false,
    })),
    admitLog: vi.fn(async (_taskId: string, _turn: number) => true),
  } satisfies McpRepoStore
}

async function start(scope: McpTurnAccess = base, store = fakeStore()) {
  const access: McpAccessStore = { authenticate: async (value) => (value === token ? scope : null) }
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(testMcpConfig())] })
    .overrideProvider(PRISMA)
    .useValue(fakeInfra().prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(fakeInfra().secrets)
    .overrideProvider(MCP_ACCESS)
    .useValue(access)
    .overrideProvider(MCP_REPO)
    .useValue(new McpRepoService({ store }))
  app = (await builder.compile()).createNestApplication({ logger: false })
  await mountMcp(app)
  await app.listen(0, '127.0.0.1')
  return { server: app.getHttpServer(), store }
}

const post = (server: unknown, body: object) =>
  request(server as Parameters<typeof request>[0])
    .post(MCP_ENDPOINT)
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-protocol-version', '2025-06-18')
    .send(body)
const call = (name: string, args: unknown) => ({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name, arguments: args },
})
const names = async (server: unknown) =>
  (
    (await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools as {
      name: string
    }[]
  ).map((tool) => tool.name)
const answer = (res: { body: { result: { content: { text: string }[] } } }) =>
  JSON.parse(res.body.result.content[0]!.text) as Record<string, unknown>

describe('the repository of a chat through the gateway (plan 84, 84.19)', () => {
  it('is offered only to a turn whose plan names a repository', async () => {
    const on = await start()
    expect(await names(on.server)).toEqual(
      expect.arrayContaining(['repo_status', 'repo_request_merge']),
    )
    await app?.close()
    const off = await start({
      ...base,
      requirements: { repository: false, browser: false },
      repository: null,
    })
    expect(await names(off.server)).not.toContain('repo_status')
    expect((await post(off.server, call('repo_status', {}))).status).toBe(400)
  })

  it('tells the branch and its merge request from the rows of the platform', async () => {
    const { server, store } = await start()
    expect(answer(await post(server, call('repo_status', {})))).toEqual({
      provider: 'gitlab',
      path: 'kolos/site',
      mode: 'write',
      defaultBranch: 'main',
      branch: repository.branch,
      baseSha: repository.baseSha,
      pushed: true,
      mergeRequest: {
        number: 7,
        state: 'open',
        checks: 'pending',
        url: 'https://gitlab.example.ru/kolos/site/-/merge_requests/7',
      },
    })
    // The repository of the admitted turn, never one of the arguments.
    expect(store.status).toHaveBeenCalledWith({
      taskId: base.taskId,
      projectRepositoryId: repository.projectRepositoryId,
      projectId: repository.projectId,
    })
  })

  it('reserves a proposal of a merge request, and opens nothing', async () => {
    const { server, store } = await start()
    const res = await post(
      server,
      call('repo_request_merge', { title: ' Зимнее меню ', description: 'Цены по прайсу' }),
    )
    expect(answer(res)).toEqual({
      ok: true,
      reservedId: '01960000-0000-7000-8000-0000000000e9',
      live: 'the client opens it with a button after this turn',
    })
    expect(store.reserve).toHaveBeenCalledWith({
      workspaceId: base.workspaceId,
      taskId: base.taskId,
      turnNo: 2,
      proposal: { title: 'Зимнее меню', description: 'Цены по прайсу', draft: false },
    })
  })

  it('refuses a key it does not know and a long title before the tool, and a read-only repository', async () => {
    const { server, store } = await start()
    for (const args of [
      { title: 'а', description: '', branch: 'main' },
      { title: 'а'.repeat(121), description: '' },
      { title: '', description: '' },
    ])
      expect((await post(server, call('repo_request_merge', args))).status).toBe(400)
    expect(store.reserve).not.toHaveBeenCalled()
    await app?.close()
    const read = await start({ ...base, repository: { ...repository, mode: 'read' } })
    const res = await post(read.server, call('repo_request_merge', { title: 'а', description: '' }))
    expect(answer(res)).toMatchObject({ code: 'REPO_READ_ONLY' })
    await app?.close()
    const store2 = fakeStore()
    store2.reserve.mockRejectedValueOnce(
      new DomainError('REPO_PROPOSAL_LIMIT', 'This turn already proposed a merge request', 409),
    )
    const limited = await start(base, store2)
    expect(
      answer(
        await post(limited.server, call('repo_request_merge', { title: 'а', description: '' })),
      ),
    ).toMatchObject({ code: 'REPO_PROPOSAL_LIMIT' })
  })
})

describe('the agent never merges and never deploys (plan 84, 84.22, ПР15)', () => {
  it('no tool of a turn with a repository on write merges, accepts, plays or deploys', async () => {
    const { server } = await start()
    const listed = await names(server)
    expect(listed).toEqual(
      expect.arrayContaining(['repo_status', 'repo_request_merge', 'repo_runs', 'repo_job_log']),
    )
    // `repo_request_merge` only reserves a proposal: the client opens it with a button.
    expect(
      listed.filter((name) => /merge|deploy|play|accept|release|rollout|pipeline/i.test(name)),
    ).toEqual(['repo_request_merge'])
    for (const name of ['repo_merge', 'repo_deploy', 'repo_accept', 'repo_play', 'repo_push']) {
      const res = await post(server, call(name, {}))
      expect(res.status).toBe(400)
    }
  })
})

describe('the builds of a chat through the gateway (plan 84, 84.21)', () => {
  it('offers repo_runs and repo_job_log to a turn with a repository', async () => {
    const { server } = await start()
    expect(await names(server)).toEqual(expect.arrayContaining(['repo_runs', 'repo_job_log']))
  })

  it("reads the chat's builds or the main branch's from the rows of the platform", async () => {
    const { server, store } = await start()
    const runs = answer(await post(server, call('repo_runs', { branch: 'chat', limit: 3 })))
    expect((runs.runs as { id: string }[]).map((run) => run.id)).toEqual(['482'])
    expect(store.runs).toHaveBeenLastCalledWith({
      projectRepositoryId: repository.projectRepositoryId,
      ref: repository.branch,
      limit: 3,
    })
    await post(server, call('repo_runs', { branch: 'default' }))
    expect(store.runs).toHaveBeenLastCalledWith({
      projectRepositoryId: repository.projectRepositoryId,
      ref: 'main',
      limit: 5,
    })
    expect((await post(server, call('repo_runs', { limit: 11 }))).status).toBe(400)
  })

  it('answers REPO_LOG_LOADING first, then the log on the second call', async () => {
    const store = fakeStore()
    store.log.mockResolvedValueOnce({ state: 'loading' })
    const { server } = await start(base, store)
    const args = { runId: '482', jobId: '4822', tailBytes: 1024 }
    expect(answer(await post(server, call('repo_job_log', args)))).toEqual({
      code: 'REPO_LOG_LOADING',
      message: 'The log is being fetched; call again in a few seconds.',
    })
    expect(store.admitLog).not.toHaveBeenCalled()
    const ready = answer(await post(server, call('repo_job_log', args)))
    expect(ready).toMatchObject({ ok: true, truncated: true })
    expect(String(ready.text).endsWith('ERROR: Job failed')).toBe(true)
    expect(new TextEncoder().encode(String(ready.text)).byteLength).toBeLessThanOrEqual(1024)
    expect(store.log).toHaveBeenLastCalledWith({
      projectRepositoryId: repository.projectRepositoryId,
      runId: '482',
      jobId: '4822',
      // Only of the chat's branch (ревью, безопасность 8).
      ref: repository.branch,
    })
  })

  it('refuses the sixth log of a turn', async () => {
    const store = fakeStore()
    let given = 0
    store.admitLog.mockImplementation(async () => ++given <= 5)
    const { server } = await start(base, store)
    const args = { runId: '482', jobId: '4822' }
    for (let i = 0; i < 5; i++)
      expect(answer(await post(server, call('repo_job_log', args)))).toMatchObject({ ok: true })
    expect(answer(await post(server, call('repo_job_log', args)))).toMatchObject({
      code: 'REPO_LOG_LIMIT',
    })
    expect(store.admitLog).toHaveBeenCalledWith(base.taskId, 2)
  })
})
