import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { badRequest, type RepoRef } from '@repo/domain'

// The cache of core's trusted git (docs/plan/53-chat-preview-release.md, Р10): one bare mirror
// per site repository, refreshed by fetch, instead of two network clones per turn, and the base
// bundles of turns by the commit they carry. Both are caches: removing the directory loses time,
// never data. Core is one process (spec §8), so a lock in memory serialises each mirror.

/** `<tmpdir>/raditi-mirrors`: not `raditi-git-*`, so the sweep of stale clones keeps it. */
export const defaultMirrorDir = (): string => join(tmpdir(), 'raditi-mirrors')

/**
 * The root of the mirrors is this process's own directory, closed to everyone else: trusted git
 * reads the mirrors' objects and runs fetch with a mirror as its repository, so another local
 * user must not be able to plant one there (a shared `/tmp` of a Linux host). Made when absent;
 * one of ours with a wider mode is closed; a link, or a directory of another user, is refused.
 */
export function assertPrivateDirectory(path: string): void {
  const refused = () => badRequest('Repository mirror directory must be a private directory')
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  } catch {
    throw refused()
  }
  const info = lstatSync(path)
  const uid = process.getuid?.()
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) throw refused()
  if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700)
}

/**
 * The directory of one repository's mirror. The clone URL is part of the key: a repository
 * recreated elsewhere under the same name, or a test fixture, never shares objects by name.
 */
export function mirrorPath(root: string, repo: RepoRef, url: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify([repo.provider, repo.owner, repo.name, url]))
    .digest('hex')
    .slice(0, 40)
  return join(root, 'repos', `${key}.git`)
}

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
/** Bundles kept: a turn and its retries, recovery and the turns of other sites meanwhile. */
const BUNDLES_KEPT = 32

/**
 * Base bundles by the commit their single ref points at. A bundle holds exactly the objects that
 * commit reaches, so the commit names its content; the reader still checks the ref it carries.
 * Writes are atomic (a temporary name, then rename) and the oldest files beyond the limit go.
 */
export class BundleCache {
  readonly #dir: string

  constructor(root: string) {
    this.#dir = join(root, 'bundles')
  }

  async get(sha: string): Promise<Buffer | null> {
    if (!SHA.test(sha)) return null
    const path = join(this.#dir, `${sha}.bundle`)
    try {
      const bytes = await readFile(path)
      const now = new Date()
      await utimes(path, now, now).catch(() => {})
      return bytes
    } catch {
      return null
    }
  }

  async put(sha: string, bytes: Uint8Array): Promise<void> {
    if (!SHA.test(sha)) return
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      const temporary = join(this.#dir, `.${sha}.${randomBytes(6).toString('hex')}.tmp`)
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(this.#dir, `${sha}.bundle`))
      await this.#evict()
    } catch {
      // A cache: a write that fails costs the next turn a rebuild, nothing else.
    }
  }

  async #evict(): Promise<void> {
    const names = (await readdir(this.#dir)).filter((name) => /^[a-f0-9]{40}\.bundle$/.test(name))
    if (names.length <= BUNDLES_KEPT) return
    const aged = await Promise.all(
      names.map(async (name) => ({
        name,
        at: (await stat(join(this.#dir, name)).catch(() => null))?.mtimeMs ?? 0,
      })),
    )
    aged.sort((a, b) => a.at - b.at)
    await Promise.all(
      aged
        .slice(0, aged.length - BUNDLES_KEPT)
        .map(({ name }) => rm(join(this.#dir, name), { force: true })),
    )
  }
}
