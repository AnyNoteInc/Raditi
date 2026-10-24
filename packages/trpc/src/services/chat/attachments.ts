import {
  bindAttachments,
  createAttachment,
  removeAttachment,
  taskAttachments,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  attachmentFileName,
  attachmentLimits,
  attachmentStartInputSchema,
  attachmentTypeByName,
  attachmentTypeOf,
  conflict,
  terminalTaskStatuses,
  type AttachmentRefusal,
} from '@repo/domain'
import { z } from 'zod'

import { accessibleSite, siteNotFound } from '../site-basics.ts'
import { accessibleTask, taskNotFound } from './access.ts'
import type { ChatContext } from './context.ts'
import { underDialogLock } from './dialog-lock.ts'
import {
  attachmentNotReady,
  attachmentRefused,
  attachmentSent,
  attachmentsLimit,
  taskFinished,
} from './refusals.ts'

// Files a client attaches to a message (docs/plan/57-browser-tasks.md, Б26): announced here
// (`attachment.start`), their bytes streamed by web into raditi-inbox (`PUT /api/attachments/<id>`,
// which marks them `ready`), bound to a task in the transaction of the message that sends them. No
// key of an object and no link to one leaves the server: the browser worker reads a bound file
// itself.

type Tx = Prisma.TransactionClient

/**
 * Files announced and not sent of one person at a time: a message takes ten, so this is a few
 * messages being written at once. A bound on the rows nobody sent, not a quota.
 */
export const UNSENT_ATTACHMENTS_PER_USER = 50

/** Where the browser sends the bytes of an announced file: the route of web (S9b). */
export const attachmentUploadPath = (attachmentId: string) => `/api/attachments/${attachmentId}`

/** The files of a message: ids as PostgreSQL prints them, each once, ten at most. */
export const attachmentIdsSchema = z
  .array(z.uuid().transform((id) => id.toLowerCase()))
  .max(attachmentLimits.perMessage)
  .refine((ids) => new Set(ids).size === ids.length, 'expected distinct files')

/**
 * Binds the files of a message to its task in the transaction that writes the message: all or
 * none, each `ready`, unsent, of this uploader and of the task's workspace and site (Б26). A file
 * that is not refuses the message: the caller's transaction rolls back.
 */
export async function bindMessageAttachments(
  tx: Pick<Tx, '$queryRaw'>,
  input: {
    ids: readonly string[]
    taskId: string
    userId: string
    workspaceId: string
    siteId: string
  },
): Promise<void> {
  if (input.ids.length === 0) return
  if (!(await bindAttachments(tx, input))) throw attachmentNotReady()
}

/** `attachments` of a `feed.request`: absent when the message has none. */
export const requestAttachments = (ids: readonly string[]): { attachments?: string[] } =>
  ids.length === 0 ? {} : { attachments: [...ids] }

export interface AttachmentStart {
  userId: string
  siteId: string
  /** As the browser gave it: cleaned here. */
  name: string
  size: number
  /** The type the page chose by the name's extension (`attachmentTypeByName`). */
  type: string
}

/**
 * Why a file would be refused, by the rules of the domain, before anything is read: a name with
 * nothing left, a type not on the list or not of the name's extension, no bytes, too many bytes.
 */
function startRefusal(input: AttachmentStart): AttachmentRefusal | null {
  const name = attachmentFileName(input.name)
  if (name === null) return 'empty'
  const type = attachmentTypeOf(input.type)
  if (type === null || attachmentTypeByName(name)?.mime !== type.mime) return 'type_not_allowed'
  if (input.size < 1) return 'empty'
  if (input.size > attachmentLimits.fileBytes) return 'too_large'
  return null
}

/**
 * `attachment.start`: a file of a site the user may open is announced (`uploading`), with a day to
 * be sent (`ATTACHMENT_UNSENT_HOURS`). Answers its id and where the bytes go. A file the rules
 * refuse answers why, in the client's words; a site of someone else answers as one that does not
 * exist.
 */
