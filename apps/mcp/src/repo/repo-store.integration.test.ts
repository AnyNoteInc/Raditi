import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { postgresRepoStore } from './repo.module.ts'

// The builds of a repository as `mcp` reads them on PostgreSQL (docs/plan/84-projects.md, ПР17;
// slice 84.21): runs from the rows core polled, a log asked of core by the outbox and answered
// `loading`, and five logs a turn. Only on a disposable database.
function uuidv7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!enabled)('the builds of a repository for the agent with PostgreSQL', () => {
  let db: PrismaClient
  const users: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const userId of users.splice(0)) {
      const workspaces = { workspace: { createdById: userId } }
      await db.projectRepository.deleteMany({ where: workspaces })
      await db.project.deleteMany({ where: workspaces })
      await db.workspace.deleteMany({ where: { createdById: userId } })
      await db.user.deleteMany({ where: { id: userId } })
    }
  })
  afterAll(async () => {
    await db?.$disconnect()
  })

  async function repository() {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    users.push(user.id)
    const ws = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    const project = await db.project.create({
      data: { id: uuidv7(), workspaceId: ws.id, createdById: user.id, name: 'Колос' },
    })
    const id = randomUUID()
    await db.projectRepository.create({
      data: {
        id,
        projectId: project.id,
        workspaceId: ws.id,
        provider: 'gitlab',
        host: 'gitlab.com',
        path: 'kolos/site',
        webUrl: 'https://gitlab.com/kolos/site',
        defaultBranch: 'main',
        mode: 'read',
        mirrorState: 'ready',
      },
    })
    await db.projectCiRun.create({
      data: {
        projectRepositoryId: id,
        providerRunId: '7',
        ref: 'main',
        sha: 'a'.repeat(40),
        name: '#7',
        status: 'failed',
        webUrl: 'https://gitlab.com/kolos/site/-/pipelines/7',
        jobs: [
          {
            id: '71',
            name: 'test',
            stage: 'test',
            status: 'failed',
            manual: false,
            refusal: null,
            url: 'https://gitlab.com/kolos/site/-/jobs/71',
            startedAt: null,
            finishedAt: null,
          },
        ],
        createdAt: new Date(),
        syncedAt: new Date(),
      },
    })
    return { id, projectId: project.id }
  }

  it('reads runs, asks core for a log and counts five logs a turn', async () => {
    const repo = await repository()
    const store = postgresRepoStore(db)
    expect(
      (await store.runs({ projectRepositoryId: repo.id, ref: 'main', limit: 5 }))[0],
    ).toMatchObject({ id: '7', status: 'failed', jobs: [{ id: '71', name: 'test' }] })
    expect(
      await store.defaultBranch({ projectRepositoryId: repo.id, projectId: repo.projectId }),
    ).toBe('main')
    expect(
      await store.defaultBranch({ projectRepositoryId: repo.id, projectId: randomUUID() }),
    ).toBeNull()
    const ask = { projectRepositoryId: repo.id, runId: '7', jobId: '71', ref: 'raditi/menu-1' }
    // A build of the main branch may deploy: its log is not the agent's (ревью, безопасность 8).
    await expect(store.log(ask)).rejects.toMatchObject({ code: 'REPO_RUN_NOT_FOUND' })
    await db.projectCiRun.updateMany({
      where: { projectRepositoryId: repo.id, providerRunId: '7' },
      data: { ref: 'raditi/menu-1' },
    })
    expect(await store.log(ask)).toEqual({ state: 'loading' })
    expect(
      await db.outboxEvent.count({
        where: { type: 'git.log', payload: { path: ['projectRepositoryId'], equals: repo.id } },
      }),
    ).toBe(1)
    const taskId = randomUUID()
    const given = []
    for (let i = 0; i < 6; i++) given.push(await store.admitLog(taskId, 3))
    expect(given).toEqual([true, true, true, true, true, false])
    // The next turn has its own five.
    expect(await store.admitLog(taskId, 4)).toBe(true)
    await db.outboxEvent.deleteMany({
      where: { type: 'git.log', payload: { path: ['projectRepositoryId'], equals: repo.id } },
    })
    await db.rateLimit.deleteMany({ where: { key: { startsWith: `repo-logs:${taskId}:` } } })
  })
})
