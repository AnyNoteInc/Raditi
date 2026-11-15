import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { PostgresSiteLeaseStore } from './site-leases.ts'

const databaseUrl = process.env.DATABASE_URL

describe('lease input validation', () => {
  it('rejects invalid identifiers and durations before querying', async () => {
    const $queryRaw = vi.fn()
    const store = new PostgresSiteLeaseStore({ $queryRaw })
    await expect(
      store.acquire({ siteId: 'bad', taskId: 'bad', operation: 'turn', ttlMs: 60_000 }),
    ).rejects.toThrow()
    const id = randomUUID()
    await expect(
      store.acquire({ siteId: id, taskId: id, operation: 'turn', ttlMs: 10 }),
    ).rejects.toThrow()
    await expect(store.inspect('bad')).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
  })
})

// The lease of a chat (docs/plan/83-remove-projects.md, БП6): its own row under its own id.
describe.skipIf(!databaseUrl)('PostgreSQL leases of chats', () => {
  let db: PrismaClient
  let store: PostgresSiteLeaseStore
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    store = new PostgresSiteLeaseStore(db)
  })
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      const chats = await db.task.findMany({ where: { workspaceId }, select: { id: true } })
      await db.siteLease.deleteMany({ where: { siteId: { in: chats.map(({ id }) => id) } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function chat() {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic lease verification' } })
    workspaces.push(workspace.id)
    const task = await db.task.create({ data: { workspaceId: workspace.id } })
    return { siteId: task.id, taskId: task.id, operation: 'turn' as const, ttlMs: 60_000 }
  }

  it('leases by its own id, and two chats go side by side', async () => {
    const first = await chat()
    const second = await chat()
    const [one, other] = await Promise.all([store.acquire(first), store.acquire(second)])
    expect(one).toMatchObject({ siteId: first.taskId, taskId: first.taskId, epoch: 1 })
    expect(other).toMatchObject({ siteId: second.taskId, taskId: second.taskId, epoch: 1 })
    expect(await store.assert(one!)).toBe(true)
    expect(await store.assert(other!)).toBe(true)
  })

  it('gives one of two callers at once the lease', async () => {
    const input = await chat()
    const grants = await Promise.all([store.acquire(input), store.acquire(input)])
    expect(grants.filter(Boolean)).toHaveLength(1)
  })

  it('fences a stale owner: the epoch only grows and the row stays', async () => {
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

  it('takes no lease under another id than the chat', async () => {
    const input = await chat()
    const other = await chat()
    expect(await store.acquire({ ...input, siteId: other.taskId })).toBeNull()
    expect(await store.acquire({ ...input, siteId: randomUUID() })).toBeNull()
    expect(await store.inspect(other.taskId)).toBeNull()
  })

  it('takes over an expired lease with the next epoch', async () => {
    const input = await chat()
    const first = (await store.acquire(input))!
    await db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() - interval '1 second'
      WHERE site_id = ${input.siteId}::uuid`
    expect(await store.assert(first)).toBe(false)
    const second = (await store.acquire(input))!
    expect(second.epoch).toBe(first.epoch + 1)
  })

  it('renews a live lease and tells what it holds', async () => {
    const input = await chat()
    const grant = (await store.acquire(input))!
    const renewed = (await store.renew(grant, 120_000))!
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(grant.expiresAt.getTime())
    expect(await store.inspect(input.siteId)).toMatchObject({
      siteId: input.siteId,
      taskId: input.taskId,
      operation: 'turn',
      epoch: grant.epoch,
      heldForOperator: false,
    })
  })

  it('holds a lease for an operator: nobody takes it over until it is freed', async () => {
    const input = await chat()
    const grant = (await store.acquire(input))!
    expect(await store.holdForRecovery(grant)).toBe(true)
    expect(await store.assert(grant)).toBe(false)
    expect(await store.release(grant)).toBe(false)
    await db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() - interval '1 second'
      WHERE site_id = ${input.siteId}::uuid`
    expect(await store.acquire(input)).toBeNull()
    expect(await store.free(grant)).toBe(true)
    expect((await store.acquire(input))?.epoch).toBe(grant.epoch + 1)
  })
})
