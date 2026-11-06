import { enqueueOutbox, type PrismaClient } from '@repo/db'
import {
  SITE_FILES_BLOB_JOB,
  SITE_FILES_QUEUE,
  SITE_FILES_TREE_JOB,
  siteFileBlobKey,
  siteFileContentSchema,
  siteFilesLimits,
  siteFilesTreeKey,
  siteFilesTreeSchema,
  type ObjectStorage,
  type SiteFilesTree,
} from '@repo/domain'

import { accessibleSite, siteNotFound } from './site-basics.ts'

// The section «Терминал» of a project (owner's request of 06.11.2026): the files of the version
// the site has, to look at, never to change. Web has no credential of git (CLAUDE.md rule 2): core
// reads the mirror and puts the list of the files of a commit, and a file by the id of its bytes,
// into the bucket of artifacts; here they are read, and a missing one is asked of core through the
// outbox. The page asks again while it waits: a job lost or failed is put again by the next look.

/** A list of the files of a commit is at most this long as JSON: the limit of entries, with room. */
const TREE_BYTES = siteFilesLimits.entries * 1_200
/** A file as JSON: the view limit, every byte escaped at worst. */
const BLOB_BYTES = siteFilesLimits.viewBytes * 6 + 1_024
/** A look asks core again after this: a job lost is put again, one in flight is not doubled. */
const ASK_AGAIN_MS = 30_000

export type SiteFilesAnswer =
  | { state: 'none' }
  | { state: 'preparing' }
  | {
      state: 'ready'
      version: string | null
      truncated: boolean
      files: Array<{ path: string; size: number }>
    }

export type SiteFileAnswer =
  | { state: 'none' | 'preparing' | 'missing' | 'binary' | 'too_large' }
  | { state: 'ready'; text: string }

interface Commit {
  siteId: string
  sha: string
  version: string | null
}

/**
 * The commit the site is at: the installed version, or the first one after the import while
 * nothing was released. null — the site has no files in a repository.
 */
async function siteCommit(
  db: PrismaClient,
  userId: string,
  siteId: string,
): Promise<Commit | null> {
  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: {
      id: true,
      installedSha: true,
      installedVersion: true,
      initialVersion: { select: { commitSha: true, tag: true, importedAt: true } },
      _count: { select: { gitRepositories: true } },
    },
  })
  if (site === null) throw siteNotFound()
  if (site._count.gitRepositories === 0) return null
  if (site.installedSha !== null)
    return { siteId: site.id, sha: site.installedSha.trim(), version: site.installedVersion }
  const initial = site.initialVersion
  if (initial?.importedAt == null) return null
  return { siteId: site.id, sha: initial.commitSha.trim(), version: initial.tag }
}

async function readJson(
  storage: ObjectStorage,
  key: string,
  limit: number,
): Promise<unknown | undefined> {
  const body = await storage.get('artifacts', key)
  if (body === null) return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.byteLength
    if (size > limit) return null
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return null
  }
}

/** Asks core for an object at most once in `ASK_AGAIN_MS` per object. */
async function ask(
  db: PrismaClient,
  type: typeof SITE_FILES_TREE_JOB | typeof SITE_FILES_BLOB_JOB,
  payload: { siteId: string; sha: string; path?: string },
  object: string,
  now: Date,
): Promise<void> {
  const slot = Math.floor(now.getTime() / ASK_AGAIN_MS)
  await enqueueOutbox(db, {
    topic: SITE_FILES_QUEUE,
    type,
    payload,
    dedupeKey: `site-files:${object}:${slot}`,
  })
}

async function readTree(
  db: PrismaClient,
  storage: ObjectStorage,
  commit: Commit,
  now: Date,
): Promise<SiteFilesTree | null> {
  const raw = await readJson(storage, siteFilesTreeKey(commit.siteId, commit.sha), TREE_BYTES)
  const tree = raw === undefined ? null : siteFilesTreeSchema.safeParse(raw)
  if (tree?.success && tree.data.sha === commit.sha) return tree.data
  await ask(
    db,
    SITE_FILES_TREE_JOB,
    { siteId: commit.siteId, sha: commit.sha },
    `tree:${commit.siteId}:${commit.sha}`,
    now,
  )
  return null
}

/** The files of the version the site has, path by path in the order of git. */
export async function listSiteFiles(
  db: PrismaClient,
  storage: ObjectStorage,
  input: { userId: string; siteId: string; now?: Date },
): Promise<SiteFilesAnswer> {
  const commit = await siteCommit(db, input.userId, input.siteId)
  if (commit === null) return { state: 'none' }
  const tree = await readTree(db, storage, commit, input.now ?? new Date())
  if (tree === null) return { state: 'preparing' }
  return {
    state: 'ready',
    version: commit.version,
    truncated: tree.truncated,
    files: tree.files.map((file) => ({ path: file.path, size: file.size })),
  }
}

/** One file of the version the site has: its text, or why it is not shown. */
export async function readSiteFile(
  db: PrismaClient,
  storage: ObjectStorage,
  input: { userId: string; siteId: string; path: string; now?: Date },
): Promise<SiteFileAnswer> {
  const now = input.now ?? new Date()
  const commit = await siteCommit(db, input.userId, input.siteId)
  if (commit === null) return { state: 'none' }
  const tree = await readTree(db, storage, commit, now)
  if (tree === null) return { state: 'preparing' }
  // Only a file of the list: the path names an entry of the tree, nothing else.
  const entry = tree.files.find((file) => file.path === input.path)
  if (!entry) return { state: 'missing' }
  if (entry.size > siteFilesLimits.viewBytes) return { state: 'too_large' }
  const raw = await readJson(storage, siteFileBlobKey(commit.siteId, entry.oid), BLOB_BYTES)
  const content = raw === undefined ? null : siteFileContentSchema.safeParse(raw)
  if (content?.success) {
    const value = content.data
    return value.state === 'text' ? { state: 'ready', text: value.text } : { state: value.state }
  }
  await ask(
    db,
    SITE_FILES_BLOB_JOB,
    { siteId: commit.siteId, sha: commit.sha, path: entry.path },
    `blob:${commit.siteId}:${entry.oid}`,
    now,
  )
  return { state: 'preparing' }
}
