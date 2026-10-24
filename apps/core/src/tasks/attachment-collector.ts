import {
  listExpiredAttachments,
  markExpiredAttachmentDeleted,
  type ExpiredAttachment,
  type PrismaClient,
} from '@repo/db'
import type { ObjectStorage } from '@repo/domain'

// The collector of files nobody sent (docs/plan/57-browser-tasks.md, Б26): a file announced and
// uploaded but never sent with a message expires after a day (`ATTACHMENT_UNSENT_HOURS`), and its
// object leaves raditi-inbox. A file sent with a message is never collected here: it follows the
// retention of the bucket (spec §14).

/** Where the collector finds expired files nobody sent and marks them removed. */
export interface ExpiredAttachmentStore {
  list(limit: number): Promise<ExpiredAttachment[]>
  /** false — the file is no longer one to collect (marked already). */
  markDeleted(id: string): Promise<boolean>
}

/** The store of @repo/db. */
export const expiredAttachmentsIn = (db: PrismaClient): ExpiredAttachmentStore => ({
  list: (limit) => listExpiredAttachments(db, { limit }),
  markDeleted: (id) => markExpiredAttachmentDeleted(db, { id }),
})

export interface AttachmentCollectorDependencies {
  files: ExpiredAttachmentStore
  storage: Pick<ObjectStorage, 'delete'>
  /** At most this many files in one call. */
  limit: number
  /** A file whose object or row could not be removed: it waits for the next call. */
  onFailure?: (id: string, error: unknown) => void
}

/**
 * Removes up to `limit` expired files nobody sent: the object first, then the row. A delete that
 * fails leaves the row for the next call; S3 deletes a missing key without an error, so a repeat
 * after a stop between the two only marks the row. Answers how many files were removed.
 */
export async function collectExpiredAttachments(
  deps: AttachmentCollectorDependencies,
): Promise<number> {
  let removed = 0
  for (const file of await deps.files.list(deps.limit)) {
    try {
      await deps.storage.delete('inbox', file.key)
      if (await deps.files.markDeleted(file.id)) removed++
    } catch (error) {
      deps.onFailure?.(file.id, error)
    }
  }
  return removed
}
