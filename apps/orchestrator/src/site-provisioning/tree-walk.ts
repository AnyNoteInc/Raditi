import { Buffer } from 'node:buffer'
import { open, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import {
  FileSourceGuardError,
  isFileSourceGuardError,
  isImportSegment,
  isNestedSiteRoot,
  isSiteConnectionError,
  siteImportLimits,
  type FileSourceEntry,
  type FileSourceSession,
  type ImportPathPolicy,
  type ImportSkipReason,
} from '@repo/domain'

import type { ExactValues } from './exact-values.ts'
import { refuse, sessionFailure } from './import-failure.ts'

/**
 * A folder or a file the server listed and then refused to open, or no longer has: left out and
 * counted as `unreadable`, never a reason to fail the import.
 */
const isUnreadable = (error: unknown): boolean =>
  isSiteConnectionError(error) && (error.reason === 'access_denied' || error.reason === 'not_found')

/** A file the import takes: where it goes in the repository and where its copy lies on the host. */
export interface TakenFile {
  /** Repository path: the decoded names of its segments joined with `/`. */
  path: string
  /** `<blobs>/<n>`: numbered by the host, never named after a path of the client. */
  blob: string
  bytes: number
}

export type SkipCounts = Partial<Record<ImportSkipReason, number>>

export interface WalkResult {
  files: TakenFile[]
  bytes: number
  skipped: SkipCounts
}

export type WalkLimits = Record<
  'files' | 'fileBytes' | 'treeBytes' | 'depth' | 'listedEntries' | 'directories',
  number
>

export interface WalkInput {
  session: FileSourceSession
  policy: ImportPathPolicy
  /** SiteAdapter.rootMarkers of the stack: a folder below the root with all of them is not entered. */
  markers: readonly string[]
  /** A private directory (0700) for the copies. */
  blobs: string
  values: ExactValues
  signal: AbortSignal
  /** Work for the stall rule: every downloaded byte, and 64 for every listed entry. */
  onWork?: (work: number) => void
  limits?: Partial<WalkLimits>
}

/** Work an entry of a listing counts for the stall rule. */
export const LISTED_ENTRY_WORK = 64

interface Directory {
  /** As the server understands the segments (FileSourceEntry.ref). */
  refs: string[]
  /** As the repository will have them (FileSourceEntry.name). */
  names: string[]
}

interface Download {
  refs: string[]
  path: string
  /** As listed: the most the server may send. */
  size: number
}

/** At most `limit` at once; after the first failure no new item starts, and every started one is awaited. */
async function inPool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0
  let failed = false
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!
      try {
        await run(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  const results = await Promise.allSettled(workers)
  const rejected = results.find((result) => result.status === 'rejected')
  if (rejected) throw rejected.reason
}

/** A handle writes what it was given, however the kernel splits it. */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten <= 0) throw refuse('internal')
    offset += bytesWritten
  }
}

/**
 * Walks the site folder of an open file session and downloads what the import takes
 * (docs/plan/39-site-connection-wizard.md, «Импорт»). Directories are listed one at a time and
 * the files of one directory are read `session.concurrency` at a time. Every name passes
 * `isImportSegment`, every path the import policy of the stack (rule 6 among it); links and
 * other entries are counted, never followed; a folder below the root that is another
 * installation is not entered. A folder or a file the server refuses to open, or that is gone
 * since its listing, is left out and counted as `unreadable`. A file over `fileBytes` is left out
 * and counted, more files or bytes than the limits allow fail the import, and a server that sends
 * more than it listed fails it as inconsistent. A downloaded file with an exact secret of the
 * site is dropped.
 */
