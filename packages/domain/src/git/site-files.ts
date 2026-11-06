import { z } from 'zod'

import type { QueueName } from '../ports/job-queue.ts'

/**
 * The files of a project as its section «Терминал» shows them (owner's request of 06.11.2026:
 * «когда я работаю с проектом сделай в левом меню терминал и там файловую структуру с
 * возможностью просмотра файлов»). Read only, of the version the site has (`main`): web has no
 * credential of git (CLAUDE.md rule 2), so core reads the mirror and puts what web asks for into
 * the bucket of artifacts — the list of the files of a commit, and a file by the id of its content.
 * Both are immutable: a commit names its tree, an id its bytes. The jobs carry ids only.
 */
export const SITE_FILES_QUEUE = 'site-files' satisfies QueueName

/** The list of the files of one commit of the site. */
export const SITE_FILES_TREE_JOB = 'site-files.tree'
/** The content of one file of that commit. */
export const SITE_FILES_BLOB_JOB = 'site-files.blob'

const commitSha = z.string().regex(/^[0-9a-f]{40}$/)
const blobOid = z.string().regex(/^[0-9a-f]{40}$/)
/** A path of the tree as git names it: relative, no `.` or `..` part, no NUL. */
export const siteFilePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.includes('\0') &&
      !path.startsWith('/') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Invalid path',
  )

export const siteFilesTreeJobSchema = z.strictObject({ siteId: z.uuid(), sha: commitSha })
export type SiteFilesTreeJob = z.infer<typeof siteFilesTreeJobSchema>

export const siteFilesBlobJobSchema = z.strictObject({
  siteId: z.uuid(),
  sha: commitSha,
  path: siteFilePathSchema,
})
export type SiteFilesBlobJob = z.infer<typeof siteFilesBlobJobSchema>

export const siteFilesLimits = Object.freeze({
  /** Files of a list; a tree with more is listed up to this and says so. */
  entries: 50_000,
  /** A file is shown up to this many bytes; a longer one is named, not shown. */
  viewBytes: 256 * 1024,
})

/** One regular file of the tree (a link or a submodule is not listed). */
export const siteFileEntrySchema = z.strictObject({
  path: siteFilePathSchema,
  size: z.number().int().min(0),
  oid: blobOid,
})
export type SiteFileEntry = z.infer<typeof siteFileEntrySchema>

export const siteFilesTreeSchema = z.strictObject({
  v: z.literal(1),
  sha: commitSha,
  files: z.array(siteFileEntrySchema).max(siteFilesLimits.entries),
  /** The tree holds more files than the list. */
  truncated: z.boolean(),
})
export type SiteFilesTree = z.infer<typeof siteFilesTreeSchema>

/** A file as the viewer shows it: its text, or why it is not shown. */
export const siteFileContentSchema = z.discriminatedUnion('state', [
  z.strictObject({ v: z.literal(1), state: z.literal('text'), text: z.string() }),
  z.strictObject({ v: z.literal(1), state: z.literal('binary') }),
  z.strictObject({ v: z.literal(1), state: z.literal('too_large') }),
])
export type SiteFileContent = z.infer<typeof siteFileContentSchema>

/** The object of the list of the files of `sha` in the bucket of artifacts. */
export const siteFilesTreeKey = (siteId: string, sha: string): string =>
  `site-files/${siteId}/trees/${sha}.json`

/** The object of the content `oid` of a file of the site in the bucket of artifacts. */
export const siteFileBlobKey = (siteId: string, oid: string): string =>
  `site-files/${siteId}/blobs/${oid}.json`

/**
 * The text of bytes the viewer can show: UTF-8 without NUL, or null — a binary file. A file whose
 * bytes are not valid UTF-8 is binary too: the viewer never guesses an encoding.
 */
export function siteFileText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
