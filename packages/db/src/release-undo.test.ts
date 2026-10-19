import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { installRelease } from './release-install.ts'
import { failUndoPlan, recordUndoPlan, requestUndoPlan, wakeUndoPlan } from './release-undo.ts'

const databaseUrl = process.env.DATABASE_URL
const sha = (char: string) => char.repeat(40)
const key = () => randomUUID().replaceAll('-', '').padEnd(64, '0')

describe.skipIf(!databaseUrl)('«Отменить выпуск» on PostgreSQL', () => {
  let db: PrismaClient
  const workspaces: string[] = []
  const users: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      await db.site.updateMany({ where: { workspaceId }, data: { installedReleaseId: null } })
      await db.siteRelease.deleteMany({
        where: { site: { workspaceId }, kind: 'undo' },
      })
      const plans = await db.releaseUndoPlan.findMany({
        where: { site: { workspaceId } },
        select: { id: true },
      })
      await db.outboxEvent.deleteMany({
        where: {
          OR: plans.map((plan) => ({ dedupeKey: { startsWith: `release.undoPlan:${plan.id}:` } })),
        },
      })
      await db.releaseUndoPlan.deleteMany({ where: { site: { workspaceId } } })
      await db.siteRelease.deleteMany({ where: { site: { workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.site.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
    await db.user.deleteMany({ where: { id: { in: users.splice(0) } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /** A site whose installed release came from the dialog `taskId`, and a user. */
  async function fixture() {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic release undo' } })
    workspaces.push(workspace.id)
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Release undo',
        url: `https://${randomUUID()}.invalid`,
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({
      data: { workspaceId: workspace.id, siteId: site.id, status: 'done' },
    })
    const candidate = await db.taskCandidate.create({
      data: {
        taskId: task.id,
        revision: 1,
        turnNo: 1,
        status: 'released',
        baseSha: sha('a'),
        baseTree: sha('b'),
        headSha: sha('c'),
        dbPlanSha256: 'd'.repeat(64),
        proposedBump: 'minor',
        proposedVersion: 'v1.4.0',
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
        releaseKey: key(),
        version: 'v1.4.0',
        tag: 'v1.4.0',
        bump: 'minor',
        mainBeforeSha: sha('a'),
        installedBeforeSha: sha('a'),
        approvedSha: sha('f'),
        mainPushedAt: new Date(),
        status: 'installed',
        committedAt: new Date(),
        approvedAt: new Date(),
      },
    })
    await installRelease(db, { releaseId: release.id })
    const user = await db.user.create({
      data: { name: 'Undo verification', email: `${randomUUID()}@undo.example.ru` },
      select: { id: true },
    })
    users.push(user.id)
    return { workspaceId: workspace.id, siteId: site.id, taskId: task.id, release, user }
  }

  const undoRow = (
    f: Awaited<ReturnType<typeof fixture>>,
    planId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    siteId: f.siteId,
    taskId: f.taskId,
    kind: 'undo' as const,
    undoesReleaseId: f.release.id,
    undoPlanId: planId,
    undoPlanSha256: 'e'.repeat(64),
    attempt: 1,
    releaseKey: key(),
    version: 'v1.4.1',
    tag: 'v1.4.1',
    bump: 'patch' as const,
    mainBeforeSha: sha('f'),
    installedBeforeSha: sha('f'),
    committedAt: new Date(),
    approvedAt: new Date(),
    ...overrides,
  })

  it('asks for a plan once, keeps it while it stands and writes it once', async () => {
    const f = await fixture()
    const input = {
      releaseId: f.release.id,
      siteId: f.siteId,
      installedSha: sha('f'),
      userId: f.user.id,
    }
    const first = await db.$transaction((tx) => requestUndoPlan(tx, input))
    expect(first).toMatchObject({ status: 'pending', created: true })
    // A window opened twice waits for the same plan.
    expect(await db.$transaction((tx) => requestUndoPlan(tx, input))).toEqual({
      id: first.id,
      status: 'pending',
      created: false,
    })
    const jobs = await db.outboxEvent.findMany({
      where: {
        type: 'release.undoPlan',
        dedupeKey: { startsWith: `release.undoPlan:${first.id}` },
      },
    })
    expect(jobs).toHaveLength(1)

    const ready = {
      planId: first.id,
      targetTree: sha('9'),
      files: { back: 1, removed: 0, restored: 0, mediaKept: 0, paths: [] },
      items: [],
      dbPlan: [],
      nothingToUndo: false,
      planSha256: '7'.repeat(64),
    }
    expect(await db.$transaction((tx) => recordUndoPlan(tx, ready))).toBe(true)
    expect(await db.$transaction((tx) => recordUndoPlan(tx, ready))).toBe(false)
    expect(await failUndoPlan(db, { planId: first.id, code: 'technical' })).toBe(false)
    expect(await db.$transaction((tx) => wakeUndoPlan(tx, { planId: first.id }))).toBe(false)
    expect(await db.$transaction((tx) => requestUndoPlan(tx, input))).toMatchObject({
      id: first.id,
      status: 'ready',
      created: false,
    })
    // A plan made against another installed commit is not the one to show.
    const moved = await db.$transaction((tx) =>
      requestUndoPlan(tx, { ...input, installedSha: sha('8') }),
    )
    expect(moved).toMatchObject({ status: 'pending', created: true })
    expect(moved.id).not.toBe(first.id)
  })

  it('asks again once an undo of the plan started, even if it ended without the undo', async () => {
    const f = await fixture()
    const input = {
      releaseId: f.release.id,
      siteId: f.siteId,
      installedSha: sha('f'),
      userId: f.user.id,
    }
    const first = await db.$transaction((tx) => requestUndoPlan(tx, input))
    await db.$transaction((tx) =>
      recordUndoPlan(tx, {
        planId: first.id,
        targetTree: sha('9'),
        files: { back: 1, removed: 0, restored: 0, mediaKept: 0, paths: [] },
        items: [],
        dbPlan: [],
        nothingToUndo: false,
        planSha256: '7'.repeat(64),
      }),
    )
    // The undo ran and ended: the site runs the release still, yet production may have moved.
    await db.siteRelease.create({ data: undoRow(f, first.id, { status: 'failed' }) })
    const again = await db.$transaction((tx) => requestUndoPlan(tx, input))
    expect(again).toMatchObject({ status: 'pending', created: true })
    expect(again.id).not.toBe(first.id)
    expect(await db.$transaction((tx) => requestUndoPlan(tx, input))).toMatchObject({
      id: again.id,
      created: false,
    })
  })

  it('makes a ready plan whole and a failed one with its code', async () => {
    const f = await fixture()
    const plan = await db.releaseUndoPlan.create({
      data: { siteId: f.siteId, releaseId: f.release.id, installedSha: sha('f') },
    })
    await expect(
      db.releaseUndoPlan.update({ where: { id: plan.id }, data: { status: 'ready' } }),
    ).rejects.toThrow()
    await expect(
      db.releaseUndoPlan.update({ where: { id: plan.id }, data: { status: 'failed' } }),
    ).rejects.toThrow()
    expect(await failUndoPlan(db, { planId: plan.id, code: 'site_unreachable' })).toBe(true)
  })

  it('keeps an undo a patch without a candidate, one under way per release', async () => {
    const f = await fixture()
    const plan = await db.releaseUndoPlan.create({
      data: { siteId: f.siteId, releaseId: f.release.id, installedSha: sha('f') },
    })
    // An undo with a candidate, or a release without one, is neither.
    await expect(
      db.siteRelease.create({
        data: undoRow(f, plan.id, { candidateId: f.release.candidateId, candidateRevision: 1 }),
      }),
    ).rejects.toThrow()
    await expect(
      db.siteRelease.create({ data: undoRow(f, plan.id, { bump: 'minor' }) }),
    ).rejects.toThrow()
    await expect(
      db.siteRelease.create({ data: { ...undoRow(f, plan.id), kind: 'release' } }),
    ).rejects.toThrow()

    const undo = await db.siteRelease.create({ data: undoRow(f, plan.id) })
    // A second undo while the first goes on, or the same attempt again, is refused.
    await expect(
      db.siteRelease.create({ data: undoRow(f, plan.id, { attempt: 2, version: 'v1.4.2' }) }),
    ).rejects.toThrow()
    await db.siteRelease.update({ where: { id: undo.id }, data: { status: 'failed' } })
    await expect(
      db.siteRelease.create({ data: undoRow(f, plan.id, { version: 'v1.4.2' }) }),
    ).rejects.toThrow()
    const second = await db.siteRelease.create({
      data: undoRow(f, plan.id, { attempt: 2, version: 'v1.4.2', tag: 'v1.4.2' }),
    })

    // Installed, the undo is what the site runs; the dialog keeps no candidate to release.
    await db.siteRelease.update({
      where: { id: second.id },
      data: { status: 'installed', approvedSha: sha('1'), mainPushedAt: new Date() },
    })
    expect(await installRelease(db, { releaseId: second.id })).toEqual({
      siteId: f.siteId,
      taskId: f.taskId,
      candidateId: null,
      staleCandidates: 0,
    })
    expect(await db.site.findUniqueOrThrow({ where: { id: f.siteId } })).toMatchObject({
      installedVersion: 'v1.4.2',
      installedSha: sha('1'),
      installedReleaseId: second.id,
    })
  })
})
