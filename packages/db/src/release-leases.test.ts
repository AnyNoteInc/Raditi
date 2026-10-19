import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  freeReleaseLease,
  holdReleaseForOperator,
  ownsReleaseLease,
  raiseReleaseBarrier,
  recordReleaseLease,
  renewReleaseLease,
  returnReleaseFromOperator,
  takeOverReleaseLease,
} from './release-leases.ts'
import {
  recordReleaseStep,
  releaseAttemptWrote,
  releaseWritingAttempt,
  wakeRelease,
} from './release-records.ts'
import { PostgresSiteLeaseStore } from './site-leases.ts'

const databaseUrl = process.env.DATABASE_URL

describe('release lease input validation', () => {
  it('rejects invalid identifiers, epochs and durations before querying', async () => {
    const $queryRaw = vi.fn()
    const db = { $queryRaw }
    await expect(takeOverReleaseLease(db, { releaseId: 'bad', ttlMs: 60_000 })).rejects.toThrow()
    await expect(
      takeOverReleaseLease(db, { releaseId: randomUUID(), ttlMs: 60 * 60_000 }),
    ).rejects.toThrow()
    await expect(recordReleaseLease(db, { releaseId: randomUUID(), epoch: 0 })).rejects.toThrow()
    await expect(
      ownsReleaseLease(db, { releaseId: randomUUID(), epoch: 1, statuses: [] }),
    ).rejects.toThrow()
    await expect(
      recordReleaseStep(db, {
        releaseId: randomUUID(),
        deployAttempt: 1,
        step: 'files',
        state: 'started',
        reportKey: 'bad key',
        detail: {},
      }),
    ).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
  })
})

