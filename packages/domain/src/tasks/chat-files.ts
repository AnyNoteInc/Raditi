import { z } from 'zod'

import { DomainError } from '../errors.ts'

/**
 * Files the agent made for the client (docs/plan/66-chat-visuals.md, В8–В10): it writes them to
 * SANDBOX_OUT, the capture of a completed turn takes the regular files right there — never a
 * folder — as one ustar archive in zstd (the outbox), and core puts each into the artifacts
 * bucket and names it by a `feed.file` row. The outbox is never a part of the snapshot.
 */
export const outboxLimits = Object.freeze({
  /** Files of one turn. */
  files: 10,
  /** One file. */
  fileBytes: 20 * 1024 * 1024,
  /** The compressed archive. */
  archiveBytes: 16 * 1024 * 1024,
  /** Characters of a name. */
  nameChars: 200,
  /**
   * Bytes of a name as UTF-8: a plain ustar header holds a name without folders in its 100-byte
   * field alone, so a longer one cannot be archived.
   */
  nameBytes: 100,
})

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength

/**
 * The name of a file of the outbox as the client gets it: one name without folders — no slash,
 * no control character, not `.` or `..` — that fits a ustar header.
 */
export const outboxFileNameSchema = z
  .string()
  .min(1)
  .max(outboxLimits.nameChars)
  .refine(
    (name) =>
      !name.includes('/') &&
      !name.includes('\\') &&
      !/\p{Cc}/u.test(name) &&
      !name.includes('�') &&
      name !== '.' &&
      name !== '..' &&
      name.trim() === name &&
      utf8Bytes(name) <= outboxLimits.nameBytes,
    'invalid file name',
  )

/** The key of a file of a chat in the artifacts bucket. */
export const chatFileKey = (taskId: string, fileId: string): string => {
  const ids = z.uuid()
  if (!ids.safeParse(taskId).success || !ids.safeParse(fileId).success)
    throw new DomainError('BAD_REQUEST', 'A chat file key is built from two ids', 400)
  return `chat-files/${taskId.toLowerCase()}/${fileId.toLowerCase()}`
}
