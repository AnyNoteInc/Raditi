import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, lstatSync, mkdirSync } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { badRequest, mirrorLimits, projectRepositoryIdSchema } from '@repo/domain'
import { z } from 'zod'

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

/** The first bytes of a bundle a reader needs for its header (bundleHead reads 4 KiB at most). */
export const BUNDLE_HEADER_BYTES = 4096

/** A bundle read (or written) this recently may be streaming to a runner: eviction keeps it. */
export const BUNDLE_IN_USE_MS = 10 * 60_000

/** A bundle of the cache: its file, read as a stream, and what core knows of its bytes. */
export interface CachedBundle {
  path: string
  sha256: string
  sizeBytes: number
  /** The first bytes of the file, up to BUNDLE_HEADER_BYTES: its header and refs. */
  header: Buffer
}

/**
 * `<sha>.json` next to `<sha>.bundle`: the hash and size of the bundle, and the inode of the file
 * they were taken of — a file put again under the same name is a new inode, and its hash is
 * taken again. Never trusted further than this cache: the importer checks the bytes it read.
 */
const bundleMetaSchema = z.object({
  v: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
})

/** The SHA-256 of a file, read as a stream. */
async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Base bundles by the repository of a project and the commit their single ref points at. A
 * bundle holds exactly the objects that commit reaches; the reader still checks the ref it
 * carries. Writes are atomic (a temporary name, then rename); the oldest files beyond the limit
 * go. A commit of one project is never served for another: the id is part of the path. The hash
 * and size of each bundle wait in a sidecar file, so a bundle served again is neither read whole
 * nor hashed again; one without a sidecar gets it at its first read.
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

  async get(projectRepositoryId: string, sha: string): Promise<CachedBundle | null> {
    const path = this.#path(projectRepositoryId, sha)
    if (!path) return null
    try {
      const { ino, size, header } = await headerOf(path)
      const meta = bundleMetaSchema.safeParse(
        JSON.parse(await readFile(metaPath(path), 'utf8').catch(() => 'null')),
      )
      let sha256: string
      if (meta.success && meta.data.ino === ino && meta.data.sizeBytes === size)
        sha256 = meta.data.sha256
      else {
        // A bundle of a cache written before the sidecars, or one whose sidecar is not its own.
        sha256 = await fileSha256(path)
        const again = await stat(path)
        if (again.ino !== ino || again.size !== size) return null
        await writeMeta(path, { v: 1, sha256, sizeBytes: size, ino }).catch(() => {})
      }
      const now = new Date()
      await utimes(path, now, now).catch(() => {})
      return { path, sha256, sizeBytes: size, header }
    } catch {
      return null
    }
  }

  /**
   * Copies the bundle at `source` into the cache, hashing it on the way. null — the cache could
   * not keep it (the caller reads `source` itself then).
   */
  async put(
    projectRepositoryId: string,
    sha: string,
    source: string,
  ): Promise<CachedBundle | null> {
    const path = this.#path(projectRepositoryId, sha)
    if (!path) return null
    // A bundle of this commit is already in place: a reader may be streaming it, so it is never
    // replaced by a new file (`git bundle create` does not promise the same bytes).
    const present = await this.get(projectRepositoryId, sha)
    if (present) return present
    const dir = join(this.#dir, projectRepositoryId)
    const temporary = join(dir, `.${sha}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await sharedDirectory(this.#dir, true)
      await sharedDirectory(dir, true)
      const hash = createHash('sha256')
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk)
          done(null, chunk)
        },
      })
      await pipeline(
        createReadStream(source),
        hashing,
        createWriteStream(temporary, { mode: SHARED_FILE_MODE, flags: 'wx' }),
      )
      await chmod(temporary, SHARED_FILE_MODE)
      const sha256 = hash.digest('hex')
      const { ino, size, header } = await headerOf(temporary)
      // The sidecar first: a bundle is never in place with the sidecar of another file for long,
      // and a mismatch only costs a hash.
      await writeMeta(path, { v: 1, sha256, sizeBytes: size, ino })
      await rename(temporary, path)
      await this.#evict()
      return { path, sha256, sizeBytes: size, header }
    } catch {
      // A cache: a write that fails costs the next turn a rebuild, nothing else.
      await rm(temporary, { force: true }).catch(() => {})
      return null
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
    // A bundle served in the last minutes may still be streamed to a runner: it stays.
    const recent = Date.now() - BUNDLE_IN_USE_MS
    await Promise.all(
      files
        .slice(0, files.length - mirrorLimits.bundlesKept)
        .filter(({ at }) => at < recent)
        .flatMap(({ path }) => [rm(path, { force: true }), rm(metaPath(path), { force: true })]),
    )
  }
}

/** The sidecar of a bundle: `<sha>.json` next to `<sha>.bundle`. */
const metaPath = (bundlePath: string): string => bundlePath.replace(/\.bundle$/, '.json')

/** Written atomically: a temporary name, then rename. */
async function writeMeta(
  bundlePath: string,
  meta: z.infer<typeof bundleMetaSchema>,
): Promise<void> {
  const path = metaPath(bundlePath)
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await sharedFile(temporary, JSON.stringify(meta))
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** The inode, size and first bytes of a file, from one open handle. */
async function headerOf(path: string): Promise<{ ino: number; size: number; header: Buffer }> {
  const handle = await open(path, 'r')
  try {
    const { ino, size } = await handle.stat()
    const header = Buffer.alloc(Math.min(size, BUNDLE_HEADER_BYTES))
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0)
    return { ino, size, header: header.subarray(0, bytesRead) }
  } finally {
    await handle.close()
  }
}
