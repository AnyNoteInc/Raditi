import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { ciRunsOf, requestCiLog } from './repo-ci.ts'
import { uuidv7 } from './uuidv7.ts'

const databaseUrl = process.env.DATABASE_URL
const sha = 'a'.repeat(40)

async function codeOf(act: () => Promise<unknown>): Promise<string | null> {
  try {
    await act()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
}

// The builds of a repository (docs/plan/84-projects.md, ПР17; slice 84.21): the migration
// 20261117160000_project_ci and the reads of web and `mcp` on a schema of their own.
describe.skipIf(!databaseUrl)('PostgreSQL: builds and logs of a repository (plan 84)', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'repo_ci')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  async function repository() {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    const project = await db.project.create({
      data: { id: uuidv7(), workspaceId: workspace.id, createdById: user.id, name: 'Колос' },
    })
    const repo = await db.projectRepository.create({
      data: {
        id: randomUUID(),
        projectId: project.id,
        workspaceId: workspace.id,
        provider: 'gitlab',
        host: 'gitlab.com',
        path: 'kolos/site',
        webUrl: 'https://gitlab.com/kolos/site',
        defaultBranch: 'main',
        mode: 'read',
      },
    })
    return repo.id
  }

  const job = (id: string, status: string) => ({
    id,
    name: 'unit-tests',
    stage: 'test',
    status,
    manual: false,
    refusal: null,
    url: `https://gitlab.com/kolos/site/-/jobs/${id}`,
    startedAt: null,
    finishedAt: null,
  })

  async function run(projectRepositoryId: string, id: string, status: string, at: Date) {
    await db.projectCiRun.create({
      data: {
        projectRepositoryId,
        providerRunId: id,
        ref: 'main',
        sha,
        name: `#${id}`,
        status,
        webUrl: `https://gitlab.com/kolos/site/-/pipelines/${id}`,
        jobs: [job(`${id}1`, status)],
        createdAt: at,
        syncedAt: at,
      },
    })
  }

  it('keeps only the statuses, refusals and log sizes of the domain', async () => {
    const id = await repository()
    const base = {
      projectRepositoryId: id,
      ref: 'main',
      sha,
      name: '#1',
      webUrl: 'https://gitlab.com/x/-/pipelines/1',
      createdAt: new Date(),
      syncedAt: new Date(),
    }
    expect(
      await codeOf(() =>
        db.projectCiRun.create({ data: { ...base, providerRunId: '1', status: 'queued' } }),
      ),
    ).not.toBeNull()
    expect(
      await codeOf(() =>
        db.projectCiRun.create({
          data: { ...base, providerRunId: '2', status: 'failed', refusal: 'quota' },
        }),
      ),
    ).not.toBeNull()
    expect(
      await codeOf(() =>
        db.projectCiRun.create({ data: { ...base, providerRunId: '../3', status: 'failed' } }),
      ),
    ).not.toBeNull()
    const log = {
      projectRepositoryId: id,
      providerJobId: '9',
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    }
    expect(
      await codeOf(() =>
        db.projectCiLog.create({
          data: { ...log, state: 'ready', text: 'x'.repeat(65537), fetchedAt: new Date() },
        }),
      ),
    ).not.toBeNull()
    expect(
      await codeOf(() => db.projectCiLog.create({ data: { ...log, state: 'ready' } })),
    ).not.toBeNull()
  })

  it('lists the newest runs first, of a ref, page by page', async () => {
    const id = await repository()
    const t = Date.UTC(2026, 10, 16, 10)
    await run(id, '10', 'success', new Date(t))
    await run(id, '11', 'failed', new Date(t + 1000))
    await run(id, '12', 'running', new Date(t + 2000))
    const first = await ciRunsOf(db, { projectRepositoryId: id, limit: 2 })
    expect(first.map((r) => [r.id, r.status])).toEqual([
      ['12', 'running'],
      ['11', 'failed'],
    ])
    const next = await ciRunsOf(db, {
      projectRepositoryId: id,
      limit: 2,
      before: first[1]!.createdAt,
    })
    expect(next.map((r) => r.id)).toEqual(['10'])
    expect(await ciRunsOf(db, { projectRepositoryId: id, ref: 'raditi/x-1', limit: 5 })).toEqual([])
  })

  it('asks core once for a log, answers loading, then the kept tail', async () => {
    const id = await repository()
    const now = new Date(Date.UTC(2026, 10, 16, 12))
    await run(id, '20', 'failed', now)
    const ask = { projectRepositoryId: id, runId: '20', jobId: '201', now }
    expect(await requestCiLog(db, ask)).toEqual({ state: 'loading' })
    expect(await requestCiLog(db, ask)).toEqual({ state: 'loading' })
    const jobs = await db.outboxEvent.findMany({
      where: { topic: 'git', type: 'git.log', payload: { path: ['jobId'], equals: '201' } },
    })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.payload).toEqual({ projectRepositoryId: id, jobId: '201' })
    // Core fetched it.
    await db.projectCiLog.update({
      where: {
        projectRepositoryId_providerJobId: { projectRepositoryId: id, providerJobId: '201' },
      },
      data: { state: 'ready', text: 'ERROR: Job failed', fetchedAt: now },
    })
    expect(await requestCiLog(db, ask)).toEqual({
      state: 'ready',
      text: 'ERROR: Job failed',
      truncated: false,
      fetchedAt: now,
    })
    // A day later it is gone: asked again.
    const later = { ...ask, now: new Date(now.getTime() + 25 * 60 * 60 * 1000) }
    expect(await requestCiLog(db, later)).toEqual({ state: 'loading' })
  })

  it('refuses a run or a job the repository does not keep', async () => {
    const id = await repository()
    await run(id, '30', 'success', new Date())
    const now = new Date()
    expect(
      await codeOf(() =>
        requestCiLog(db, { projectRepositoryId: id, runId: '31', jobId: '1', now }),
      ),
    ).toBe('REPO_RUN_NOT_FOUND')
    expect(
      await codeOf(() =>
        requestCiLog(db, { projectRepositoryId: id, runId: '30', jobId: '999', now }),
      ),
    ).toBe('REPO_RUN_NOT_FOUND')
    const other = await repository()
    expect(
      await codeOf(() =>
        requestCiLog(db, { projectRepositoryId: other, runId: '30', jobId: '301', now }),
      ),
    ).toBe('REPO_RUN_NOT_FOUND')
  })
})
