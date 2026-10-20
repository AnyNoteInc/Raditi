import { billingFixtures } from '@repo/billing/testing'
import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { cleanupReleases, releaseFixture, type ReleaseFixture } from '../testing/releases.ts'
import { ReleaseSweep, ReleaseSweepRuntime } from './release-sweep.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe('the timer of the release sweeper', () => {
  it('runs only in the background process, one pass at a time, and stops with the module', async () => {
    let finish: () => void = () => {}
    const sweep = {
      tick: vi.fn(() => new Promise<number>((resolve) => (finish = () => resolve(0)))),
    }
    const idle = new ReleaseSweepRuntime(sweep, false)
    idle.onApplicationBootstrap()
    expect(sweep.tick).not.toHaveBeenCalled()

    const runtime = new ReleaseSweepRuntime(sweep, true, { warn: vi.fn() })
    runtime.onApplicationBootstrap()
    expect(sweep.tick).toHaveBeenCalledOnce()
    // A pass still running is not started twice.
    void runtime.tick()
    expect(sweep.tick).toHaveBeenCalledOnce()
    finish()
    await runtime.onModuleDestroy()
    await runtime.tick()
    expect(sweep.tick).toHaveBeenCalledOnce()
  })

  it('logs a failed pass without its error', async () => {
    const warn = vi.fn()
    const runtime = new ReleaseSweepRuntime(
      { tick: vi.fn(async () => Promise.reject(new Error('postgres://secret'))) },
      true,
      { warn },
    )
    await runtime.tick()
    expect(warn).toHaveBeenCalledWith('release_sweep_failed')
  })
})

describe.skipIf(!enabled)('the release sweeper with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  const sites: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await cleanupReleases(db, sites.splice(0))
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /** How far the deadline of the token is: well ahead, near (the run is asked about), past. */
  const deadlines = { live: 20 * 60_000, near: 60_000, past: -60_000 } as const

  /** A release left in `status` three minutes ago, with the barrier of its site or without. */
  async function left(
    status: string,
    options: {
      barrier?: boolean
      held?: boolean
      token?: keyof typeof deadlines
      taskStatus?: string
    } = {},
  ): Promise<ReleaseFixture> {
    const f = await releaseFixture(db, fixtures, { version: `v0.1.${sites.length}` })
    sites.push(f.siteId)
    const published = !['approved', 'publishing'].includes(status)
    await db.$executeRaw`UPDATE site_releases SET status = ${status}::"ReleaseStatus",
      approved_sha = ${published ? 'f'.repeat(40) : null},
      main_pushed_at = ${published ? new Date() : null}, lease_epoch = 1,
      deploy_token_hash = ${options.token === undefined ? null : 'e'.repeat(64)},
      deploy_token_expires_at = ${
        options.token === undefined ? null : new Date(Date.now() + deadlines[options.token])
      },
      updated_at = clock_timestamp() - interval '3 minutes'
      WHERE id = ${f.releaseId}::uuid`
    if (options.taskStatus)
      await db.$executeRaw`UPDATE tasks SET status = ${options.taskStatus}::"TaskStatus", finished_at = now() WHERE id = ${f.taskId}::uuid`
    if (options.barrier)
      await db.siteLease.create({
        data: {
          siteId: f.siteId,
          holderTaskId: f.taskId,
          operation: 'deploy',
          epoch: 1,
          acquiredAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          heldForOperator: options.held ?? false,
          inflightReleaseId: f.releaseId,
        },
      })
    return f
  }

  it('wakes the releases that need a run and had none for a while, and only those', async () => {
    const due = [
      await left('approved'),
      await left('publishing', { barrier: true }),
      await left('published', { barrier: true, token: 'past' }),
      await left('deploying', { barrier: true, token: 'past' }),
      // A job silent until near its deadline: the provider is asked whether its run goes on.
      await left('deploying', { barrier: true, token: 'near' }),
      await left('failed', { barrier: true }),
      await left('unknown', { barrier: true }),
      // Installed and freed, but its dialog is not charged yet.
      await left('installed'),
    ]
    const quiet = [
      await left('published', { barrier: true, token: 'live' }),
      await left('verifying', { barrier: true, token: 'live' }),
      await left('unknown', { barrier: true, held: true }),
      // Its revert commit could not land: the operator's.
      await left('failed', { barrier: true, held: true }),
      await left('rolled_back', { taskStatus: 'rolled_back' }),
      await left('installed', { taskStatus: 'done' }),
    ]
    const recent = await releaseFixture(db, fixtures, { version: 'v9.9.9' })
    sites.push(recent.siteId)

    const sweep = new ReleaseSweep(db, { warn: vi.fn() })
    await sweep.tick()
    const woken = async (f: ReleaseFixture) =>
      db.outboxEvent.count({
        where: { dedupeKey: { startsWith: `release.advance:${f.releaseId}:` } },
      })
    for (const f of due) expect(await woken(f)).toBe(1)
    for (const f of [...quiet, recent]) expect(await woken(f)).toBe(0)
    // Woken now, it is not woken again by the next pass.
    await sweep.tick()
    for (const f of due) expect(await woken(f)).toBe(1)
  })
})
