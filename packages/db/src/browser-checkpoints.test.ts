import { randomUUID } from 'node:crypto'

import {
  browserFeedObjectOf,
  type BrowserCheckpointRef,
  type BrowserVerifiedObject,
} from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import { taskBrowserCheckpoints, upsertBrowserCheckpoint } from './browser-checkpoints.ts'
import { closeBrowserSession, openBrowserSession } from './browser-sessions.ts'
import type { PrismaClient } from './generated/prisma/client.ts'

const databaseUrl = process.env.DATABASE_URL
const site = 'https://news.example.test'

const post = (objectId: string): BrowserCheckpointRef => ({
  kind: 'post',
  objectId,
  editUrl: `${site}/wp-admin/post.php?post=${objectId}&action=edit`,
})
const found = (objectId: string, extra: Partial<BrowserVerifiedObject> = {}) =>
  ({
    kind: 'post',
    objectId,
    title: 'Новость о скидках',
    status: 'publish',
    url: `${site}/news/sale/`,
    editUrl: post(objectId).editUrl,
    images: 2,
    files: 1,
    featuredImage: true,
    ...extra,
  }) satisfies BrowserVerifiedObject

describe.skipIf(!databaseUrl)('PostgreSQL: checkpoints of what a task made in its browser', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'browser_checkpoints')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  async function browserTask() {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic' },
    })
    const row = await db.site.create({
      data: { workspaceId: workspace.id, name: 'Synthetic', url: site, stack: 'wordpress' },
    })
    const task = await db.task.create({
      data: {
        workspaceId: workspace.id,
        siteId: row.id,
        needsRepository: false,
        needsBrowser: true,
      },
    })
    const session = await openBrowserSession(db, { taskId: task.id })
    return { task, session }
  }

  it('moves a checkpoint as the task saves and the site confirms, never back to seen', async () => {
    const { task, session } = await browserTask()
    const at = { taskId: task.id, sessionId: session.id, ref: post('42') }

    const seen = await upsertBrowserCheckpoint(db, { ...at, state: 'seen' })
    expect(seen).toMatchObject({ taskId: task.id, sessionId: session.id, ref: post('42') })
    expect(seen).toMatchObject({ state: 'seen', verified: null })
    expect(await upsertBrowserCheckpoint(db, { ...at, state: 'unverified' })).toMatchObject({
      id: seen.id,
      state: 'unverified',
    })
    // Opening the editor again unsaves nothing.
    expect(await upsertBrowserCheckpoint(db, { ...at, state: 'seen' })).toMatchObject({
      id: seen.id,
      state: 'unverified',
    })

    const verified = await upsertBrowserCheckpoint(db, {
      ...at,
      state: 'verified',
      verified: found('42'),
    })
    expect(verified).toMatchObject({ id: seen.id, state: 'verified', verified: found('42') })
    expect(await upsertBrowserCheckpoint(db, { ...at, state: 'seen' })).toMatchObject({
      state: 'verified',
      verified: found('42'),
    })
    // Saved again after the site confirmed it: unknown until the next read.
    expect(await upsertBrowserCheckpoint(db, { ...at, state: 'unverified' })).toMatchObject({
      state: 'unverified',
      verified: null,
    })
    expect(await upsertBrowserCheckpoint(db, { ...at, state: 'missing' })).toMatchObject({
      state: 'missing',
      verified: null,
    })
    expect(await db.browserCheckpoint.count({ where: { taskId: task.id } })).toBe(1)
  })

  it('keeps the session that last saw an object, and refuses a session of another task', async () => {
    const { task, session } = await browserTask()
    const other = await browserTask()
    await upsertBrowserCheckpoint(db, {
      taskId: task.id,
      sessionId: session.id,
      ref: post('7'),
      state: 'unverified',
    })
    // The browser was lost; the next one opened the same object again.
    await closeBrowserSession(db, { sessionId: session.id, status: 'lost', reason: 'crashed' })
    const next = await openBrowserSession(db, { taskId: task.id })
    expect(
      await upsertBrowserCheckpoint(db, {
        taskId: task.id,
        sessionId: next.id,
        ref: post('7'),
        state: 'seen',
      }),
    ).toMatchObject({ sessionId: next.id, state: 'unverified' })

    await expect(
      upsertBrowserCheckpoint(db, {
        taskId: task.id,
        sessionId: other.session.id,
        ref: post('7'),
        state: 'seen',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The browser session is not one of the task',
    })
  })

  it('takes what a read found exactly with `verified`, and only of the same object', async () => {
    const { task, session } = await browserTask()
    const at = { taskId: task.id, sessionId: session.id, ref: post('42') }
    await expect(upsertBrowserCheckpoint(db, { ...at, state: 'verified' })).rejects.toThrow()
    await expect(
      upsertBrowserCheckpoint(db, { ...at, state: 'unverified', verified: found('42') }),
    ).rejects.toThrow()
    await expect(
      upsertBrowserCheckpoint(db, { ...at, state: 'verified', verified: found('43') }),
    ).rejects.toThrow()
    await expect(
      upsertBrowserCheckpoint(db, {
        ...at,
        ref: { ...post('42'), editUrl: 'javascript:alert(1)' },
        state: 'seen',
      }),
    ).rejects.toThrow()
    expect(await db.browserCheckpoint.count({ where: { taskId: task.id } })).toBe(0)
  })

  it('reads back every checkpoint of the task for the feed, leaving out what it cannot read', async () => {
    const { task, session } = await browserTask()
    const at = { taskId: task.id, sessionId: session.id }
    await upsertBrowserCheckpoint(db, { ...at, ref: post('1'), state: 'seen' })
    await upsertBrowserCheckpoint(db, {
      ...at,
      ref: post('2'),
      state: 'verified',
      verified: found('2', { status: 'draft', url: undefined }),
    })
    await upsertBrowserCheckpoint(db, { ...at, ref: post('3'), state: 'unverified' })
    // A kind a later worker knows and this code does not, and a broken record of a read.
    await db.$executeRaw`INSERT INTO browser_checkpoints
      (id, task_id, session_id, kind, object_id, edit_url, state, updated_at)
      VALUES (${randomUUID()}::uuid, ${task.id}::uuid, ${session.id}::uuid, 'product', '9',
              ${`${site}/wp-admin/post.php?post=9`}, 'seen', clock_timestamp())`
    await db.$executeRaw`UPDATE browser_checkpoints SET verified = '{"kind":"post"}'
      WHERE task_id = ${task.id}::uuid AND object_id = '2'`

    const read = await taskBrowserCheckpoints(db, task.id)
    expect(read.map((checkpoint) => [checkpoint.ref.objectId, checkpoint.state])).toEqual([
      ['1', 'seen'],
      ['2', 'verified'],
      ['3', 'unverified'],
    ])
    expect(read[1]!.verified).toBeNull()
    // A confirmed object whose record no longer reads is shown unconfirmed, never as found.
    expect(read.map((checkpoint) => browserFeedObjectOf(checkpoint)?.status ?? null)).toEqual([
      null,
      'unconfirmed',
      'unconfirmed',
    ])
    expect(await taskBrowserCheckpoints(db, randomUUID())).toEqual([])
  })
})
