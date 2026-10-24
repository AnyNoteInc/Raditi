import {
  attachmentFileName,
  attachmentKey,
  attachmentLimits,
  attachmentMimeTypes,
} from '@repo/domain'
import { z } from 'zod'

import type { Attachment, Prisma } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

// Files a client attaches to a message (docs/plan/57-browser-tasks.md, Б26). web announces a file
// (`uploading`), streams it into raditi-inbox, checks the stored object and marks it `ready`;
// the transaction of the message binds it to the task, and only then the browser worker may read
// it. A file nobody sent can be removed by its uploader, or expires and is collected by core.

type Db = Pick<Prisma.TransactionClient, '$queryRaw' | 'attachment'>
type RawDb = Pick<Prisma.TransactionClient, '$queryRaw'>

/** How long a file nobody sent is kept after it was announced. */
export const ATTACHMENT_UNSENT_HOURS = 24

const id = z.uuid()
const size = z.number().int().min(1).max(attachmentLimits.fileBytes)
const contentType = z
  .string()
  .refine(
    (type) => (attachmentMimeTypes as readonly string[]).includes(type),
    'expected a listed type',
  )

const createSchema = z.strictObject({
  workspaceId: id,
  siteId: id,
  uploadedById: id,
  source: z.enum(['web', 'telegram', 'max']).default('web'),
  /** Already cleaned by attachmentFileName(): a name it would change is refused. */
  fileName: z.string().refine((name) => attachmentFileName(name) === name, 'expected a clean name'),
  contentType,
  sizeBytes: size,
})

/**
 * Announces a file of `uploadedById` for a site of the workspace: `uploading`, with the key
 * attachmentKey() gives and `ATTACHMENT_UNSENT_HOURS` to be sent. null — the site is not of the
 * workspace, or the uploader is not its member.
 */
export async function createAttachment(
  db: Db,
  input: {
    workspaceId: string
    siteId: string
    uploadedById: string
    source?: 'web' | 'telegram' | 'max'
    fileName: string
    contentType: string
    sizeBytes: number
  },
): Promise<Attachment | null> {
  const file = createSchema.parse(input)
  const attachmentId = uuidv7()
  const rows = await db.$queryRaw<unknown[]>`
    INSERT INTO attachments
      (id, workspace_id, site_id, uploaded_by_id, source, s3_key, file_name, content_type,
       size_bytes, expires_at)
    SELECT ${attachmentId}::uuid, s.workspace_id, s.id, ${file.uploadedById}::uuid,
           ${file.source}::"Channel", ${attachmentKey(file.workspaceId, attachmentId)},
           ${file.fileName}, ${file.contentType}, ${file.sizeBytes},
           clock_timestamp() + ${ATTACHMENT_UNSENT_HOURS}::int * interval '1 hour'
      FROM sites s
     WHERE s.id = ${file.siteId}::uuid AND s.workspace_id = ${file.workspaceId}::uuid
       AND EXISTS (SELECT 1 FROM members m
                    WHERE m.workspace_id = s.workspace_id AND m.user_id = ${file.uploadedById}::uuid)
    RETURNING id`
  if (rows.length !== 1) return null
  return db.attachment.findUniqueOrThrow({ where: { id: attachmentId } })
}

const readySchema = z.strictObject({ id, sizeBytes: size, contentType })

/**
 * web stored the bytes and checked the object (its size, its first bytes): the file may be sent.
 * Only from `uploading` and before it expired; false otherwise.
 */
