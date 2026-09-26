import { createPrismaClient, PostgresSiteLeaseStore, type PrismaClient } from '@repo/db'
import type { SiteLeaseGrant, TurnEvidence } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { TaskEventTurnJournal } from './turn-journal.ts'

describe('turn journal boundary', () => {
  it('refuses arbitrary raw errors and prepared credentials in evidence', async () => {
    const $queryRaw = vi.fn()
    await expect(
      new TaskEventTurnJournal({ $queryRaw }).record({
        rawError: 'must not persist',
        prepared: { apiKey: 'secret' },
      } as unknown as TurnEvidence),
    ).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
  })
})

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('durable fenced turn evidence', () => {
  let db: PrismaClient
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
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
    const ws = await db.workspace.create({ data: { name: 'Synthetic turn journal verification' } })
    workspaces.push(ws.id)
    const site = await db.site.create({
      data: {
        workspaceId: ws.id,
        name: 'Journal test',
        url: 'https://journal.invalid',
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({ data: { workspaceId: ws.id, siteId: site.id } })
    const leases = new PostgresSiteLeaseStore(db)
    const fence = (await leases.acquire({
      siteId: site.id,
      taskId: task.id,
      operation: 'turn',
      ttlMs: 60_000,
    })) as SiteLeaseGrant
    const evidence: TurnEvidence = {
      fence,
      sessionId: 'synthetic',
      turn: 1,
      sequence: 1,
      phase: 'leased',
    }
    return { task, leases, fence, evidence, journal: new TaskEventTurnJournal(db) }
  }

  it('persists bounded operational evidence without changing task status', async () => {
    const f = await fixture()
    await f.journal.record(f.evidence)
    const row = await db.taskEvent.findFirstOrThrow({ where: { taskId: f.task.id } })
    expect(row.type).toBe('turn.lifecycle')
    expect(row.clientVisible).toBe(false)
    expect(row.payload).toMatchObject({ phase: 'leased', fence: { epoch: 1 } })
    expect(JSON.stringify(row.payload)).not.toContain('serverNow')
    expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).status).toBe('queued')
  })

  it('permits recovery evidence under a held lease but refuses normal progress', async () => {
    const f = await fixture()
    await f.leases.holdForRecovery(f.fence)
    await f.journal.record({ ...f.evidence, phase: 'recovery', reason: 'snapshot_ambiguous' })
    await expect(f.journal.record({ ...f.evidence, phase: 'running' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(await db.taskEvent.count({ where: { taskId: f.task.id } })).toBe(1)
  })

  it('refuses old-epoch evidence after a newer owner acquires the site', async () => {
    const f = await fixture()
    await f.leases.release(f.fence)
    await f.leases.acquire({
      siteId: f.fence.siteId,
      taskId: f.fence.taskId,
      operation: 'turn',
      ttlMs: 60_000,
    })
    await expect(f.journal.record({ ...f.evidence, phase: 'recovery' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(await db.taskEvent.count({ where: { taskId: f.task.id } })).toBe(0)
  })
})