export async function startAttachment(
  db: PrismaClient,
  input: AttachmentStart,
): Promise<{ attachmentId: string; uploadPath: string }> {
  const refusal = startRefusal(input)
  if (refusal !== null) throw attachmentRefused(refusal)
  // The rules of the domain once more, as the row will be written: the clean name and the listed
  // type spelt as the list spells it.
  const file = attachmentStartInputSchema.parse({
    siteId: input.siteId,
    name: input.name,
    size: input.size,
    type: attachmentTypeOf(input.type)?.mime,
  })
  const site = await db.site.findFirst({
    where: accessibleSite(input.userId, file.siteId),
    select: { id: true, workspaceId: true },
  })
  if (site === null) throw siteNotFound()
  const unsent = await db.attachment.count({
    where: {
      uploadedById: input.userId,
      status: { in: ['uploading', 'ready'] },
      expiresAt: { gt: new Date() },
    },
  })
  if (unsent >= UNSENT_ATTACHMENTS_PER_USER) throw attachmentsLimit()
  const row = await createAttachment(db, {
    workspaceId: site.workspaceId,
    siteId: site.id,
    uploadedById: input.userId,
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  })
  // The membership was lost between the two reads.
  if (row === null) throw siteNotFound()
  return { attachmentId: row.id, uploadPath: attachmentUploadPath(row.id) }
}

/**
 * `attachment.remove`: a file its uploader has not sent is removed — the row first, then the
 * object; a failed delete of the object is repeated by the same call. A sent file stays with its
 * task; a file of someone else answers as one that does not exist.
 */
export async function removeUnsentAttachment(
  db: PrismaClient,
  chat: ChatContext,
  input: { userId: string; attachmentId: string },
): Promise<void> {
  const key = await removeAttachment(db, { id: input.attachmentId, userId: input.userId })
  if (key === null) {
    const sent = await db.attachment.count({
      where: { id: input.attachmentId, uploadedById: input.userId, status: 'bound' },
    })
    throw sent > 0 ? attachmentSent() : siteNotFound()
  }
  await chat.storage().delete('inbox', key)
}

/** A file of a task as the cabinet lists it: never its key. */
export interface TaskAttachmentItem {
  id: string
  name: string
  type: string
  size: number
  kind: 'image' | 'document'
  sentAt: Date | null
}

/** `attachment.list`: the files sent with the messages of a task, for the file chooser (Б27). */
export async function listTaskAttachments(
  db: PrismaClient,
  input: { userId: string; taskId: string },
): Promise<TaskAttachmentItem[]> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true },
  })
  if (task === null) throw taskNotFound()
  const rows = await taskAttachments(db, task.id)
  return rows.map((row) => ({
    id: row.id,
    name: row.fileName,
    type: row.contentType,
    size: row.sizeBytes,
    kind: attachmentTypeOf(row.contentType)?.kind ?? 'document',
    sentAt: row.boundAt,
  }))
}

/**
 * `attachment.bind`: files uploaded from the file chooser of the browser (Б27, «Загрузить новый»)
 * are given to the task without a message, so the page of the site may take them. Only a task in
 * the browser that has not ended; the same rules of binding as a message.
 */
export async function bindChooserAttachments(
  db: PrismaClient,
  input: { userId: string; taskId: string; ids: readonly string[] },
): Promise<{ bound: number }> {
  return underDialogLock(db, input, async (tx, task) => {
    // Only the browser of a task opens a file chooser of a page.
    if (!task.requirements.browser) throw conflict('The task has no browser')
    if (terminalTaskStatuses.includes(task.status)) throw taskFinished()
    await bindMessageAttachments(tx, {
      ids: input.ids,
      taskId: task.id,
      userId: input.userId,
      workspaceId: task.workspaceId,
      siteId: task.siteId,
    })
    return { bound: input.ids.length }
  })
}
