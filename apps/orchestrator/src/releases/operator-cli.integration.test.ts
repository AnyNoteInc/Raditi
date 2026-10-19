import { billingFixtures } from '@repo/billing/testing'
import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { cleanupReleases, releaseFixture } from '../testing/releases.ts'
import { runReleasesCommand } from './operator-cli.ts'

// releases:resolve on PostgreSQL: the decision about an unknown release, written once. Only on
// a disposable database (RADITI_GATEWAY_DB_TESTS=1), as the suites of the release skill.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!enabled)('releases:resolve with PostgreSQL', () => {
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

  it('writes the decision about an unknown release and hands the site back to core', async () => {
    const f = await releaseFixture(db, fixtures)
    sites.push(f.siteId)
    await db.$executeRaw`UPDATE site_releases SET status = 'unknown', approved_sha = ${'f'.repeat(40)},
      main_pushed_at = clock_timestamp(), lease_epoch = 2 WHERE id = ${f.releaseId}::uuid`
    await db.siteLease.create({
      data: {
        siteId: f.siteId,
        holderTaskId: f.taskId,
        operation: 'deploy',
        epoch: 2,
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        heldForOperator: true,
        inflightReleaseId: f.releaseId,
      },
    })
    const write = vi.fn<(text: string) => void>()
    const env = { APP_ENV: 'test', DATABASE_URL: databaseUrl ?? '' }
    const args = [
      f.releaseId,
      '--outcome',
      'rolled_back',
      '--reason',
      'Проверил хостинг',
      '--operator',
      'ops',
    ]
    await runReleasesCommand('resolve', args, env, write)
    expect(write.mock.calls.at(-1)?.[0]).toContain('версия возвращена')
    expect((await db.siteRelease.findUniqueOrThrow({ where: { id: f.releaseId } })).status).toBe(
      'rolled_back',
    )
    expect(
      (await db.siteLease.findUniqueOrThrow({ where: { siteId: f.siteId } })).heldForOperator,
    ).toBe(false)
    expect(
      await db.auditLog.count({ where: { workspaceId: f.workspaceId, action: 'release.resolve' } }),
    ).toBe(1)
    // Repeated by the operator: nothing changes.
    await runReleasesCommand('resolve', args, env, write)
    expect(write.mock.calls.at(-1)?.[0]).toContain('ничего не изменено')
    await expect(
      runReleasesCommand(
        'resolve',
        [f.releaseId, '--outcome', 'installed', '--reason', 'r', '--operator', 'ops'],
        env,
        write,
      ),
    ).rejects.toThrow('не ждёт оператора')
  })
})
