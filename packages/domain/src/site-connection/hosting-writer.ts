import type { z } from 'zod'

import type { ConnectionContext } from './ports.ts'

// The port of a release's writes to a hosting (docs/plan/53-chat-preview-release.md, Р30, Р31):
// the deploy job reads, writes, renames and removes files of the site root over SFTP or FTP(S).
// Implementations live in @repo/site-connections/hosting; the `deploy-step` command indexes them
// by the release's method and never compares one.

/**
 * A path below the root folder of the access, one segment per element. A segment is never empty,
 * never `.` or `..`, and holds neither `/`, `\` nor a control character: an adapter refuses such a
 * path before it sends anything (`hostingPathProblem`).
 */
export type HostingPath = readonly string[]

export interface HostingEntry {
  /** A link is reported as one and never followed. */
  type: 'file' | 'directory' | 'link' | 'other'
  size: number
  /** Permission bits (`0o7777`), where the server tells them; null where it does not (FTP). */
  mode: number | null
}

/** A guard of a hosting session tripped: the release stops and writes nothing more there. */
export class HostingGuardError extends Error {
  readonly guard:
    | 'path'
    /** The file is longer than the caller allowed. */
    | 'bytes'
    /** An ancestor of the path is a link or a file, or the path is a link or a directory. */
    | 'not_a_file'
    | 'not_a_directory'
    /** An addition found the path taken. */
    | 'exists'
    /** `removeEmptyDirectory` found something in the folder. */
    | 'not_empty'

  constructor(guard: HostingGuardError['guard']) {
    super(`Hosting guard: ${guard}`)
    this.name = 'HostingGuardError'
    this.guard = guard
  }
}

/** By name, not `instanceof`: works across duplicated module instances. */
export function isHostingGuardError(error: unknown): error is HostingGuardError {
  return error instanceof Error && error.name === 'HostingGuardError'
}

const SEGMENT_MAX = 255
const PATH_MAX_SEGMENTS = 64

/** null when the path is acceptable, else what is wrong with it (for tests and messages). */
export function hostingPathProblem(path: HostingPath): string | null {
  if (!Array.isArray(path) || path.length === 0) return 'empty'
  if (path.length > PATH_MAX_SEGMENTS) return 'too deep'
  for (const segment of path) {
    if (typeof segment !== 'string' || segment === '' || segment.length > SEGMENT_MAX)
      return 'segment length'
    if (segment === '.' || segment === '..') return 'dot segment'
    for (let index = 0; index < segment.length; index += 1) {
      const code = segment.charCodeAt(index)
      if (code < 0x20 || code === 0x7f || code === 0x2f || code === 0x5c) return 'character'
    }
  }
  return null
}

/** The segments of a relative publication path (`wp-content/themes/a.css`). */
export const hostingPathOf = (relative: string): HostingPath => relative.split('/')

export interface HostingWriteOptions {
  /**
   * true — the path may exist and is replaced in one rename; false — an addition: the path must be
   * absent, and an existing one is never overwritten (`HostingGuardError('exists')`).
   */
  replace: boolean
  /** Permission bits of the new file (`0o644`, `0o755`); an adapter that cannot set them says so. */
  mode: number
  /**
   * 16–64 lowercase hex characters: the temporary name is then `temporaryNameOf(key)`, the same
   * on every connection — so a temporary left behind by a broken connection is found and removed
   * by a later session (the rollback of a release). Absent — a random name.
   */
  temporaryKey?: string
}

/** The temporary file of an atomic write: a dot file in the folder of its target. */
export function temporaryNameOf(key: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(key)) throw new HostingGuardError('path')
  return `.raditi-${key}.tmp`
}

/**
 * One connection to the root folder of a site. Every call checks each ancestor of its path with
 * a request that does not follow links: a link or a file on the way trips
 * `HostingGuardError('not_a_directory')`, so a write never leaves the root through a link.
 * A broken transfer, a refused command or a timeout → `SiteConnectionError('transfer_failed')`.
 */
export interface HostingSession {
  /** null — no such path. */
  stat(path: HostingPath): Promise<HostingEntry | null>
  /**
   * The whole file. Longer than `maxBytes` → `HostingGuardError('bytes')`; absent →
   * `SiteConnectionError('not_found')`; a link or a directory → `HostingGuardError('not_a_file')`.
   */
  read(path: HostingPath, maxBytes: number): Promise<Uint8Array>
  /**
   * Writes the bytes under a temporary name in the same folder, then renames it to `path`: the
   * site never serves half a file. The folder must exist (`mkdirp`). A temporary file left by a
   * failed call is removed before the call rejects, where the server still answers.
   */
  writeAtomic(path: HostingPath, bytes: Uint8Array, options: HostingWriteOptions): Promise<void>
  /** Removes a file; an absent one is not an error. A link or a directory is never removed. */
  remove(path: HostingPath): Promise<void>
  /** Creates every missing folder of `path` (the path itself included). */
  mkdirp(path: HostingPath): Promise<void>
  /**
   * Removes a folder that holds nothing; an absent one is not an error. A folder with anything in
   * it → `HostingGuardError('not_empty')`; a link or a file → `HostingGuardError('not_a_directory')`.
   */
  removeEmptyDirectory(path: HostingPath): Promise<void>
  close(): Promise<void>
}

/** A way a release writes to a hosting: `environments.deploy_method` `sftp` or `ftp`. */
export interface HostingWriter<Access = unknown> {
  readonly method: 'sftp' | 'ftp'
  readonly accessSchema: z.ZodType<Access>
  /** Host and port the session connects to: the caller pins the address first. */
  endpointOf(access: Access): { host: string; port: number }
  /** Connects by the secret alone: its host key or TLS mode, its user and its root folder. */
  open(access: Access, context: ConnectionContext): Promise<HostingSession>
}
