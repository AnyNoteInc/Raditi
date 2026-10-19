import type { SFTPWrapper, Stats } from 'ssh2'
import ssh2 from 'ssh2'

import {
  HostingGuardError,
  isSiteConnectionError,
  siteImportLimits,
  SiteConnectionError,
  sshAccessSchema,
  type ConnectionContext,
  type HostingEntry,
  type HostingPath,
  type HostingSession,
  type HostingWriteOptions,
  type HostingWriter,
  type SshAccess,
} from '@repo/domain'

import { ignoreRejection, withinIdle } from './abort.ts'
import { ancestorsOf, hostingFullPath, temporaryFor } from './paths.ts'
import { connectSftp } from './ssh.ts'

// A release writes to a hosting over SFTP (owner's decision of 17.10.2026: SSH access means SFTP,
// never a shell). The host key is the pinned one of the access; every path is the root folder
// plus checked segments, and each folder on the way is checked with LSTAT, which does not follow
// a link. A file is written under a temporary name in its folder and renamed into place:
// `posix-rename@openssh.com` replaces an existing file in one step; an addition uses the plain
// RENAME of the protocol, which OpenSSH's server refuses over an existing file. A session checks
// each folder once: a folder it found by LSTAT or made itself is not asked about again, so a
// release of thousands of files in a few folders costs one LSTAT per folder, not per file.

const STATUS = ssh2.utils.sftp.STATUS_CODE
const OPEN_MODE = ssh2.utils.sftp.OPEN_MODE
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

/** One WRITE or READ carries this much: under the 34 000-byte packet of a server that is not OpenSSH. */
const CHUNK = 32 * 1024
/** Requests in flight per file. */
const WINDOW = 8

export interface SftpWriterOptions {
  /** A request without an answer for this long fails `transfer_failed`. */
  idleMs?: number
  /** The login, the host key and the subsystem. */
  readyTimeoutMs?: number
}

function entryType(mode: number | undefined): HostingEntry['type'] {
  if (typeof mode !== 'number' || !Number.isFinite(mode)) return 'other'
  switch (mode & S_IFMT) {
    case S_IFREG:
      return 'file'
    case S_IFDIR:
      return 'directory'
    case S_IFLNK:
      return 'link'
    default:
      return 'other'
  }
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const { code } = error as { code: unknown }
  return typeof code === 'number' ? code : undefined
}

/** The reason of a failed SFTP request: by its status code, never by its text. */
function sftpFailure(error: unknown): Error {
  if (isSiteConnectionError(error) || error instanceof HostingGuardError) return error
  switch (statusCode(error)) {
    case STATUS.NO_SUCH_FILE:
      return new SiteConnectionError('not_found')
    case STATUS.PERMISSION_DENIED:
      return new SiteConnectionError('access_denied')
    case STATUS.OP_UNSUPPORTED:
      return new SiteConnectionError('unsupported')
    default:
      return new SiteConnectionError('transfer_failed')
  }
}

type Callback<T> = (error: Error | null | undefined, value: T) => void

class SftpHostingSession implements HostingSession {
  readonly #sftp: SFTPWrapper
  readonly #root: string
  readonly #idleMs: number
  readonly #signal: AbortSignal
  readonly #close: () => void
  readonly #posixRename: boolean
  /** After close() no request is sent: a closed channel would never answer it. */
  #closed = false
  /** Full paths this session found to be folders (LSTAT, never through a link) or made. */
  readonly #folders = new Set<string>()

  constructor(
    sftp: SFTPWrapper,
    root: string,
    options: { idleMs: number; signal: AbortSignal; close: () => void },
  ) {
    this.#sftp = sftp
    this.#root = root
    this.#idleMs = options.idleMs
    this.#signal = options.signal
    this.#close = options.close
    // The extensions the server announced in its VERSION packet.
    const extensions = (sftp as unknown as { _extensions?: Record<string, string> })._extensions
    this.#posixRename = extensions?.['posix-rename@openssh.com'] === '1'
  }

  async #request<T>(call: (callback: Callback<T>) => void): Promise<T> {
    if (this.#closed) throw new SiteConnectionError('transfer_failed')
    const work = new Promise<T>((resolve, reject) => {
      try {
        call((error, value) => (error ? reject(error) : resolve(value)))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('SFTP request failed'))
      }
    })
    try {
      return await withinIdle(work, this.#idleMs, this.#signal)
    } catch (error) {
      throw sftpFailure(error)
    }
  }

