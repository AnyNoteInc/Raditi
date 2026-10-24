import { randomUUID } from 'node:crypto'

import { attachmentKey, attachmentLimits } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import {
  ATTACHMENT_COLLECT_GRACE_MINUTES,
  ATTACHMENT_UNSENT_HOURS,
  bindAttachments,
  createAttachment,
  listExpiredAttachments,
  markAttachmentReady,
  markExpiredAttachmentDeleted,
  removeAttachment,
  taskAttachment,
  taskAttachments,
} from './attachments.ts'
import type { PrismaClient } from './generated/prisma/client.ts'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: files a client attaches to a message', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'attachments')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  const person = () =>
    db.user.create({ data: { name: 'Synthetic', email: `${randomUUID()}@example.test` } })

  /** A member of a workspace with two sites, a task of the first and a file to upload there. */
  async function uploads() {
    const user = await person()
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic' },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id } })
    const [site, otherSite] = await Promise.all(
      [1, 2].map(() =>
        db.site.create({
          data: {
            workspaceId: workspace.id,
            name: 'Synthetic',
            url: `https://${randomUUID()}.example.test`,
            stack: 'wordpress',
          },
        }),
      ),
    )
    const task = await db.task.create({
      data: {
        workspaceId: workspace.id,
        siteId: site!.id,
        needsRepository: false,
        needsBrowser: true,
      },
    })
    const file = {
      workspaceId: workspace.id,
      siteId: site!.id,
      uploadedById: user.id,
      fileName: 'Фото витрины.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 2048,
    }
    /** An uploaded file, `ready` unless told otherwise. */
    const stored = async (ready = true) => {
      const created = (await createAttachment(db, file))!
      if (ready)
        expect(
          await markAttachmentReady(db, {
            id: created.id,
            sizeBytes: created.sizeBytes,
            contentType: created.contentType,
          }),
        ).toBe(true)
      return created
    }
    const binding = {
      taskId: task.id,
      userId: user.id,
      workspaceId: workspace.id,
      siteId: site!.id,
    }
    return { user, workspace, site: site!, otherSite: otherSite!, task, file, stored, binding }
  }

  it('announces a file under its key in the inbox, for a member and a site of the workspace', async () => {
    const u = await uploads()
    const created = (await createAttachment(db, u.file))!
    expect(created).toMatchObject({
      workspaceId: u.workspace.id,
      siteId: u.site.id,
      taskId: null,
      uploadedById: u.user.id,
      source: 'web',
      status: 'uploading',
      s3Key: attachmentKey(u.workspace.id, created.id),
      fileName: 'Фото витрины.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 2048,
      boundAt: null,
    })
    const hours = (created.expiresAt.getTime() - created.createdAt.getTime()) / 3_600_000
    expect(hours).toBeCloseTo(ATTACHMENT_UNSENT_HOURS, 2)

    const stranger = await person()
    expect(await createAttachment(db, { ...u.file, uploadedById: stranger.id })).toBeNull()
    const elsewhere = await db.workspace.create({ data: { name: 'Another' } })
    expect(await createAttachment(db, { ...u.file, workspaceId: elsewhere.id })).toBeNull()

    for (const wrong of [
      { fileName: '../secret.jpg' },
      { fileName: 'photo.jpg ' },
      { contentType: 'application/x-msdownload' },
      { sizeBytes: 0 },
      { sizeBytes: attachmentLimits.fileBytes + 1 },
    ])
      await expect(createAttachment(db, { ...u.file, ...wrong })).rejects.toThrow()
  })

  it('takes the checked object once, before the file expires', async () => {
    const u = await uploads()
    const created = (await createAttachment(db, u.file))!
    const ready = { id: created.id, sizeBytes: 1999, contentType: 'image/jpeg' }
    expect(await markAttachmentReady(db, ready)).toBe(true)
    expect(await db.attachment.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      status: 'ready',
      sizeBytes: 1999,
    })
    expect(await markAttachmentReady(db, ready)).toBe(false)

    const late = (await createAttachment(db, u.file))!
    await db.$executeRaw`UPDATE attachments SET expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${late.id}::uuid`
    expect(await markAttachmentReady(db, { ...ready, id: late.id })).toBe(false)
  })

  it('binds the files of a message to its task all together, or none of them', async () => {
    const u = await uploads()
    const [first, second] = [await u.stored(), await u.stored()]
    const uploading = await u.stored(false)

    expect(
      await bindAttachments(db, { ...u.binding, ids: [first.id, second.id, uploading.id] }),
    ).toBe(false)
    expect(await taskAttachments(db, u.task.id)).toEqual([])
    expect(await bindAttachments(db, { ...u.binding, ids: [] })).toBe(true)

    expect(await bindAttachments(db, { ...u.binding, ids: [first.id, second.id] })).toBe(true)
    const bound = await taskAttachments(db, u.task.id)
    expect(bound.map((attachment) => attachment.id).sort()).toEqual([first.id, second.id].sort())
    expect(bound[0]).toMatchObject({
      status: 'bound',
      taskId: u.task.id,
      boundAt: expect.any(Date),
    })
    // A file is sent once.
    expect(await bindAttachments(db, { ...u.binding, ids: [first.id] })).toBe(false)
    expect(await taskAttachment(db, { id: first.id, taskId: u.task.id })).toMatchObject({
      id: first.id,
      s3Key: first.s3Key,
    })
    expect(await taskAttachment(db, { id: uploading.id, taskId: u.task.id })).toBeNull()

    await expect(
      bindAttachments(db, { ...u.binding, ids: [uploading.id, uploading.id] }),
    ).rejects.toThrow()
    await expect(
      bindAttachments(db, {
        ...u.binding,
        ids: Array.from({ length: attachmentLimits.perMessage + 1 }, () => randomUUID()),
      }),
    ).rejects.toThrow()
  })

  it('binds only the uploader’s own files, of the task’s workspace and site', async () => {
    const u = await uploads()
    const file = await u.stored()
    const colleague = await person()
    await db.member.create({ data: { workspaceId: u.workspace.id, userId: colleague.id } })
    const otherTask = await db.task.create({
      data: {
        workspaceId: u.workspace.id,
        siteId: u.otherSite.id,
        needsRepository: false,
        needsBrowser: true,
      },
    })
    for (const wrong of [
      { userId: colleague.id },
      { siteId: u.otherSite.id },
      // The site matches the file, the task is of another site.
      { taskId: otherTask.id },
      { taskId: randomUUID() },
    ])
      expect(await bindAttachments(db, { ...u.binding, ...wrong, ids: [file.id] })).toBe(false)
    expect((await db.attachment.findUniqueOrThrow({ where: { id: file.id } })).status).toBe('ready')
    expect(await taskAttachment(db, { id: file.id, taskId: otherTask.id })).toBeNull()

    // A file nobody sent in time is the collector's: it is never sent after that.
    await db.$executeRaw`UPDATE attachments SET expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${file.id}::uuid`
    expect(await bindAttachments(db, { ...u.binding, ids: [file.id] })).toBe(false)
  })

  // The collector of core (docs/plan/57, «Открыто»): objects of files nobody sent leave the inbox.
  it('lists files nobody sent past their expiry for the collector, and marks each once', async () => {
    const u = await uploads()
    const [uploading, ready, sent, fresh, removed, recent] = [
      await u.stored(false),
      await u.stored(),
      await u.stored(),
      await u.stored(),
      await u.stored(),
      await u.stored(),
    ]
    expect(await bindAttachments(db, { ...u.binding, ids: [sent.id] })).toBe(true)
    expect(await removeAttachment(db, { id: removed.id, userId: u.user.id })).toBe(removed.s3Key)
    const expire = async (fileId: string, minutesAgo: number) => {
      await db.$executeRaw`UPDATE attachments
        SET expires_at = clock_timestamp() - make_interval(mins => ${minutesAgo}::int)
        WHERE id = ${fileId}::uuid`
    }
    const past = ATTACHMENT_COLLECT_GRACE_MINUTES + 5
    // The oldest first; a sent file and a removed one are not the collector's, whatever their
    // expiry; one expired within the grace may still be uploading.
    await expire(ready.id, past + 10)
    await expire(uploading.id, past)
    await expire(sent.id, past + 20)
    await expire(removed.id, past + 20)
    await expire(recent.id, ATTACHMENT_COLLECT_GRACE_MINUTES - 5)

    expect(await listExpiredAttachments(db, { limit: 10 })).toEqual([
      { id: ready.id, key: ready.s3Key },
      { id: uploading.id, key: uploading.s3Key },
    ])
    expect(await listExpiredAttachments(db, { limit: 1 })).toEqual([
      { id: ready.id, key: ready.s3Key },
    ])

    expect(await markExpiredAttachmentDeleted(db, { id: ready.id })).toBe(true)
    // Once: a second collector finds it marked.
    expect(await markExpiredAttachmentDeleted(db, { id: ready.id })).toBe(false)
    for (const kept of [sent, fresh])
      expect(await markExpiredAttachmentDeleted(db, { id: kept.id })).toBe(false)
    expect(await listExpiredAttachments(db, { limit: 10 })).toEqual([
      { id: uploading.id, key: uploading.s3Key },
    ])
    expect(
      Object.fromEntries(
        (await db.attachment.findMany({ where: { workspaceId: u.workspace.id } })).map((row) => [
          row.id,
          row.status,
        ]),
      ),
    ).toEqual({
      [uploading.id]: 'uploading',
      [ready.id]: 'deleted',
      [sent.id]: 'bound',
      [fresh.id]: 'ready',
      [removed.id]: 'deleted',
      [recent.id]: 'ready',
    })
    // A collected file is never sent.
    expect(await bindAttachments(db, { ...u.binding, ids: [ready.id] })).toBe(false)

    await expect(listExpiredAttachments(db, { limit: 0 })).rejects.toThrow()
    await expect(markExpiredAttachmentDeleted(db, { id: 'not-an-id' })).rejects.toThrow()
  })

  it('removes a file its uploader has not sent, and answers the key again', async () => {
    const u = await uploads()
    const [uploading, ready, sent] = [await u.stored(false), await u.stored(), await u.stored()]
    expect(await bindAttachments(db, { ...u.binding, ids: [sent.id] })).toBe(true)

    const stranger = await person()
    expect(await removeAttachment(db, { id: ready.id, userId: stranger.id })).toBeNull()
    expect(await removeAttachment(db, { id: ready.id, userId: u.user.id })).toBe(ready.s3Key)
    expect(await removeAttachment(db, { id: ready.id, userId: u.user.id })).toBe(ready.s3Key)
    expect(await removeAttachment(db, { id: uploading.id, userId: u.user.id })).toBe(
      uploading.s3Key,
    )
    expect(await removeAttachment(db, { id: sent.id, userId: u.user.id })).toBeNull()
    expect(
      (await db.attachment.findMany({ where: { workspaceId: u.workspace.id } }))
        .map((row) => [row.id, row.status])
        .sort(),
    ).toEqual(
      [
        [uploading.id, 'deleted'],
        [ready.id, 'deleted'],
        [sent.id, 'bound'],
      ].sort(),
    )
    // A removed file is never sent.
    expect(await bindAttachments(db, { ...u.binding, ids: [ready.id] })).toBe(false)
    expect(
      await markAttachmentReady(db, { id: uploading.id, sizeBytes: 1, contentType: 'image/jpeg' }),
    ).toBe(false)
  })
})
