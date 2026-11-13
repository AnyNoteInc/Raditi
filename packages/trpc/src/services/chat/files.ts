import { Buffer } from 'node:buffer'

import type { PrismaClient } from '@repo/db'
import { chatFileKey, feedFilePayloadSchema, type ObjectStorage } from '@repo/domain'
import { z } from 'zod'

import { accessibleTask } from './access.ts'

export interface ChatFile {
  name: string
  bytes: Buffer
}

/**
 * A file the agent made for the client (`feed.file`, docs/plan/66-chat-visuals.md, В8–В10): its
 * bytes from the artifacts bucket, for a member of the task's workspace. The id must be one a
 * row of this task's chat names — no other key of the bucket is ever read; someone else's task, a
 * file of another task, a missing object and one of another size than its row says all answer
 * null.
 */
export async function readTaskFile(
  db: Pick<PrismaClient, 'task' | 'taskEvent'>,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; taskId: string; fileId: string },
): Promise<ChatFile | null> {
  if (!z.uuid().safeParse(input.taskId).success || !z.uuid().safeParse(input.fileId).success)
    return null
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId.toLowerCase()),
    select: { id: true },
  })
  if (task === null) return null
  return readChatFile(db, storage, { taskId: task.id, fileId: input.fileId })
}

/**
 * The file of a `feed.file` row of a task the caller has already found — for a member, or for a
 * share that names it (docs/plan/67-agent-documents.md, Д8). The same answers as `readTaskFile`.
 */
export async function readChatFile(
  db: Pick<PrismaClient, 'taskEvent'>,
  storage: Pick<ObjectStorage, 'get'>,
  input: { taskId: string; fileId: string },
): Promise<ChatFile | null> {
  if (!z.uuid().safeParse(input.taskId).success || !z.uuid().safeParse(input.fileId).success)
    return null
  const taskId = input.taskId.toLowerCase()
  const fileId = input.fileId.toLowerCase()
  const row = await db.taskEvent.findFirst({
    where: { taskId, type: 'feed.file', payload: { path: ['fileId'], equals: fileId } },
    select: { payload: true },
  })
  const payload = feedFilePayloadSchema.safeParse(row?.payload)
  if (!payload.success) return null
  const object = await storage.get('artifacts', chatFileKey(taskId, fileId))
  if (!object) return null
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of object) {
    length += chunk.byteLength
    if (length > payload.data.sizeBytes) return null
    chunks.push(chunk)
  }
  if (length !== payload.data.sizeBytes) return null
  return { name: payload.data.name, bytes: Buffer.concat(chunks, length) }
}
