import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { PostgresSiteLeaseStore } from './site-leases.ts'

const databaseUrl = process.env.DATABASE_URL

describe('site lease input validation', () => {
  it('rejects invalid identifiers and durations before querying', async () => {
    const $queryRaw = vi.fn()
    const store = new PostgresSiteLeaseStore({ $queryRaw })
    await expect(
      store.acquire({ siteId: 'bad', taskId: 'bad', operation: 'turn', ttlMs: 60_000 }),
    ).rejects.toThrow()
    await expect(store.inspect('bad')).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL site leases', () => {
  let db: PrismaClient
  let store: PostgresSiteLeaseStore
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    store = new PostgresSiteLeaseStore(db)
  })
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      await db.siteLease.deleteMany({ where: { site: { workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.site.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function fixture() {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic lease verification' } })
    workspaces.push(workspace.id)
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Lease test',
        url: 'https://fixture.invalid',
        stack: 'wordpress',
      },
    })
    const tasks = await Promise.all(
      [1, 2].map(() => db.task.create({ data: { workspaceId: workspace.id, siteId: site.id } })),
    )
    return {
      siteId: site.id,
      taskId: tasks[0]!.id,
      otherTaskId: tasks[1]!.id,
      operation: 'turn' as const,
      ttlMs: 60_000,
    }
  }

  it('grants exactly one concurrent owner and uses a server-clock TTL', async () => {
    const input = await fixture()
    const results = await Promise.all(Array.from({ length: 12 }, () => store.acquire(input)))
    const won = results.filter((value) => value !== null)
    expect(won).toHaveLength(1)
    const lease = won[0]!
    expect(lease.epoch).toBe(1)
    expect(lease.expiresAt.getTime() - lease.serverNow.getTime()).toBe(60_000)
    expect(await store.assert(lease)).toBe(true)
    expect(await store.renew(lease, 45_000)).toMatchObject({ epoch: 1 })
    expect(await store.assert({ ...lease, taskId: input.otherTaskId })).toBe(false)
    expect(await store.assert({ ...lease, operation: 'deploy' })).toBe(false)
  })

  it('preserves monotonically increasing epochs through release and fences stale owners', async () => {
    const input = await fixture()
    const first = (await store.acquire(input))!
    expect(await store.release(first)).toBe(true)
    const second = (await store.acquire({ ...input, taskId: input.otherTaskId }))!
    expect(second.epoch).toBe(first.epoch + 1)
    expect(await store.renew(first, 60_000)).toBeNull()
    expect(await store.release(first)).toBe(false)
    expect(await store.holdForRecovery(first)).toBe(false)
    expect(await store.assert(second)).toBe(true)
  })

  it('never resurrects an expired owner and allows a new epoch', async () => {
    const input = await fixture()
    const first = (await store.acquire(input))!
    await db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE site_id = ${input.siteId}::uuid`
    expect(await store.assert(first)).toBe(false)
    expect(await store.renew(first, 60_000)).toBeNull()
    expect(await store.release(first)).toBe(false)
    const next = await store.acquire({ ...input, operation: 'revert' })
    expect(next?.epoch).toBe(first.epoch + 1)
  })

  it('holds ambiguous outcomes even past expiry until operator reconciliation', async () => {
    const input = await fixture()
    const lease = (await store.acquire(input))!
    expect(await store.holdForRecovery(lease)).toBe(true)
    await db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE site_id = ${input.siteId}::uuid`
    expect(await store.acquire(input)).toBeNull()
    expect(await store.renew(lease, 60_000)).toBeNull()
    expect(await store.release(lease)).toBe(false)
    expect(await store.inspect(input.siteId)).toMatchObject({
      heldForOperator: true,
      epoch: lease.epoch,
    })
  })

  it('does not renew a lease that expires while waiting for a row lock', async () => {
    const input = await fixture()
    const lease = (await store.acquire(input))!
    let locked: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      locked = resolve
    })
    const blocking = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT site_id FROM site_leases WHERE site_id = ${input.siteId}::uuid FOR UPDATE`
      await tx.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() + interval '50 milliseconds' WHERE site_id = ${input.siteId}::uuid`
      locked()
      await tx.$executeRaw`SELECT pg_sleep(0.15)`
    })
    await ready
    const renewed = store.renew(lease, 60_000)
    await blocking
    expect(await renewed).toBeNull()
  })

  it('requires an explicit held fence for recovery and advances its epoch', async () => {
    const input = await fixture()
    const first = (await store.acquire(input))!
    expect(await store.reclaimForRecovery(first, 60_000)).toBeNull()
    await store.holdForRecovery(first)
    expect(await store.reclaimForRecovery({ ...first, epoch: first.epoch + 1 }, 60_000)).toBeNull()
    const recovered = await store.reclaimForRecovery(first, 60_000)
    expect(recovered?.epoch).toBe(first.epoch + 1)
    expect(await store.assert(first)).toBe(false)
    expect(await store.assert(recovered!)).toBe(true)
    expect(await store.reclaimForRecovery(first, 60_000)).toBeNull()
  })

  it('refuses a task belonging to another site', async () => {
    const input = await fixture()
    const other = await fixture()
    expect(await store.acquire({ ...input, taskId: other.taskId })).toBeNull()
    expect(await store.inspect(input.siteId)).toBeNull()
  })
})
