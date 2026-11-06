import { randomUUID } from 'node:crypto'

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
      const sites = await db.site.findMany({ where: { workspaceId }, select: { id: true } })
      // A chat leases its own row with or without a site (`turnLeaseOf`).
      const chats = await db.task.findMany({ where: { workspaceId }, select: { id: true } })
      await db.siteLease.deleteMany({
        where: { siteId: { in: [...sites, ...chats].map(({ id }) => id) } },
      })
      await db.siteRelease.deleteMany({ where: { site: { workspaceId } } })
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

  /** A chat without a project: its lease is its own id (`leaseScopeOf`). */
  async function chat(workspaceId?: string) {
    const workspace =
      workspaceId ??
      (await db.workspace.create({ data: { name: 'Synthetic lease verification' } })).id
    if (workspaceId === undefined) workspaces.push(workspace)
    const task = await db.task.create({
      data: { workspaceId: workspace, needsRepository: false, needsBrowser: false },
    })
    return { siteId: task.id, taskId: task.id, operation: 'turn' as const, ttlMs: 60_000 }
  }

  describe('a chat without a site', () => {
    it('leases by its own id, and two chats go side by side', async () => {
      const first = await chat()
      const second = await chat()
      const [one, other] = await Promise.all([store.acquire(first), store.acquire(second)])
      expect(one).toMatchObject({ siteId: first.taskId, taskId: first.taskId, epoch: 1 })
      expect(other).toMatchObject({ siteId: second.taskId, taskId: second.taskId, epoch: 1 })
      expect(await store.assert(one!)).toBe(true)
      expect(await store.assert(other!)).toBe(true)
    })

    it('fences a stale owner of a chat: the epoch only grows and the row stays', async () => {
      const input = await chat()
      const first = (await store.acquire(input))!
      expect(await store.release(first)).toBe(true)
      const second = (await store.acquire(input))!
      expect(second.epoch).toBe(first.epoch + 1)
      expect(await store.renew(first, 60_000)).toBeNull()
      expect(await store.assert(first)).toBe(false)
      expect(await store.release(first)).toBe(false)
      expect(await store.assert(second)).toBe(true)
    })

    it('takes neither the lease of a site nor of another chat', async () => {
      const site = await fixture()
      const input = await chat()
      const other = await chat()
      expect(await store.acquire({ ...input, siteId: site.siteId })).toBeNull()
      expect(await store.acquire({ ...input, siteId: other.taskId })).toBeNull()
      expect(await store.inspect(site.siteId)).toBeNull()
      expect(await store.inspect(other.taskId)).toBeNull()
    })

    // The owner, 06.11.2026: the chats of one project work side by side (`turnLeaseOf`).
    it('lets two tasks of one site lease their own rows at once, beside the site', async () => {
      const site = await fixture()
      const first = await store.acquire({ ...site, siteId: site.taskId })
      const second = await store.acquire({
        ...site,
        taskId: site.otherTaskId,
        siteId: site.otherTaskId,
      })
      expect(first).toMatchObject({ siteId: site.taskId, taskId: site.taskId })
      expect(second).toMatchObject({ siteId: site.otherTaskId, taskId: site.otherTaskId })
      // The site's own row stays free for a release.
      expect(await store.acquire({ ...site, operation: 'deploy' })).not.toBeNull()
    })

    it('starts no turn of the site on its own row while a release holds the site', async () => {
      const site = await fixture()
      const release = await store.acquire({ ...site, operation: 'deploy' })
      expect(release).not.toBeNull()
      const own = { ...site, taskId: site.otherTaskId, siteId: site.otherTaskId }
      expect(await store.acquire(own)).toBeNull()
      expect(await store.release(release!)).toBe(true)
      expect(await store.acquire(own)).not.toBeNull()
    })

    it('never lets a task lease the row of another task', async () => {
      const site = await fixture()
      expect(await store.acquire({ ...site, siteId: site.otherTaskId })).toBeNull()
    })

    it('is refused by the database with the id of a site', async () => {
      const site = await fixture()
      const id = `${randomUUID().slice(0, 14)}8${randomUUID().slice(15)}`
      const workspace = await db.site.findUniqueOrThrow({ where: { id: site.siteId } })
      const product = await db.site.create({
        data: {
          id,
          workspaceId: workspace.workspaceId,
          name: 'Lease test',
          url: 'https://product.invalid',
          stack: 'wordpress',
        },
      })
      await expect(
        db.task.create({
          data: {
            id: product.id,
            workspaceId: workspace.workspaceId,
            needsRepository: false,
            needsBrowser: false,
          },
        }),
      ).rejects.toThrow(/tasks_chat_id_check/)
    })
  })

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

  it('frees its exact epoch in one statement, held or expired, never another owner’s', async () => {
    const input = await fixture()
    const lease = (await store.acquire(input))!
    expect(await store.holdForRecovery(lease)).toBe(true)
    await db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE site_id = ${input.siteId}::uuid`
    expect(await store.free({ ...lease, epoch: lease.epoch + 1 })).toBe(false)
    expect(await store.free({ ...lease, taskId: input.otherTaskId })).toBe(false)
    expect(await store.free({ ...lease, operation: 'deploy' })).toBe(false)
    expect(await store.free(lease)).toBe(true)
    expect(await store.inspect(input.siteId)).toMatchObject({
      taskId: null,
      operation: null,
      expiresAt: null,
      heldForOperator: false,
      epoch: lease.epoch,
    })
    // Its fence is gone for good: the next owner starts a newer epoch.
    expect(await store.free(lease)).toBe(false)
    expect(await store.holdForRecovery(lease)).toBe(false)
    const next = (await store.acquire({ ...input, taskId: input.otherTaskId }))!
    expect(next.epoch).toBe(lease.epoch + 1)
    expect(await store.free(lease)).toBe(false)
    expect(await store.assert(next)).toBe(true)
  })

  /** A release of the first task's candidate, as the barrier names it. */
  async function releaseOf(input: Awaited<ReturnType<typeof fixture>>): Promise<string> {
    const candidate = await db.taskCandidate.create({
      data: {
        taskId: input.taskId,
        revision: 1,
        turnNo: 1,
        baseSha: 'a'.repeat(40),
        baseTree: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
        dbPlanSha256: 'd'.repeat(64),
        proposedBump: 'patch',
        proposedVersion: 'v0.0.1',
        facts: {},
      },
    })
    const release = await db.siteRelease.create({
      data: {
        siteId: input.siteId,
        taskId: input.taskId,
        candidateId: candidate.id,
        candidateRevision: 1,
        attempt: 1,
        releaseKey: 'e'.repeat(64),
        version: 'v0.0.1',
        tag: 'v0.0.1',
        bump: 'patch',
        mainBeforeSha: 'a'.repeat(40),
        approvedSha: 'f'.repeat(40),
        mainPushedAt: new Date(),
        status: 'deploying',
        committedAt: new Date(),
        approvedAt: new Date(),
      },
    })
    return release.id
  }

  it('refuses the site while a release barrier stands, expired or not, and never frees it', async () => {
    const input = await fixture()
    const deploy = (await store.acquire({ ...input, operation: 'deploy' }))!
    const releaseId = await releaseOf(input)
    await db.$executeRaw`UPDATE site_leases SET inflight_release_id = ${releaseId}::uuid WHERE site_id = ${input.siteId}::uuid`
    expect(await store.inspect(input.siteId)).toMatchObject({
      operation: 'deploy',
      inflightReleaseId: releaseId,
    })
    // core died mid-release: the deploy lease expired, the barrier stands. A turn of another
    // dialog is told the site is busy instead of failing on the barrier's CHECK.
    await db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE site_id = ${input.siteId}::uuid`
    expect(await store.acquire({ ...input, taskId: input.otherTaskId })).toBeNull()
    expect(await store.acquire({ ...input, operation: 'deploy' })).toBeNull()
    expect(await store.free(deploy)).toBe(false)
    expect(await store.inspect(input.siteId)).toMatchObject({
      taskId: input.taskId,
      epoch: deploy.epoch,
      inflightReleaseId: releaseId,
    })
    // Live, the deploy keeps its lease until the release clears the barrier itself.
    await db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() + interval '1 minute' WHERE site_id = ${input.siteId}::uuid`
    expect(await store.release(deploy)).toBe(false)
    expect(await store.assert(deploy)).toBe(true)
    await db.$executeRaw`UPDATE site_leases SET inflight_release_id = NULL WHERE site_id = ${input.siteId}::uuid`
    expect(await store.release(deploy)).toBe(true)
    const next = await store.acquire({ ...input, taskId: input.otherTaskId })
    expect(next).toMatchObject({ operation: 'turn', epoch: deploy.epoch + 1 })
    expect(await store.inspect(input.siteId)).toMatchObject({ inflightReleaseId: null })
  })

  it('refuses a task belonging to another site', async () => {
    const input = await fixture()
    const other = await fixture()
    expect(await store.acquire({ ...input, taskId: other.taskId })).toBeNull()
    expect(await store.inspect(input.siteId)).toBeNull()
  })
})
