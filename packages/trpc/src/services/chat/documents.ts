import type { PrismaClient } from '@repo/db'
import {
  DomainError,
  documentImageNameOf,
  documentImageTypeOf,
  documentKindOf,
  documentTextOf,
  feedFilePayloadSchema,
  type DocumentImageType,
  type ObjectStorage,
} from '@repo/domain'
import { z } from 'zod'

import { accessibleTask, taskNotFound } from './access.ts'
import type { ChatContext } from './context.ts'
import { readChatFile, readTaskFile } from './files.ts'
import { PAGE_VIEW_TTL_MS, signPageView } from './page-tokens.ts'

// The documents of a chat in the cabinet (docs/plan/67-agent-documents.md, Д3, Д5): the address of
// a page in the frame of the domain of pages, the text of a Markdown document the cabinet draws,
// and a picture of the chat such a document shows. Every one is read for a member of the task's
// workspace from the file a `feed.file` row of the chat names, nothing else of the bucket.

export const pagesUnavailable = () =>
  new DomainError('PAGES_UNAVAILABLE', 'The pages of the agent are not shown here', 503)

/** The `feed.file` row of a file of a chat the user may open; null — none of that kind. */
async function chatFileRow(
  db: Pick<PrismaClient, 'task' | 'taskEvent'>,
  input: { userId: string; taskId: string; fileId: string },
): Promise<{ taskId: string; fileId: string; name: string } | null> {
  if (!z.uuid().safeParse(input.taskId).success || !z.uuid().safeParse(input.fileId).success)
    return null
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId.toLowerCase()),
    select: { id: true },
  })
  if (task === null) return null
  const fileId = input.fileId.toLowerCase()
  const row = await db.taskEvent.findFirst({
    where: { taskId: task.id, type: 'feed.file', payload: { path: ['fileId'], equals: fileId } },
    select: { payload: true },
  })
  const payload = feedFilePayloadSchema.safeParse(row?.payload)
  return payload.success ? { taskId: task.id, fileId, name: payload.data.name } : null
}

/**
 * The address the frame of the cabinet opens a page of the chat at: `<root of PAGES_BASE_DOMAIN>/v/<token>`,
 * for this user, five minutes. Someone else's chat, a file of another chat and a file that is no
 * page answer NOT_FOUND alike.
 */
export async function issuePageView(
  db: Pick<PrismaClient, 'task' | 'taskEvent'>,
  chat: ChatContext,
  input: { userId: string; taskId: string; fileId: string },
  now = Date.now(),
): Promise<{ url: string; expiresAt: string }> {
  if (chat.pageViews == null) throw pagesUnavailable()
  const row = await chatFileRow(db, input)
  if (row === null || documentKindOf(row.name) !== 'page') throw taskNotFound()
  const expiresAt = now + PAGE_VIEW_TTL_MS
  const token = signPageView(chat.pageViews.keys.view, {
    taskId: row.taskId,
    fileId: row.fileId,
    userId: input.userId,
    expiresAt,
  })
  return {
    url: `${chat.pageViews.origin}/v/${token}`,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

export type DocumentText =
  | { readable: true; text: string; truncated: boolean }
  /** Not UTF-8: «Не удалось прочитать документ» and «Скачать». */
  | { readable: false }

/** The text of a Markdown document of the chat (Д5); NOT_FOUND as `issuePageView`. */
export async function readDocumentText(
  db: Pick<PrismaClient, 'task' | 'taskEvent'>,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; taskId: string; fileId: string },
): Promise<DocumentText> {
  const row = await chatFileRow(db, input)
  if (row === null || documentKindOf(row.name) !== 'markdown') throw taskNotFound()
  const file = await readChatFile(db, storage, row)
  if (file === null) throw taskNotFound()
  const read = documentTextOf(file.bytes)
  return read === null ? { readable: false } : { readable: true, ...read }
}

/**
 * A picture of the chat a Markdown document shows (Д5): PNG, JPEG, WebP or GIF by its bytes,
 * never SVG; null — someone else's chat, no such file, not a picture.
 */
export async function readChatImage(
  db: Pick<PrismaClient, 'task' | 'taskEvent'>,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; taskId: string; fileId: string },
): Promise<{ type: DocumentImageType; bytes: Uint8Array } | null> {
  const file = await readTaskFile(db, storage, input)
  if (file === null || !documentImageNameOf(file.name)) return null
  const type = documentImageTypeOf(file.bytes)
  return type === null ? null : { type, bytes: file.bytes }
}
