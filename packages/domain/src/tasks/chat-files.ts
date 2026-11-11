import { z } from 'zod'

import { DomainError } from '../errors.ts'

/**
 * Files the agent made for the client (docs/plan/66-chat-visuals.md, В8–В10): it writes them to
 * SANDBOX_OUT, the capture of a completed turn takes the regular files right there — never a
 * folder — as one ustar archive in zstd (the outbox) with a manifest of their names, and core puts
 * each into the artifacts bucket and names it by a `feed.file` row. The outbox is never a part of
 * the snapshot.
 */
export const outboxLimits = Object.freeze({
  /** Files of one turn. */
  files: 10,
  /** One file. */
  fileBytes: 20 * 1024 * 1024,
  /** The compressed archive. */
  archiveBytes: 16 * 1024 * 1024,
  /**
   * Characters of a name. The archive does not carry the names in its headers — a plain ustar
   * header holds 100 bytes, fifty Russian letters — but in its manifest: see `outboxManifestSchema`.
   */
  nameChars: 200,
})

/**
 * The name of a file of the outbox as the client gets it: one name without folders — no slash,
 * no control character, not `.` or `..`, not longer than `outboxLimits.nameChars`.
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
      name.trim() === name,
    'invalid file name',
  )

/** The first entry of an outbox archive: the manifest, a file of this name. */
export const OUTBOX_MANIFEST_ENTRY = 'manifest.json'

/** The most a manifest takes: ten names of 200 characters, four bytes each, with their quotes. */
export const OUTBOX_MANIFEST_BYTES = 32 * 1024

/**
 * What an outbox archive says about itself (docs/plan/66-chat-visuals.md, В8, «Имена файлов»). The
 * files in the archive are named by their number — `0`, `1`, … in the order of `names` — and
 * `names` holds the names the client gets, so that a name is bounded by its characters and not by
 * a ustar header. `skipped` counts what lay in the folder and was left — a folder, a link, a name
 * that cannot reach the client —, and `refused` says that the files themselves were taken
 * out: too many, too large, or one of them held a secret. A manifest of either kind makes core
 * tell the client that not everything arrived.
 */
export const outboxManifestSchema = z
  .strictObject({
    v: z.literal(1),
    names: z.array(outboxFileNameSchema).max(outboxLimits.files),
    skipped: z.number().int().min(0).max(1_000_000),
    refused: z.boolean(),
  })
  .refine(
    (manifest) =>
      new Set(manifest.names).size === manifest.names.length &&
      (!manifest.refused || manifest.names.length === 0),
    'invalid outbox manifest',
  )
export type OutboxManifest = z.infer<typeof outboxManifestSchema>

/** The key of a file of a chat in the artifacts bucket. */
export const chatFileKey = (taskId: string, fileId: string): string => {
  const ids = z.uuid()
  if (!ids.safeParse(taskId).success || !ids.safeParse(fileId).success)
    throw new DomainError('BAD_REQUEST', 'A chat file key is built from two ids', 400)
  return `chat-files/${taskId.toLowerCase()}/${fileId.toLowerCase()}`
}
