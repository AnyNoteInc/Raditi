import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import { browserScreenshotKey } from '@repo/domain'

import {
  BROWSER_CHECKS_EVENT,
  BROWSER_SCREENSHOT_EVENT,
  carryBrowserChecks,
  recordBrowserChecks,
  type BrowserChecksRun,
} from './browser-checks.ts'
import type { PrismaClient } from './generated/prisma/client.ts'

const databaseUrl = process.env.DATABASE_URL
const digest = (char: string) => char.repeat(64)

describe('browser check runs', () => {
  it('refuses a run or a carry it cannot read, before writing or querying', async () => {
    const create = vi.fn()
    const run: BrowserChecksRun = {
      v: 1,
      turn: 1,
      total: 2,
      passed: 1,
      failed: 1,
      previewId: randomUUID(),
      syncRequestId: randomUUID(),
    }
    for (const wrong of [
      { ...run, passed: 2 },
      { ...run, total: 0, passed: 0, failed: 0 },
      { ...run, path: '/wp-admin/' },
      { ...run, syncRequestId: 'not-a-uuid' },
    ])
      await expect(
        recordBrowserChecks({ taskEvent: { create } } as never, {
          taskId: randomUUID(),
          turnId: null,
          run: wrong as BrowserChecksRun,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(create).not.toHaveBeenCalled()
    const $queryRaw = vi.fn()
    await expect(
      carryBrowserChecks({ $queryRaw, candidateCheck: { create } } as never, {
        taskId: randomUUID(),
        candidateId: randomUUID(),
        turnNo: 0,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect($queryRaw).not.toHaveBeenCalled()
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL: the agent checks carried into a candidate', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'browser_checks')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
    await db.agentDriver.upsert({
      where: { id: 'opencode' },
      update: {},
      create: { id: 'opencode', image: 'synthetic/agent:test', capabilities: {}, enabled: true },
    })
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  /** A dialog in its first turn, with its preview, and the candidate that turn records. */
  async function dialog() {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic checks' } })
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Synthetic',
        url: `https://${randomUUID()}.example.test`,
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({
      data: { workspaceId: workspace.id, siteId: site.id, status: 'running', turnNo: 1 },
    })
    const turn = await db.taskTurn.create({
      data: { taskId: task.id, turnNo: 1, driverId: 'opencode', image: 'synthetic/agent:test' },
    })
    const preview = await db.previewEnvironment.create({
      data: {
        siteId: site.id,
        taskId: task.id,
        status: 'ready',
        dbMode: 'copy',
        hostname: `site-${randomUUID().slice(0, 8)}-chat-abcdef.localhost`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const candidate = async (revision: number) =>
      db.taskCandidate.create({
        data: {
          taskId: task.id,
          revision,
          turnNo: 1,
          status: 'current',
          baseSha: 'a'.repeat(40),
          baseTree: 'b'.repeat(40),
          headSha: 'c'.repeat(40),
          dbPlanSha256: 'd'.repeat(64),
          proposedBump: 'patch',
          proposedVersion: 'v0.0.1',
          facts: {},
          previewRevision: revision,
        },
      })
    /** A sync core answered, as R5c does: the files of the working tree by their digest. */
    const sync = async (files: string | null, errorCode: string | null = null) =>
      (
        await db.previewSyncRequest.create({
          data: {
            previewId: preview.id,
            completedAt: files || errorCode ? new Date() : null,
            filesDigest: files,
            errorCode,
          },
        })
      ).id
    /** A run of the agent's checks on the tree of `syncRequestId`. */
    const checks = async (syncRequestId: string, counts = { total: 2, passed: 2, failed: 0 }) => {
      await db.$transaction((tx) =>
        recordBrowserChecks(tx, {
          taskId: task.id,
          turnId: turn.id,
          run: { v: 1, turn: 1, ...counts, previewId: preview.id, syncRequestId },
        }),
      )
      // Rows of one statement share a timestamp; a run is a call of its own.
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    /** A screenshot of the agent's browser on the tree of `syncRequestId`, as the mcp role notes it. */
    const screenshot = async (syncRequestId: string, turnNo = 1) => {
      const id = randomUUID()
      await db.taskEvent.create({
        data: {
          taskId: task.id,
          turnId: turn.id,
          type: BROWSER_SCREENSHOT_EVENT,
          payload: { v: 1, id, turn: turnNo, previewId: preview.id, syncRequestId },
          clientVisible: false,
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
      return id
    }
    const carry = (candidateId: string, turnNo = 1) =>
      db.$transaction((tx) => carryBrowserChecks(tx, { taskId: task.id, candidateId, turnNo }))
    const rowsOf = (candidateId: string) =>
      db.candidateCheck.findMany({ where: { candidateId }, orderBy: { createdAt: 'asc' } })
    return { task, turn, site, preview, candidate, sync, checks, screenshot, carry, rowsOf }
  }

  it('keeps the screenshot of the same look as the artifact of the check (Р22)', async () => {
    const d = await dialog()
    const tree = await d.sync(digest('a'))
    // Before the run's sync was asked for: an earlier look, not this one.
    const early = await d.screenshot(await d.sync(digest('0')))
    const look = await d.sync(digest('a'))
    await d.checks(look)
    const first = await d.screenshot(tree)
    const last = await d.screenshot(look)
    // Of another turn, and one of another tree: neither is the look of this run.
    await d.screenshot(look, 2)
    expect([early, first, last]).toHaveLength(3)
    const candidate = await d.candidate(1)
    expect(await d.carry(candidate.id)).toBe(true)
    expect((await d.rowsOf(candidate.id))[0]).toMatchObject({
      kind: 'agent_browser',
      artifactKey: browserScreenshotKey(d.task.id, last),
    })

    // A run with no screenshot of its look: the check has no artifact.
    const quiet = await dialog()
    await quiet.checks(await quiet.sync(digest('a')))
    const lone = await quiet.candidate(1)
    expect(await quiet.carry(lone.id)).toBe(true)
    expect((await quiet.rowsOf(lone.id))[0]!.artifactKey).toBeNull()
  })

  it('carries the last run of the turn into the candidate at its revision, once', async () => {
    const d = await dialog()
    const tree = await d.sync(digest('a'))
    await d.checks(tree, { total: 2, passed: 1, failed: 1 })
    await d.checks(tree, { total: 3, passed: 3, failed: 0 })
    // A later look at the same tree (a screenshot after the checks) changes nothing.
    await d.sync(digest('a'))
    const candidate = await d.candidate(2)
    expect(await d.carry(candidate.id, 2)).toBe(false)
    expect(await d.carry(candidate.id)).toBe(true)
    expect(await d.carry(candidate.id)).toBe(false)
    const rows = await d.rowsOf(candidate.id)
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'agent_browser',
        revision: 2,
        status: 'passed',
        summary: { v: 1, turn: 1, total: 3, passed: 3, failed: 0 },
      }),
    ])
    expect(rows[0]!.finishedAt).not.toBeNull()
    const events = await db.taskEvent.findMany({
      where: { taskId: d.task.id, type: BROWSER_CHECKS_EVENT },
    })
    expect(events.map((event) => event.clientVisible)).toEqual([false, false])
  })

  it('carries nothing when a later sync brought other files, or none answered', async () => {
    const other = await dialog()
    await other.checks(await other.sync(digest('a')))
    await other.sync(digest('b'))
    expect(await other.carry((await other.candidate(1)).id)).toBe(false)

    const pending = await dialog()
    await pending.checks(await pending.sync(digest('a')))
    await pending.sync(null)
    expect(await pending.carry((await pending.candidate(1)).id)).toBe(false)

    const refused = await dialog()
    await refused.checks(await refused.sync(digest('a')))
    await refused.sync(null, 'files_refused')
    expect(await refused.carry((await refused.candidate(1)).id)).toBe(false)

    // A run on a sync that never completed is nobody's look at a tree.
    const unanswered = await dialog()
    await unanswered.checks(await unanswered.sync(null))
    expect(await unanswered.carry((await unanswered.candidate(1)).id)).toBe(false)
  })

  it('carries nothing when a content write into the preview began after the run', async () => {
    const d = await dialog()
    await d.checks(await d.sync(digest('a')))
    const assignment = await db.turnAssignment.create({
      data: {
        taskId: d.task.id,
        siteId: d.site.id,
        sessionId: 'synthetic-session',
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 60_000),
      },
    })
    const snapshot = await db.snapshot.create({
      data: {
        siteId: d.site.id,
        taskId: d.task.id,
        previewId: d.preview.id,
        objectRef: 'page:42',
        s3Key: `snapshots/${randomUUID()}.json`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const call = await db.mcpCall.create({
      data: {
        turnId: d.turn.id,
        tool: 'wp_rest',
        idempotencyKey: randomUUID(),
        assignmentId: assignment.id,
        credentialKeyId: randomUUID(),
        previewId: d.preview.id,
        previewWriteEpoch: 1,
        requestHash: 'a'.repeat(64),
        leaseEpoch: 1,
        writeStartedAt: new Date(),
        objectRef: 'page:42',
        snapshotId: snapshot.id,
      },
    })
    const candidate = await d.candidate(1)
    expect(await d.carry(candidate.id)).toBe(false)
    // The same write begun before the run was on the preview the run looked at.
    await db.mcpCall.update({
      where: { id: call.id },
      data: { writeStartedAt: new Date(Date.now() - 60_000) },
    })
    expect(await d.carry(candidate.id)).toBe(true)
  })
})