export async function markAttachmentReady(
  db: RawDb,
  input: { id: string; sizeBytes: number; contentType: string },
): Promise<boolean> {
  const ready = readySchema.parse(input)
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE attachments
       SET status = 'ready', size_bytes = ${ready.sizeBytes}, content_type = ${ready.contentType}
     WHERE id = ${ready.id}::uuid AND status = 'uploading' AND expires_at > clock_timestamp()
    RETURNING id`
  return rows.length === 1
}

const bindSchema = z.strictObject({
  ids: z
    .array(id)
    .max(attachmentLimits.perMessage)
    .refine((ids) => new Set(ids).size === ids.length, 'expected distinct ids'),
  taskId: id,
  userId: id,
  workspaceId: id,
  siteId: id,
})

/**
 * Binds the files of a message to its task, in the transaction that writes the message: all of
 * them or none. Each must be `ready`, not sent yet and not expired — so a collector may delete
 * an expired file nobody sent —, of this uploader, workspace and site, and the task of the same
 * workspace and site. false — nothing was bound; the caller refuses the message.
 */
export async function bindAttachments(
  tx: RawDb,
  input: {
    ids: readonly string[]
    taskId: string
    userId: string
    workspaceId: string
    siteId: string
  },
): Promise<boolean> {
  const { ids, taskId, userId, workspaceId, siteId } = bindSchema.parse({
    ...input,
    ids: [...input.ids],
  })
  if (ids.length === 0) return true
  const rows = await tx.$queryRaw<unknown[]>`
    WITH wanted AS (
      SELECT a.id FROM attachments a
       WHERE a.id = ANY(${ids}::uuid[]) AND a.status = 'ready' AND a.task_id IS NULL
         AND a.expires_at > clock_timestamp()
         AND a.uploaded_by_id = ${userId}::uuid
         AND a.workspace_id = ${workspaceId}::uuid AND a.site_id = ${siteId}::uuid
         AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${taskId}::uuid
                        AND t.workspace_id = a.workspace_id AND t.site_id = a.site_id)
       FOR UPDATE OF a
    )
    UPDATE attachments a
       SET status = 'bound', task_id = ${taskId}::uuid, bound_at = clock_timestamp()
      FROM wanted w
     WHERE a.id = w.id AND (SELECT count(*) FROM wanted) = ${ids.length}
    RETURNING a.id`
  return rows.length === ids.length
}

const removeSchema = z.strictObject({ id, userId: id })

/**
 * Removes a file its uploader has not sent (attachmentDeletable): the row stays `deleted`, and
 * the answer is the key of the object to delete — again on a second call, so a failed delete of
 * the object can be repeated. null — no such file of this user, or it was sent.
 */
export async function removeAttachment(
  db: RawDb,
  input: { id: string; userId: string },
): Promise<string | null> {
  const { id: attachmentId, userId } = removeSchema.parse(input)
  const [row] = await db.$queryRaw<Array<{ s3_key: string }>>`
    UPDATE attachments SET status = 'deleted'
     WHERE id = ${attachmentId}::uuid AND uploaded_by_id = ${userId}::uuid
       AND status IN ('uploading', 'ready', 'deleted')
    RETURNING s3_key`
  return row?.s3_key ?? null
}

/**
 * A file nobody sent is collected this long after it expired: an upload that began just before
 * may still be writing its object (web removes an object it could not mark `ready`).
 */
export const ATTACHMENT_COLLECT_GRACE_MINUTES = 15

const collectSchema = z.strictObject({ limit: z.number().int().min(1).max(1000) })

/** A file the collector removes: its row and the key of its object in raditi-inbox. */
export interface ExpiredAttachment {
  id: string
  key: string
}

/**
 * Files nobody sent, past their expiry and the grace, oldest first: core's collector deletes the
 * object of each, then marks it `deleted` (markExpiredAttachmentDeleted). Nothing can send or
 * ready an expired file, so none of them moves meanwhile. A file sent with a message is never
 * one of them: its object follows the retention of raditi-inbox (spec §14).
 */
export async function listExpiredAttachments(
  db: RawDb,
  input: { limit: number },
): Promise<ExpiredAttachment[]> {
  const { limit } = collectSchema.parse(input)
  const rows = await db.$queryRaw<Array<{ id: string; s3_key: string }>>`
    SELECT id, s3_key FROM attachments
     WHERE status IN ('uploading', 'ready') AND task_id IS NULL
       AND expires_at <= clock_timestamp()
                         - make_interval(mins => ${ATTACHMENT_COLLECT_GRACE_MINUTES}::int)
     ORDER BY expires_at, id
     LIMIT ${limit}`
  return rows.map((row) => ({ id: row.id, key: row.s3_key }))
}

/**
 * The collector deleted the object of an expired file nobody sent: its row is `deleted`. false —
 * it is no longer such a file (marked already, or not expired).
 */
export async function markExpiredAttachmentDeleted(
  db: RawDb,
  input: { id: string },
): Promise<boolean> {
  const attachmentId = id.parse(input.id)
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE attachments SET status = 'deleted'
     WHERE id = ${attachmentId}::uuid AND status IN ('uploading', 'ready') AND task_id IS NULL
       AND expires_at <= clock_timestamp()
    RETURNING id`
  return rows.length === 1
}

/** The files sent with the messages of a task, in the order they were sent. */
export async function taskAttachments(
  db: Pick<Prisma.TransactionClient, 'attachment'>,
  taskId: string,
): Promise<Attachment[]> {
  return db.attachment.findMany({
    where: { taskId: id.parse(taskId), status: 'bound' },
    orderBy: [{ boundAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
}

/**
 * One file sent with a message of the task, or null: what the browser worker checks before it
 * reads an object for a page of the task.
 */
export async function taskAttachment(
  db: Pick<Prisma.TransactionClient, 'attachment'>,
  input: { id: string; taskId: string },
): Promise<Attachment | null> {
  return db.attachment.findFirst({
    where: { id: id.parse(input.id), taskId: id.parse(input.taskId), status: 'bound' },
  })
}
