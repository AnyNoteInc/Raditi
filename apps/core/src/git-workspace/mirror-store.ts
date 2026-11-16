import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { badRequest, mirrorLimits, projectRepositoryIdSchema } from '@repo/domain'

// The volume of trusted git (docs/plan/84-projects.md, ПР12, §4.2): one bare mirror per
// repository of a project, `repos/<projectRepositoryId>.git`; the base bundles of turns by that
// id and their commit, `bundles/<id>/<sha>.bundle`; the directories of operations, `ops/`.
// Returned from main, where a mirror was keyed by a hash of the repository and its URL and a
// bundle by its commit alone: here another project's commit never comes out of the cache (§4.6).
// Core and its git worker share the volume and one group, nobody else (ПР33).

/** Directories of the volume: core and the worker, never other users. */
export const SHARED_DIR_MODE = 0o770
/** Files core writes for the worker to read. */
export const SHARED_FILE_MODE = 0o660

/**
 * The root of the volume belongs to this process and its group, never to everyone: the worker
 * runs git with a mirror there as its repository, so another local user must not be able to
 * plant one (a shared `/tmp` of a Linux host). Made when absent; one of ours open to others is
 * closed; a link, or a directory of another user, is refused.
 */
export function assertSharedDirectory(path: string): void {
  const refused = () => badRequest('Repository mirror directory must be a private directory')
  try {
    mkdirSync(path, { recursive: true, mode: SHARED_DIR_MODE })
  } catch {
    throw refused()
  }
  const info = lstatSync(path)
  const uid = process.getuid?.()
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) throw refused()
  if ((info.mode & 0o007) !== 0) chmodSync(path, info.mode & 0o770)
}

/** A directory for the worker too, whatever the umask of core is. */
export async function sharedDirectory(path: string, recursive = false): Promise<void> {
  // An existing directory stays as it is: it may be the worker's, which core cannot chmod.
  const made = await mkdir(path, { recursive, mode: SHARED_DIR_MODE })
  if (!recursive || made !== undefined) await chmod(path, SHARED_DIR_MODE)
}

/** A new file the worker reads, whatever the umask of core is. */
export async function sharedFile(path: string, data: string | Uint8Array): Promise<void> {
  await writeFile(path, data, { mode: SHARED_FILE_MODE, flag: 'wx' })
  await chmod(path, SHARED_FILE_MODE)
}

const repositoryId = (id: string): string => {
  if (!projectRepositoryIdSchema.safeParse(id).success) throw badRequest('Invalid repository id')
  return id
}

/** The bare mirror of one repository of a project. */
export const mirrorPath = (root: string, projectRepositoryId: string): string =>
  join(root, 'repos', `${repositoryId(projectRepositoryId)}.git`)

/** Where operations make their private directories. */
export const operationsDir = (root: string): string => join(root, 'ops')

/** One operation at a time per key, in the order they asked; a failure does not block the next. */
export class KeyedLock {
  readonly #tails = new Map<string, Promise<void>>()

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const done = Promise.withResolvers<void>()
    const tail = previous.then(() => done.promise)
    this.#tails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      done.resolve()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
}

const SHA = /^[a-f0-9]{40}$/

/**
 * Base bundles by the repository of a project and the commit their single ref points at. A
 * bundle holds exactly the objects that commit reaches; the reader still checks the ref it
 * carries. Writes are atomic (a temporary name, then rename); the oldest files beyond the limit
 * go. A commit of one project is never served for another: the id is part of the path.
 */
export class BundleCache {
  readonly #dir: string

  constructor(root: string) {
    this.#dir = join(root, 'bundles')
  }

  #path(projectRepositoryId: string, sha: string): string | null {
    if (!SHA.test(sha) || !projectRepositoryIdSchema.safeParse(projectRepositoryId).success)
      return null
    return join(this.#dir, projectRepositoryId, `${sha}.bundle`)
  }

  async get(projectRepositoryId: string, sha: string): Promise<Buffer | null> {
    const path = this.#path(projectRepositoryId, sha)
    if (!path) return null
    try {
      const bytes = await readFile(path)
      const now = new Date()
      await utimes(path, now, now).catch(() => {})
      return bytes
    } catch {
      return null
    }
  }

  async put(projectRepositoryId: string, sha: string, bytes: Uint8Array): Promise<void> {
    const path = this.#path(projectRepositoryId, sha)
    if (!path) return
    try {
      const dir = join(this.#dir, projectRepositoryId)
      await sharedDirectory(this.#dir, true)
      await sharedDirectory(dir, true)
      const temporary = join(dir, `.${sha}.${randomBytes(6).toString('hex')}.tmp`)
      await sharedFile(temporary, bytes)
      await rename(temporary, path)
      await this.#evict()
    } catch {
      // A cache: a write that fails costs the next turn a rebuild, nothing else.
    }
  }

  /** Drops every bundle of a repository: it is detached or its mirror was made again. */
  async forget(projectRepositoryId: string): Promise<void> {
    if (!projectRepositoryIdSchema.safeParse(projectRepositoryId).success) return
    await rm(join(this.#dir, projectRepositoryId), { recursive: true, force: true })
  }

  async #evict(): Promise<void> {
    const files: { path: string; at: number }[] = []
    for (const id of await readdir(this.#dir).catch(() => [] as string[])) {
      if (!projectRepositoryIdSchema.safeParse(id).success) continue
      for (const name of await readdir(join(this.#dir, id)).catch(() => [] as string[])) {
        if (!/^[a-f0-9]{40}\.bundle$/.test(name)) continue
        const path = join(this.#dir, id, name)
        files.push({ path, at: (await stat(path).catch(() => null))?.mtimeMs ?? 0 })
      }
    }
    if (files.length <= mirrorLimits.bundlesKept) return
    files.sort((a, b) => a.at - b.at)
    await Promise.all(
      files
        .slice(0, files.length - mirrorLimits.bundlesKept)
        .map(({ path }) => rm(path, { force: true })),
    )
  }
}
