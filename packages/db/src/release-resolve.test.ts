import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { RELEASE_RESOLVE_AUDIT_ACTION, resolveRelease } from './release-resolve.ts'

const databaseUrl = process.env.DATABASE_URL

describe('the decision of an operator, validation', () => {
  it('refuses a reason with control characters and an outcome that is not a decision', async () => {
    const db = {} as Parameters<typeof resolveRelease>[0]
    const input = { releaseId: randomUUID(), operator: 'ops', reason: 'проверил хостинг' }
    await expect(resolveRelease(db, { ...input, outcome: 'failed' as never })).rejects.toThrow()
    await expect(
      resolveRelease(db, { ...input, outcome: 'installed', reason: 'a\u0007b' }),
    ).rejects.toThrow()
    await expect(
      resolveRelease(db, { ...input, outcome: 'installed', reason: ' ' }),
    ).rejects.toThrow()
  })
})

describe.skipIf(!databaseUrl)('the decision of an operator on PostgreSQL', () => {
  let db: PrismaClient
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      const releases = await db.siteRelease.findMany({
        where: { site: { workspaceId } },
        select: { id: true },
      })
      await db.outboxEvent.deleteMany({
        where: {
          OR: releases.map(({ id }) => ({ dedupeKey: { startsWith: `release.advance:${id}` } })),
        },
      })
      await db.auditLog.deleteMany({ where: { workspaceId } })
      await db.siteLease.deleteMany({ where: { site: { workspaceId } } })
      await db.siteRelease.deleteMany({ where: { site: { workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.site.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /**
   * A release whose outcome nobody could prove: its barrier and lease held for the operator —
   * unless `held` says otherwise (core still trying, or a status that does not wait for one).
   */
  async function fixture(
    status: 'unknown' | 'deploying' | 'failed' | 'rolled_back' = 'unknown',
    held: boolean = status === 'unknown',
  ) {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic release resolve' } })
    workspaces.push(workspace.id)
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Release resolve',
        url: 'https://fixture.invalid',
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({
      data: { workspaceId: workspace.id, siteId: site.id, status: 'deploying' },
    })
    const candidate = await db.taskCandidate.create({
      data: {
        taskId: task.id,
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
        siteId: site.id,
        taskId: task.id,
        candidateId: candidate.id,
        candidateRevision: 1,
        attempt: 1,
        releaseKey: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        version: 'v0.0.1',
        tag: 'v0.0.1',
        bump: 'patch',
        mainBeforeSha: 'a'.repeat(40),
        approvedSha: 'f'.repeat(40),
        mainPushedAt: new Date(),
        status,
        leaseEpoch: 3,
        committedAt: new Date(),
        approvedAt: new Date(),
      },
    })
    await db.siteLease.create({
      data: {
        siteId: site.id,
        holderTaskId: task.id,
        operation: 'deploy',
        epoch: 3,
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        heldForOperator: held,
        inflightReleaseId: release.id,
      },
    })
    return { workspaceId: workspace.id, siteId: site.id, releaseId: release.id }
  }

  const decide = (releaseId: string, outcome: 'installed' | 'rolled_back') =>
    db.$transaction((tx) =>
      resolveRelease(tx, { releaseId, outcome, operator: 'ops', reason: 'Проверил хостинг' }),
    )

  it('writes the decision, hands the lease back, keeps an audit entry and wakes the release', async () => {
    const f = await fixture()
    expect(await decide(f.releaseId, 'rolled_back')).toEqual({
      kind: 'resolved',
      status: 'rolled_back',
      siteId: f.siteId,
      version: 'v0.0.1',
    })
    expect((await db.siteRelease.findUniqueOrThrow({ where: { id: f.releaseId } })).status).toBe(
      'rolled_back',
    )
    expect(await db.siteLease.findUniqueOrThrow({ where: { siteId: f.siteId } })).toMatchObject({
      heldForOperator: false,
      inflightReleaseId: f.releaseId,
    })
    expect(
      await db.auditLog.findMany({
        where: { workspaceId: f.workspaceId },
        select: { actorType: true, actorId: true, action: true, targetId: true, meta: true },
      }),
    ).toEqual([
      {
        actorType: 'operator',
        actorId: 'ops',
        action: RELEASE_RESOLVE_AUDIT_ACTION,
        targetId: f.releaseId,
        meta: { outcome: 'rolled_back', reason: 'Проверил хостинг' },
      },
    ])
    expect(
      await db.outboxEvent.count({
        where: { dedupeKey: { startsWith: `release.advance:${f.releaseId}:rolled_back:` } },
      }),
    ).toBe(1)
    // The same decision again changes nothing; another one is refused.
    expect(await decide(f.releaseId, 'rolled_back')).toMatchObject({ kind: 'repeated' })
    expect(await decide(f.releaseId, 'installed')).toEqual({
      kind: 'refused',
      status: 'rolled_back',
    })
    expect(await db.auditLog.count({ where: { workspaceId: f.workspaceId } })).toBe(1)
  })

  it('refuses an unknown release core has not handed to the operator yet', async () => {
    const f = await fixture('unknown', false)
    expect(await decide(f.releaseId, 'rolled_back')).toEqual({
      kind: 'not_held',
      status: 'unknown',
    })
    expect((await db.siteRelease.findUniqueOrThrow({ where: { id: f.releaseId } })).status).toBe(
      'unknown',
    )
    expect(await db.auditLog.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
  })

  it('hands back an ended release whose revert commit could not land, as `rolled_back` only', async () => {
    const f = await fixture('failed', true)
    expect(await decide(f.releaseId, 'installed')).toEqual({ kind: 'refused', status: 'failed' })
    expect(await decide(f.releaseId, 'rolled_back')).toEqual({
      kind: 'revert_retried',
      status: 'failed',
      siteId: f.siteId,
      version: 'v0.0.1',
    })
    // The status stays: core ends the release from it once the revert commit lands.
    expect((await db.siteRelease.findUniqueOrThrow({ where: { id: f.releaseId } })).status).toBe(
      'failed',
    )
    expect(await db.siteLease.findUniqueOrThrow({ where: { siteId: f.siteId } })).toMatchObject({
      heldForOperator: false,
      inflightReleaseId: f.releaseId,
    })
    expect(
      await db.auditLog.findMany({
        where: { workspaceId: f.workspaceId },
        select: { action: true, meta: true },
      }),
    ).toEqual([
      {
        action: RELEASE_RESOLVE_AUDIT_ACTION,
        meta: { outcome: 'rolled_back', reason: 'Проверил хостинг', retry: 'revert' },
      },
    ])
    expect(
      await db.outboxEvent.count({
        where: { dedupeKey: { startsWith: `release.advance:${f.releaseId}:failed:` } },
      }),
    ).toBe(1)
    // Handed back: no longer the operator's.
    expect(await decide(f.releaseId, 'rolled_back')).toEqual({ kind: 'refused', status: 'failed' })
  })

  it('refuses an ended release that is not held, though its revert is open', async () => {
    const f = await fixture('rolled_back', false)
    expect(await decide(f.releaseId, 'rolled_back')).toEqual({
      kind: 'refused',
      status: 'rolled_back',
    })
  })

  it('refuses a release that does not wait for an operator, and an unknown id', async () => {
    const f = await fixture('deploying')
    expect(await decide(f.releaseId, 'installed')).toEqual({ kind: 'refused', status: 'deploying' })
    expect(await decide(randomUUID(), 'installed')).toEqual({ kind: 'not_found' })
    expect(await db.auditLog.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
  })
})
