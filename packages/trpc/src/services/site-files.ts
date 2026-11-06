import { randomUUID } from 'node:crypto'

import { enqueueOutbox, type PrismaClient } from '@repo/db'
import {
  AGENT_TURN_QUEUE,
  CANDIDATE_EDIT_JOB,
  candidateEditDedupeKey,
  DomainError,
  siteFileEditKey,
  siteFileEditSchema,
  terminalTaskStatuses,
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
      /** The commit listed: what a client's edit of a file of it names as its base. */
      sha: string
      version: string | null
      /** The chat's own changes are in it: the working copy of its agent, not the site's. */
      changed: boolean
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
  changed: boolean
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
    return {
      siteId: site.id,
      sha: site.installedSha.trim(),
      version: site.installedVersion,
      changed: false,
    }
  const initial = site.initialVersion
  if (initial?.importedAt == null) return null
  return { siteId: site.id, sha: initial.commitSha.trim(), version: initial.tag, changed: false }
}

/** A chat with the code of the site, of a workspace of the user; NOT_FOUND otherwise. */
async function chatOf(db: PrismaClient, userId: string, siteId: string, taskId: string) {
  const task = await db.task.findFirst({
    where: {
      id: taskId,
      siteId,
      deletedAt: null,
      workspace: { members: { some: { userId } } },
    },
    select: { id: true, status: true, turnNo: true, needsRepository: true },
  })
  if (task === null)
    throw new DomainError('NOT_FOUND', 'No such chat among the chats of the user', 404)
  return task
}

/**
 * The commit of a chat's working copy: the head of its changes while it has them, the site's
 * version otherwise — what its agent starts the next turn from.
 */
async function chatCommit(
  db: PrismaClient,
  userId: string,
  siteId: string,
  taskId: string,
): Promise<Commit | null> {
  const site = await siteCommit(db, userId, siteId)
  const task = await chatOf(db, userId, siteId, taskId)
  if (site === null || !task.needsRepository) return null
  const standing = await db.taskCandidate.findFirst({
    where: { taskId: task.id, status: { in: ['current', 'stale'] } },
    orderBy: { revision: 'desc' },
    select: { headSha: true },
  })
  return standing ? { ...site, sha: standing.headSha.trim(), changed: true } : site
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
  input: { userId: string; siteId: string; taskId?: string | undefined; now?: Date },
): Promise<SiteFilesAnswer> {
  const commit =
    input.taskId === undefined
      ? await siteCommit(db, input.userId, input.siteId)
      : await chatCommit(db, input.userId, input.siteId, input.taskId)
  if (commit === null) return { state: 'none' }
  const tree = await readTree(db, storage, commit, input.now ?? new Date())
  if (tree === null) return { state: 'preparing' }
  return {
    state: 'ready',
    sha: commit.sha,
    version: commit.version,
    changed: commit.changed,
    truncated: tree.truncated,
    files: tree.files.map((file) => ({ path: file.path, size: file.size })),
  }
}

/** One file of the version the site has: its text, or why it is not shown. */
export async function readSiteFile(
  db: PrismaClient,
  storage: ObjectStorage,
  input: {
    userId: string
    siteId: string
    taskId?: string | undefined
    /** The commit the list named; absent — the one standing now. */
    sha?: string | undefined
    path: string
    now?: Date
  },
): Promise<SiteFileAnswer> {
  const now = input.now ?? new Date()
  const standing =
    input.taskId === undefined
      ? await siteCommit(db, input.userId, input.siteId)
      : await chatCommit(db, input.userId, input.siteId, input.taskId)
  // The file of the commit the client looks at: a list read a moment ago may name an older one.
  const commit =
    standing && input.sha && input.sha !== standing.sha ? { ...standing, sha: input.sha } : standing
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

export type SiteFileEditState =
  | { state: 'pending' }
  | { state: 'saved' | 'conflict' | 'refused' | 'failed'; revision: number | null }

/**
 * The client's edit of a file of a chat's working copy (owner's request of 06.11.2026): the text
 * goes into the inbox bucket and core is asked through the outbox to commit it to the chat's
 * branch (`candidate.edit`). A chat that has ended, has no code or had no first answer of its
 * agent takes no edit; one whose agent works takes it, and core applies it when the agent waits.
 */
export async function saveSiteFile(
  db: PrismaClient,
  storage: ObjectStorage,
  input: {
    userId: string
    siteId: string
    taskId: string
    path: string
    baseSha: string
    text: string
    now?: Date
  },
): Promise<{ editId: string }> {
  const task = await chatOf(db, input.userId, input.siteId, input.taskId)
  if (!task.needsRepository || terminalTaskStatuses.includes(task.status))
    throw new DomainError('SITE_FILE_EDIT_CLOSED', 'The chat takes no edit of a file', 409)
  if (task.turnNo < 1)
    throw new DomainError('SITE_FILE_EDIT_NO_TURN', 'The chat has no working copy yet', 409)
  const edit = siteFileEditSchema.parse({
    v: 1,
    taskId: task.id,
    path: input.path,
    baseSha: input.baseSha,
    text: input.text,
    savedAt: (input.now ?? new Date()).toISOString(),
  })
  const editId = randomUUID()
  const body = Buffer.from(JSON.stringify(edit))
  await storage.put('inbox', siteFileEditKey(task.id, editId), body, {
    contentType: 'application/json',
    sizeBytes: body.byteLength,
  })
  const job = { taskId: task.id, editId }
  await enqueueOutbox(db, {
    topic: AGENT_TURN_QUEUE,
    type: CANDIDATE_EDIT_JOB,
    payload: job,
    dedupeKey: candidateEditDedupeKey(job),
  })
  return { editId }
}

/** What came of an edit: its `feed.edit` row, or none yet. */
export async function siteFileEditState(
  db: PrismaClient,
  input: { userId: string; siteId: string; taskId: string; editId: string },
): Promise<SiteFileEditState> {
  const task = await chatOf(db, input.userId, input.siteId, input.taskId)
  const rows = await db.$queryRaw<Array<{ outcome: string; revision: number | null }>>`
    SELECT payload->>'outcome' AS outcome, (payload->>'revision')::int AS revision
    FROM task_events
    WHERE task_id = ${task.id}::uuid AND type = 'feed.edit' AND payload->>'editId' = ${input.editId}
    ORDER BY id DESC LIMIT 1`
  const row = rows[0]
  if (!row) return { state: 'pending' }
  const outcome = (['saved', 'conflict', 'refused', 'failed'] as const).find(
    (known) => known === row.outcome,
  )
  return { state: outcome ?? 'failed', revision: row.revision }
}
