import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { installRelease, markSiteCandidatesStale } from './release-install.ts'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('an installed release on PostgreSQL', () => {
  let db: PrismaClient
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      await db.site.updateMany({ where: { workspaceId }, data: { installedReleaseId: null } })
      await db.siteRelease.deleteMany({ where: { site: { workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.site.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function site(workspaceId: string) {
    return db.site.create({
      data: {
        workspaceId,
        name: 'Release install',
        url: `https://${randomUUID()}.invalid`,
        stack: 'wordpress',
      },
    })
  }

  /** A dialog of the site with its current candidate. */
  async function dialog(
    workspaceId: string,
    siteId: string,
    status: 'current' | 'superseded' = 'current',
  ) {
    const task = await db.task.create({
      data: { workspaceId, siteId, status: 'awaiting_approval' },
    })
    const candidate = await db.taskCandidate.create({
      data: {
        taskId: task.id,
        revision: 1,
        turnNo: 1,
        status,
        supersededAt: status === 'superseded' ? new Date() : null,
        baseSha: 'a'.repeat(40),
        baseTree: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
        dbPlanSha256: 'd'.repeat(64),
        proposedBump: 'patch',
        proposedVersion: 'v0.0.1',
        facts: {},
      },
    })
    return { taskId: task.id, candidateId: candidate.id }
  }

  async function fixture() {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic release install' } })
    workspaces.push(workspace.id)
    const own = await site(workspace.id)
    const released = await dialog(workspace.id, own.id)
    const sibling = await dialog(workspace.id, own.id)
    const old = await dialog(workspace.id, own.id, 'superseded')
    const elsewhere = await dialog(workspace.id, (await site(workspace.id)).id)
    const release = await db.siteRelease.create({
      data: {
        siteId: own.id,
        taskId: released.taskId,
        candidateId: released.candidateId,
        candidateRevision: 1,
        attempt: 1,
        releaseKey: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        version: 'v1.2.0',
        tag: 'v1.2.0',
        bump: 'minor',
        mainBeforeSha: 'a'.repeat(40),
        approvedSha: 'f'.repeat(40),
        mainPushedAt: new Date(),
        status: 'verifying',
        committedAt: new Date(),
        approvedAt: new Date(),
      },
    })
    return { siteId: own.id, releaseId: release.id, released, sibling, old, elsewhere }
  }

  const statusOf = async (candidateId: string) =>
    (await db.taskCandidate.findUniqueOrThrow({ where: { id: candidateId } })).status

  it('records the version on the site once, releases the candidate and makes the others stale', async () => {
    const f = await fixture()
    // Not before the release is installed.
    expect(await installRelease(db, { releaseId: f.releaseId })).toBeNull()
    await db.siteRelease.update({ where: { id: f.releaseId }, data: { status: 'installed' } })
    expect(await installRelease(db, { releaseId: f.releaseId })).toEqual({
      siteId: f.siteId,
      taskId: f.released.taskId,
      candidateId: f.released.candidateId,
      staleCandidates: 1,
    })
    const site = await db.site.findUniqueOrThrow({ where: { id: f.siteId } })
    expect(site).toMatchObject({
      installedVersion: 'v1.2.0',
      installedSha: 'f'.repeat(40),
      installedReleaseId: f.releaseId,
    })
    expect(site.installedAt).toBeInstanceOf(Date)
    expect(await statusOf(f.released.candidateId)).toBe('released')
    expect(await statusOf(f.sibling.candidateId)).toBe('stale')
    expect(await statusOf(f.old.candidateId)).toBe('superseded')
    expect(await statusOf(f.elsewhere.candidateId)).toBe('current')
    // Once: the site names the release already.
    expect(await installRelease(db, { releaseId: f.releaseId })).toBeNull()
    expect((await db.site.findUniqueOrThrow({ where: { id: f.siteId } })).installedAt).toEqual(
      site.installedAt,
    )
  })

  it('makes every current candidate of a site stale when no dialog is spared', async () => {
    const f = await fixture()
    expect(await markSiteCandidatesStale(db, { siteId: f.siteId, exceptTaskId: null })).toBe(2)
    expect(await statusOf(f.released.candidateId)).toBe('stale')
    expect(await statusOf(f.elsewhere.candidateId)).toBe('current')
    await expect(
      markSiteCandidatesStale(db, { siteId: 'bad', exceptTaskId: null }),
    ).rejects.toThrow()
  })
})