export async function walkSiteTree(input: WalkInput): Promise<WalkResult> {
  const { session, policy, markers, blobs, values, signal } = input
  const limits: WalkLimits = { ...siteImportLimits, ...input.limits }
  const work = input.onWork ?? (() => {})
  const concurrency = Number.isSafeInteger(session.concurrency)
    ? Math.min(Math.max(session.concurrency, 1), 16)
    : 1
  const skipped: SkipCounts = {}
  const skip = (reason: ImportSkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }
  const files: TakenFile[] = []
  const seen = new Set<string>()
  let listed = 0
  let directories = 0
  /** Listed sizes of the files taken so far: the tree limit holds before a byte is read. */
  let reserved = 0
  let bytes = 0
  let blobIndex = 0

  async function download(item: Download): Promise<void> {
    signal.throwIfAborted()
    const blob = join(blobs, String(blobIndex++))
    const handle = await open(blob, 'wx', 0o600)
    const search = values.file()
    let written = 0
    let kept = false
    let unreadable = false
    try {
      const count = await session.read(
        item.refs,
        async (chunk) => {
          written += chunk.byteLength
          // The adapter holds the same bound; a copy on the host never outgrows the listing.
          if (written > item.size) throw new FileSourceGuardError('bytes')
          search.feed(chunk)
          await writeAll(handle, chunk)
          work(chunk.byteLength)
        },
        item.size,
      )
      if (count !== written) throw refuse('source_inconsistent')
      kept = search.found.size === 0
      if (!kept) {
        values.record(search.found)
        skip('secret')
      }
    } catch (error) {
      // Nothing of it is kept: what was written of it goes with the copy below.
      if (!isUnreadable(error)) throw sessionFailure(error)
      unreadable = true
    } finally {
      await handle.close()
      if (!kept) await rm(blob, { force: true })
    }
    if (unreadable) skip('unreadable')
    if (!kept) return
    files.push({ path: item.path, blob, bytes: written })
    bytes += written
  }

  const pending: Directory[] = [{ refs: [], names: [] }]
  while (pending.length > 0) {
    signal.throwIfAborted()
    const directory = pending.pop()!
    directories += 1
    if (directories > limits.directories) throw refuse('source_too_large')
    const room = limits.listedEntries - listed
    let entries: FileSourceEntry[]
    try {
      entries = await session.list(directory.refs, room)
    } catch (error) {
      // The server entered somewhere else than the listed folder: a link shown as a folder.
      if (isFileSourceGuardError(error) && error.guard === 'outside_root') {
        skip('link')
        continue
      }
      // Only below the root: a root the server will not show is the access, not one folder.
      if (directory.names.length > 0 && isUnreadable(error)) {
        skip('unreadable')
        continue
      }
      throw sessionFailure(error)
    }
    if (!Array.isArray(entries) || entries.length > room) throw refuse('source_too_large')
    listed += entries.length
    work(entries.length * LISTED_ENTRY_WORK)
    if (
      directory.names.length > 0 &&
      isNestedSiteRoot(
        entries.map((entry) => entry.name),
        markers,
      )
    ) {
      skip('nested_site')
      continue
    }

    const downloads: Download[] = []
    for (const entry of entries) {
      if (typeof entry.name !== 'string' || !isImportSegment(entry.name)) {
        skip('unsupported_path')
        continue
      }
      const names = [...directory.names, entry.name]
      const path = names.join('/')
      // A listing that names one entry twice (or two raw names that decode alike): the first wins.
      if (seen.has(path)) {
        skip('unsupported_path')
        continue
      }
      const kind = entry.type === 'directory' ? 'directory' : 'file'
      const decision = policy.decide(path, kind)
      if (decision !== 'take') {
        skip(decision)
        continue
      }
      if (entry.type === 'link') {
        skip('link')
        continue
      }
      if (entry.type !== 'file' && entry.type !== 'directory') {
        skip('unsupported_path')
        continue
      }
      seen.add(path)
      const refs = [...directory.refs, entry.ref]
      if (entry.type === 'directory') {
        // Its files would have more segments than a repository path may.
        if (names.length >= limits.depth) skip('unsupported_path')
        else pending.push({ refs, names })
        continue
      }
      const size = entry.size
      if (!Number.isSafeInteger(size) || size < 0) throw refuse('source_inconsistent')
      if (size > limits.fileBytes) {
        skip('too_large')
        continue
      }
      reserved += size
      if (files.length + downloads.length + 1 > limits.files || reserved > limits.treeBytes)
        throw refuse('source_too_large')
      downloads.push({ refs, path, size })
    }
    await inPool(downloads, concurrency, download)
  }
  return { files, bytes, skipped }
}

/**
 * A file of the site root for SiteAdapter.configSecrets: `path` is relative ASCII with `/`, read
 * through the session within `configFileBytes`. Absent or larger — null; a broken transfer fails.
 */
export async function readRootFile(
  session: FileSourceSession,
  path: string,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  signal.throwIfAborted()
  const segments = path.split('/')
  // The adapter of the stack names the file; it still never leaves the root.
  if (segments.some((segment) => !isImportSegment(segment))) return null
  const chunks: Buffer[] = []
  try {
    await session.read(
      segments,
      async (chunk) => {
        chunks.push(Buffer.from(chunk))
      },
      siteImportLimits.configFileBytes,
    )
  } catch (error) {
    if (isFileSourceGuardError(error) && error.guard === 'bytes') return null
    if (isSiteConnectionError(error) && error.reason === 'not_found') return null
    throw sessionFailure(error)
  }
  return Buffer.concat(chunks)
}
