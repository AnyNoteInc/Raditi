import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import { createArtifact } from './artifacts.ts'
import { insertFeedEvent } from './feed-events.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  claimQuickEdit,
  finishQuickEdit,
  insertQuickEdit,
  queueQuickAttempt,
  staleQuickEdits,
} from './quick-edits.ts'
import { claimQueuedPass } from './task-settle.ts'

// The quick task and its edits in PostgreSQL (docs/plan/98-quick-edits.md, БПр2, БПр3, БПр15).

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL quick edits', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'quick_edits')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  }, 60_000)

  async function owner() {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic quick edits', dataClass: 'synthetic' },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    return { userId: user.id, workspaceId: workspace.id }
  }

  const queue = (input: { workspaceId: string; userId: string }) =>
    db.$transaction((tx) => queueQuickAttempt(tx, input))

  it('keeps one quick task per person and workspace, one attempt at a time', async () => {
    const who = await owner()
    const first = await queue(who)
    expect(first).toMatchObject({ attempt: 1, created: true })
    // Busy with the first edit: no second attempt.
    expect(await queue(who)).toBeNull()
    await db.task.update({ where: { id: first!.taskId }, data: { status: 'awaiting_user' } })
    const second = await queue(who)
    expect(second).toEqual({ taskId: first!.taskId, attempt: 2, created: false })
    const task = await db.task.findUniqueOrThrow({ where: { id: first!.taskId } })
    expect(task).toMatchObject({ kind: 'quick_edits', status: 'queued', modelClass: 'light' })
  })

  it('refuses a quick task with a chat session or a project, or not billed', async () => {
    const who = await owner()
    await expect(
      db.task.create({
        data: {
          workspaceId: who.workspaceId,
          createdById: who.userId,
          kind: 'quick_edits',
          billable: false,
        },
      }),
    ).rejects.toThrow()
  })

  it('never lets a pass of the agent claim the quick task', async () => {
    const who = await owner()
    const queued = await queue(who)
    const requestEventId = String(
      await insertFeedEvent(db, {
        taskId: queued!.taskId,
        row: {
          type: 'feed.request',
          payload: {
            v: 1,
            kind: 'first',
            authorId: who.userId,
            requestId: randomUUID(),
            text: 'x',
          },
        },
      }),
    )
    expect(
      await claimQueuedPass(db, {
        taskId: queued!.taskId,
        attempt: 1,
        requestEventId,
        workspaceLimit: 8,
      }),
    ).toBeNull()
  })

  it('claims an edit once, moves its task to preparing, and finishes it once', async () => {
    const who = await owner()
    const queued = await queue(who)
    const artifact = await createArtifact(db, {
      workspaceId: who.workspaceId,
      kind: 'document',
      title: 'Прайс',
      view: 'page',
      actor: { kind: 'user', userId: who.userId },
    })
    const id = randomUUID()
    await insertQuickEdit(db as never, {
      id,
      artifactId: artifact.id,
      taskId: queued!.taskId,
      attempt: 1,
      userId: who.userId,
      requestId: randomUUID(),
    })
    const claimed = await claimQuickEdit(db, id)
    expect(claimed).toMatchObject({ id, attempt: 1, workspaceId: who.workspaceId })
    expect(await claimQuickEdit(db, id)).toBeNull()
    const task = await db.task.findUniqueOrThrow({ where: { id: queued!.taskId } })
    expect(task).toMatchObject({ status: 'preparing', turnNo: 1 })
    expect((await staleQuickEdits(db, 0)).map((row) => row.id)).toContain(id)
    await finishQuickEdit(db as never, { id, state: 'applied', calls: 1 })
    await finishQuickEdit(db as never, { id, state: 'failed', reason: 'platform' })
    const row = await db.artifactQuickEdit.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ state: 'applied', reason: null, calls: 1 })
    expect(row.finishedAt).toBeInstanceOf(Date)
    expect((await staleQuickEdits(db, 0)).map((each) => each.id)).not.toContain(id)
  })
})