describe.skipIf(!databaseUrl)('the site lease of a release on PostgreSQL', () => {
  let db: PrismaClient
  let store: PostgresSiteLeaseStore
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    store = new PostgresSiteLeaseStore(db)
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

  /** A dialog waiting for its release, another dialog of the same site, and the release. */
  async function fixture(status: 'approved' | 'publishing' = 'approved') {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic release lease' } })
    workspaces.push(workspace.id)
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Release lease',
        url: 'https://fixture.invalid',
        stack: 'wordpress',
      },
    })
    const [task, other] = await Promise.all(
      [1, 2].map(() =>
        db.task.create({
          data: { workspaceId: workspace.id, siteId: site.id, status: 'deploying' },
        }),
      ),
    )
    const candidate = await db.taskCandidate.create({
      data: {
        taskId: task!.id,
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
        taskId: task!.id,
        candidateId: candidate.id,
        candidateRevision: 1,
        attempt: 1,
        releaseKey: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        version: 'v0.0.1',
        tag: 'v0.0.1',
        bump: 'patch',
        mainBeforeSha: 'a'.repeat(40),
        status,
        committedAt: new Date(),
        approvedAt: new Date(),
      },
    })
    return { siteId: site.id, taskId: task!.id, otherTaskId: other!.id, releaseId: release.id }
  }

  /** The lease of an `approved` release, acquired the way the skill acquires it. */
  async function leased(f: Awaited<ReturnType<typeof fixture>>) {
    const grant = (await store.acquire({
      siteId: f.siteId,
      taskId: f.taskId,
      operation: 'deploy',
      ttlMs: 60_000,
    }))!
    expect(await recordReleaseLease(db, { releaseId: f.releaseId, epoch: grant.epoch })).toBe(true)
    return grant
  }

  /** From `published` on a release has its commit on `main` (CHECK site_releases_main_pushed_check). */
  const setStatus = (releaseId: string, status: string) =>
    db.$executeRaw`UPDATE site_releases SET status = ${status}::"ReleaseStatus",
      approved_sha = COALESCE(approved_sha, ${'e'.repeat(40)}),
      main_pushed_at = CASE WHEN ${status} IN ('approved', 'publishing') THEN main_pushed_at
        ELSE COALESCE(main_pushed_at, clock_timestamp()) END
      WHERE id = ${releaseId}::uuid`
  const expire = (siteId: string) =>
    db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE site_id = ${siteId}::uuid`

  it('records the acquired lease once, and only while the release is approved', async () => {
    const f = await fixture()
    const grant = await leased(f)
    // The same epoch again, or an older one: a newer run recorded it already.
    expect(await recordReleaseLease(db, { releaseId: f.releaseId, epoch: grant.epoch })).toBe(false)
    expect(
      await ownsReleaseLease(db, {
        releaseId: f.releaseId,
        epoch: grant.epoch,
        statuses: ['approved'],
      }),
    ).toBe(true)
    // Before the barrier the lease is the release's only while it is approved.
    expect(
      await ownsReleaseLease(db, {
        releaseId: f.releaseId,
        epoch: grant.epoch,
        statuses: ['publishing'],
      }),
    ).toBe(false)
    await setStatus(f.releaseId, 'publishing')
    expect(await recordReleaseLease(db, { releaseId: f.releaseId, epoch: grant.epoch + 1 })).toBe(
      false,
    )
  })

  it('raises the barrier under a live lease once; acquire refuses the site from then on', async () => {
    const f = await fixture()
    const grant = await leased(f)
    expect(await raiseReleaseBarrier(db, { releaseId: f.releaseId, epoch: grant.epoch + 1 })).toBe(
      false,
    )
    expect(await raiseReleaseBarrier(db, { releaseId: f.releaseId, epoch: grant.epoch })).toBe(true)
    expect(await raiseReleaseBarrier(db, { releaseId: f.releaseId, epoch: grant.epoch })).toBe(
      false,
    )
    expect(await store.inspect(f.siteId)).toMatchObject({
      operation: 'deploy',
      taskId: f.taskId,
      inflightReleaseId: f.releaseId,
    })
    await setStatus(f.releaseId, 'publishing')
    await expire(f.siteId)
    // Expired, the site still belongs to the release: no turn and no other deploy takes it.
    expect(
      await store.acquire({
        siteId: f.siteId,
        taskId: f.otherTaskId,
        operation: 'turn',
        ttlMs: 60_000,
      }),
    ).toBeNull()
    expect(await store.free(grant)).toBe(false)
    expect(await store.release(grant)).toBe(false)
  })

  it('refuses the barrier under an expired lease', async () => {
    const f = await fixture()
    const grant = await leased(f)
    await expire(f.siteId)
    expect(await raiseReleaseBarrier(db, { releaseId: f.releaseId, epoch: grant.epoch })).toBe(
      false,
    )
  })

  it('takes the lease over at the next epoch, expired or not, and fences the older run', async () => {
    const f = await fixture()
    const grant = await leased(f)
    // Before the barrier, while approved.
    const first = (await takeOverReleaseLease(db, { releaseId: f.releaseId, ttlMs: 60_000 }))!
    expect(first).toMatchObject({ siteId: f.siteId, taskId: f.taskId, epoch: grant.epoch + 1 })
    expect(
      await ownsReleaseLease(db, {
        releaseId: f.releaseId,
        epoch: grant.epoch,
        statuses: ['approved'],
      }),
    ).toBe(false)
    expect(await raiseReleaseBarrier(db, { releaseId: f.releaseId, epoch: first.epoch })).toBe(true)
    await setStatus(f.releaseId, 'publishing')
    await expire(f.siteId)
    const second = (await takeOverReleaseLease(db, { releaseId: f.releaseId, ttlMs: 60_000 }))!
    expect(second.epoch).toBe(first.epoch + 1)
    expect(second.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(
      await ownsReleaseLease(db, {
        releaseId: f.releaseId,
        epoch: second.epoch,
        statuses: ['publishing'],
      }),
    ).toBe(true)
    expect(
      await ownsReleaseLease(db, {
        releaseId: f.releaseId,
        epoch: first.epoch,
        statuses: ['publishing'],
      }),
    ).toBe(false)
    expect(await store.inspect(f.siteId)).toMatchObject({
      epoch: second.epoch,
      inflightReleaseId: f.releaseId,
    })
  })

  it('cannot take over a lease another dialog acquired after an approved release lost it', async () => {
    const f = await fixture()
    await leased(f)
    await expire(f.siteId)
    const turn = await store.acquire({
      siteId: f.siteId,
      taskId: f.otherTaskId,
      operation: 'turn',
      ttlMs: 60_000,
    })
    expect(turn).not.toBeNull()
    expect(await takeOverReleaseLease(db, { releaseId: f.releaseId, ttlMs: 60_000 })).toBeNull()
  })

  it('holds the site for the operator, hands it back, and frees it with the barrier', async () => {
    const f = await fixture()
    const grant = await leased(f)
    expect(await raiseReleaseBarrier(db, { releaseId: f.releaseId, epoch: grant.epoch })).toBe(true)
    await setStatus(f.releaseId, 'unknown')
    expect(await renewReleaseLease(db, { releaseId: f.releaseId, ttlMs: 120_000 })).toBe(true)
    expect(await holdReleaseForOperator(db, { releaseId: f.releaseId })).toBe(true)
    // Once: the call that marked it writes the feed row.
    expect(await holdReleaseForOperator(db, { releaseId: f.releaseId })).toBe(false)
    expect(await renewReleaseLease(db, { releaseId: f.releaseId, ttlMs: 120_000 })).toBe(false)
    expect(await takeOverReleaseLease(db, { releaseId: f.releaseId, ttlMs: 60_000 })).toBeNull()
    expect(await store.inspect(f.siteId)).toMatchObject({
      heldForOperator: true,
      inflightReleaseId: f.releaseId,
    })
    expect(await returnReleaseFromOperator(db, { releaseId: f.releaseId })).toBe(true)
    expect(await returnReleaseFromOperator(db, { releaseId: f.releaseId })).toBe(false)
    await setStatus(f.releaseId, 'rolled_back')
    const lease = (await takeOverReleaseLease(db, { releaseId: f.releaseId, ttlMs: 60_000 }))!
    expect(await freeReleaseLease(db, { releaseId: f.releaseId, epoch: grant.epoch })).toBe(false)
    expect(await freeReleaseLease(db, { releaseId: f.releaseId, epoch: lease.epoch })).toBe(true)
    expect(await store.inspect(f.siteId)).toMatchObject({
      taskId: null,
      operation: null,
      heldForOperator: false,
      inflightReleaseId: null,
    })
    // The next owner acquires at the next epoch.
    expect(
      await store.acquire({
        siteId: f.siteId,
        taskId: f.otherTaskId,
        operation: 'turn',
        ttlMs: 60_000,
      }),
    ).toMatchObject({ epoch: lease.epoch + 1 })
  })

  it('keeps the reports of a job once per key and knows whether an attempt wrote', async () => {
    const f = await fixture('publishing')
    const report = (step: 'conflicts' | 'files', state: 'started' | 'succeeded') => ({
      releaseId: f.releaseId,
      deployAttempt: 1,
      step,
      state,
      reportKey: `1:${step}:${state}`,
      detail: { files: 2 },
    })
    expect(await recordReleaseStep(db, report('conflicts', 'started'))).toBe(true)
    expect(await recordReleaseStep(db, report('conflicts', 'started'))).toBe(false)
    expect(await releaseAttemptWrote(db, { releaseId: f.releaseId, deployAttempt: 1 })).toBe(false)
    expect(await releaseWritingAttempt(db, { releaseId: f.releaseId })).toBeNull()
    expect(await recordReleaseStep(db, report('files', 'started'))).toBe(true)
    expect(await releaseWritingAttempt(db, { releaseId: f.releaseId })).toBe(1)
    expect(await releaseAttemptWrote(db, { releaseId: f.releaseId, deployAttempt: 1 })).toBe(true)
    expect(await releaseAttemptWrote(db, { releaseId: f.releaseId, deployAttempt: 2 })).toBe(false)
    expect(await db.releaseStep.count({ where: { releaseId: f.releaseId } })).toBe(2)
  })

  it('wakes a release with a new key every time: the counter of the row is in it', async () => {
    const f = await fixture('publishing')
    const at = new Date(Date.now() + 60_000)
    expect(await db.$transaction((tx) => wakeRelease(tx, { releaseId: f.releaseId }))).toBe(true)
    expect(
      await db.$transaction((tx) => wakeRelease(tx, { releaseId: f.releaseId, availableAt: at })),
    ).toBe(true)
    expect(await db.$transaction((tx) => wakeRelease(tx, { releaseId: randomUUID() }))).toBe(false)
    const rows = await db.outboxEvent.findMany({
      where: { dedupeKey: { startsWith: `release.advance:${f.releaseId}` } },
      orderBy: { id: 'asc' },
      select: { dedupeKey: true, topic: true, payload: true, availableAt: true },
    })
    expect(rows.map((row) => row.dedupeKey)).toEqual([
      `release.advance:${f.releaseId}:publishing:-:2`,
      `release.advance:${f.releaseId}:publishing:-:3`,
    ])
    expect(rows[0]).toMatchObject({
      topic: 'deploys',
      payload: { releaseId: f.releaseId, status: 'publishing', step: null, seq: 2 },
    })
    expect(rows[1]!.availableAt.getTime()).toBe(at.getTime())
    expect((await db.siteRelease.findUniqueOrThrow({ where: { id: f.releaseId } })).enqueues).toBe(
      3,
    )
  })
})