  async #lstat(full: string): Promise<HostingEntry | null> {
    try {
      const stats = await this.#request<Stats>((callback) => this.#sftp.lstat(full, callback))
      return {
        type: entryType(stats.mode),
        size: typeof stats.size === 'number' && Number.isFinite(stats.size) ? stats.size : 0,
        mode: typeof stats.mode === 'number' ? stats.mode & 0o7777 : null,
      }
    } catch (error) {
      if (isSiteConnectionError(error) && error.reason === 'not_found') return null
      throw error
    }
  }

  /**
   * Each folder on the way must be a folder, not a link. `missing: 'null'` — a stat of a path
   * whose folder does not exist answers null; `'throw'` — `not_found`.
   */
  async #walk(path: HostingPath, missing: 'null' | 'throw'): Promise<boolean> {
    for (const ancestor of ancestorsOf(path)) {
      const full = hostingFullPath(this.#root, ancestor)
      if (this.#folders.has(full)) continue
      const entry = await this.#lstat(full)
      if (entry === null) {
        if (missing === 'null') return false
        throw new SiteConnectionError('not_found')
      }
      if (entry.type !== 'directory') throw new HostingGuardError('not_a_directory')
      this.#folders.add(full)
    }
    return true
  }

  /** A temporary of the same key left by a broken connection: removed before it is made again. */
  async #clearTemporary(temporary: string): Promise<void> {
    const left = await this.#lstat(temporary)
    if (left === null) return
    if (left.type !== 'file') throw new HostingGuardError('not_a_file')
    await this.#request<void>((callback) =>
      this.#sftp.unlink(temporary, (error) => callback(error, undefined)),
    )
  }

  async stat(path: HostingPath): Promise<HostingEntry | null> {
    if (!(await this.#walk(path, 'null'))) return null
    return this.#lstat(hostingFullPath(this.#root, path))
  }

  async read(path: HostingPath, maxBytes: number): Promise<Uint8Array> {
    await this.#walk(path, 'throw')
    const full = hostingFullPath(this.#root, path)
    const entry = await this.#lstat(full)
    if (entry === null) throw new SiteConnectionError('not_found')
    if (entry.type !== 'file') throw new HostingGuardError('not_a_file')
    if (entry.size > maxBytes) throw new HostingGuardError('bytes')
    const handle = await this.#request<Buffer>((callback) => this.#sftp.open(full, 'r', callback))
    const chunks: Buffer[] = []
    let total = 0
    try {
      // One more byte than allowed proves the file grew past the limit since its LSTAT.
      for (let offset = 0; offset <= maxBytes;) {
        const length = Math.min(CHUNK, maxBytes + 1 - offset)
        const buffer = Buffer.allocUnsafe(length)
        // ssh2 answers the EOF status of the protocol as zero bytes read.
        const read = await this.#request<number>((callback) =>
          this.#sftp.read(handle, buffer, 0, length, offset, (error, bytes) =>
            callback(error, bytes),
          ),
        )
        if (read === 0) break
        chunks.push(buffer.subarray(0, read))
        total += read
        offset += read
        if (total > maxBytes) throw new HostingGuardError('bytes')
      }
    } finally {
      this.#closeHandle(handle)
    }
    return Buffer.concat(chunks, total)
  }

  #closeHandle(handle: Buffer): void {
    try {
      this.#sftp.close(handle, () => {})
    } catch {
      // The channel is gone.
    }
  }

  async #writeAll(handle: Buffer, bytes: Uint8Array): Promise<void> {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const inFlight = new Set<Promise<void>>()
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      const length = Math.min(CHUNK, data.length - offset)
      const at = offset
      const write = this.#request<void>((callback) =>
        this.#sftp.write(handle, data, at, length, at, (error) => callback(error, undefined)),
      )
      ignoreRejection(write)
      inFlight.add(write)
      void write.finally(() => inFlight.delete(write)).catch(() => {})
      if (inFlight.size >= WINDOW) await Promise.race(inFlight)
    }
    await Promise.all(inFlight)
  }

  async writeAtomic(
    path: HostingPath,
    bytes: Uint8Array,
    options: HostingWriteOptions,
  ): Promise<void> {
    await this.#walk(path, 'throw')
    const full = hostingFullPath(this.#root, path)
    const existing = await this.#lstat(full)
    if (existing !== null) {
      if (existing.type !== 'file') throw new HostingGuardError('not_a_file')
      if (!options.replace) throw new HostingGuardError('exists')
    }
    const temporary = hostingFullPath(this.#root, [...path.slice(0, -1), temporaryFor(options)])
    if (options.temporaryKey !== undefined) await this.#clearTemporary(temporary)
    const flags = OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.EXCL
    const handle = await this.#request<Buffer>((callback) =>
      this.#sftp.open(temporary, flags, { mode: options.mode }, callback),
    )
    let placed = false
    try {
      try {
        await this.#writeAll(handle, bytes)
      } finally {
        await this.#request<void>((callback) =>
          this.#sftp.close(handle, (error) => callback(error, undefined)),
        )
      }
      // A umask of the server may have narrowed the mode of OPEN.
      await this.#request<void>((callback) =>
        this.#sftp.setstat(temporary, { mode: options.mode }, (error) =>
          callback(error, undefined),
        ),
      )
      if (options.replace && this.#posixRename) {
        await this.#request<void>((callback) =>
          this.#sftp.ext_openssh_rename(temporary, full, (error) => callback(error, undefined)),
        )
      } else {
        if (options.replace && existing !== null) {
          // No atomic replace on this server: the file is absent for one request.
          await this.#request<void>((callback) =>
            this.#sftp.unlink(full, (error) => callback(error, undefined)),
          )
        }
        try {
          await this.#request<void>((callback) =>
            this.#sftp.rename(temporary, full, (error) => callback(error, undefined)),
          )
        } catch (error) {
          // RENAME over a file that appeared meanwhile: an addition never overwrites.
          if (!options.replace && (await this.#lstat(full)) !== null)
            throw new HostingGuardError('exists')
          throw error
        }
      }
      placed = true
    } finally {
      if (!placed)
        await this.#request<void>((callback) =>
          this.#sftp.unlink(temporary, (error) => callback(error, undefined)),
        ).catch(() => {})
    }
  }

  async remove(path: HostingPath): Promise<void> {
    if (!(await this.#walk(path, 'null'))) return
    const full = hostingFullPath(this.#root, path)
    const entry = await this.#lstat(full)
    if (entry === null) return
    if (entry.type !== 'file') throw new HostingGuardError('not_a_file')
    await this.#request<void>((callback) =>
      this.#sftp.unlink(full, (error) => callback(error, undefined)),
    )
  }

  async mkdirp(path: HostingPath): Promise<void> {
    for (const prefix of [...ancestorsOf(path), path]) {
      const full = hostingFullPath(this.#root, prefix)
      if (this.#folders.has(full)) continue
      const entry = await this.#lstat(full)
      if (entry !== null && entry.type !== 'directory')
        throw new HostingGuardError('not_a_directory')
      if (entry === null) {
        try {
          await this.#request<void>((callback) =>
            this.#sftp.mkdir(full, { mode: 0o755 }, (error) => callback(error, undefined)),
          )
        } catch (error) {
          // Made meanwhile by someone else: fine when it is a folder.
          if ((await this.#lstat(full))?.type !== 'directory') throw error
        }
      }
      this.#folders.add(full)
    }
  }

  async removeEmptyDirectory(path: HostingPath): Promise<void> {
    if (!(await this.#walk(path, 'null'))) return
    const full = hostingFullPath(this.#root, path)
    const entry = await this.#lstat(full)
    if (entry === null) return
    if (entry.type !== 'directory') throw new HostingGuardError('not_a_directory')
    // RMDIR never removes a folder with anything in it; OpenSSH answers that with a plain FAILURE.
    this.#forgetFolders(full)
    try {
      await this.#request<void>((callback) =>
        this.#sftp.rmdir(full, (error) => callback(error, undefined)),
      )
    } catch (error) {
      if (isSiteConnectionError(error) && error.reason === 'not_found') return
      if (isSiteConnectionError(error) && error.reason !== 'transfer_failed') throw error
      const after = await this.#lstat(full)
      if (after === null) return
      if (after.type === 'directory') throw new HostingGuardError('not_empty')
      throw error
    }
  }

  /** A removed folder and everything below it are no longer known folders. */
  #forgetFolders(full: string): void {
    for (const known of this.#folders)
      if (known === full || known.startsWith(`${full}/`)) this.#folders.delete(known)
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#close()
  }
}

/** The SFTP writer with the limits of a test; the exported one keeps the domain's. */
export function createSftpHostingWriter(options: SftpWriterOptions = {}): HostingWriter<SshAccess> {
  const idleMs = options.idleMs ?? siteImportLimits.idleMs
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000
  return {
    method: 'sftp',
    accessSchema: sshAccessSchema,
    endpointOf: (access) => ({ host: access.host, port: Number(access.port) }),
    async open(access: SshAccess, context: ConnectionContext): Promise<HostingSession> {
      const connection = await connectSftp(access, context.address, context.signal, readyTimeoutMs)
      try {
        const root = await withinIdle(
          new Promise<string>((resolve, reject) =>
            connection.sftp.realpath(access.rootPath, (error, path) =>
              error ? reject(error) : resolve(path),
            ),
          ),
          idleMs,
          context.signal,
        ).catch((error: unknown) => {
          throw sftpFailure(error)
        })
        const stats = await withinIdle(
          new Promise<Stats>((resolve, reject) =>
            connection.sftp.lstat(root, (error, value) => (error ? reject(error) : resolve(value))),
          ),
          idleMs,
          context.signal,
        ).catch((error: unknown) => {
          throw sftpFailure(error)
        })
        if (entryType(stats.mode) !== 'directory') throw new SiteConnectionError('not_found')
        return new SftpHostingSession(connection.sftp, root, {
          idleMs,
          signal: context.signal,
          close: connection.close,
        })
      } catch (error) {
        connection.close()
        throw error
      }
    },
  }
}

export const sftpHostingWriter: HostingWriter<SshAccess> = createSftpHostingWriter()
