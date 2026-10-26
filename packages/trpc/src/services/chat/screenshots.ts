import { Buffer } from 'node:buffer'

import type { PrismaClient } from '@repo/db'
import { browserScreenshotLimits, browserTaskScreenshotKey, type ObjectStorage } from '@repo/domain'
import { z } from 'zod'

import { accessibleTask } from './access.ts'

/** The first bytes of every JPEG (SOI and the next marker's prefix). */
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])

/**
 * A snapshot of a task's browser for the dialog (`feed.screenshot`, owner's request of
 * 26.10.2026): its JPEG from the inbox, for a member of the task's workspace. The id must be one
 * a row of this task's dialog names — no other key of the inbox is ever read; someone else's
 * task, a snapshot of another task and a missing image all answer null.
 */
export async function readTaskScreenshot(
  db: Pick<PrismaClient, 'task' | 'taskEvent'>,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; taskId: string; screenshotId: string },
): Promise<Buffer | null> {
  if (!z.uuid().safeParse(input.taskId).success || !z.uuid().safeParse(input.screenshotId).success)
    return null
  const taskId = input.taskId.toLowerCase()
  const screenshotId = input.screenshotId.toLowerCase()
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, taskId),
    select: { id: true },
  })
  if (task === null) return null
  const row = await db.taskEvent.findFirst({
    where: {
      taskId: task.id,
      type: 'feed.screenshot',
      payload: { path: ['screenshotId'], equals: screenshotId },
    },
    select: { id: true },
  })
  if (row === null) return null
  const object = await storage.get('inbox', browserTaskScreenshotKey(task.id, screenshotId))
  if (!object) return null
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of object) {
    length += chunk.byteLength
    if (length > browserScreenshotLimits.bytes) return null
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  return bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE) ? bytes : null
}
