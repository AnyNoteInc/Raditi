import type { Socket } from 'node:net'
import { Readable, Writable } from 'node:stream'
import { connect as tlsConnect, TLSSocket } from 'node:tls'

import {
  Client,
  FileType,
  FTPError,
  type FileInfo,
  type FTPContext,
  type FTPResponse,
} from 'basic-ftp'

import {
  ftpAccessSchema,
  HostingGuardError,
  isSiteConnectionError,
  siteImportLimits,
  SiteConnectionError,
  tlsIdentity,
  type ConnectionCheckReason,
  type ConnectionContext,
  type FtpAccess,
  type HostingEntry,
  type HostingPath,
  type HostingSession,
  type HostingWriteOptions,
  type HostingWriter,
  type PinnedAddress,
} from '@repo/domain'

import { whenAborted, withinIdle } from './abort.ts'
import { ancestorsOf, hostingFullPath, temporaryFor } from './paths.ts'

// A release writes to a hosting over FTP with explicit TLS (AUTH TLS), or without encryption by
// the client's explicit choice — the mode of the access, never another. Data connections are
// passive only and always go to the pinned address of the control connection: the address of a
// PASV reply is never dialled. Names travel as the raw bytes of their UTF-8 (latin1 on the control
// connection). Whether a path exists, and whether it is a folder, a file or a link, is read from
// the listing of its folder; a link is never entered or written through. A file is uploaded under
// a temporary name in its folder and renamed into place (RNFR/RNTO: rename(2) on the usual POSIX
// servers — one step, replacing a file). A server that refuses RNTO over an existing file (ProFTPD
// with `AllowOverwrite off`) gets DELE and RNTO: the file is absent for one command. An addition
// checks the name is free right before the rename: FTP has no rename that refuses an existing
// target, so this check is the narrow window. One control connection carries one command at a
// time: the calls of a session wait for each other. Permission bits come from the listing (LIST
// or MLSD `unix.mode`) where the server gives them.

export interface FtpWriterOptions {
  /** A command or a transfer without progress for this long fails `transfer_failed`. */
  idleMs?: number
  /** The login with its TLS handshake. */
  loginTimeoutMs?: number
  /** Tests only: the PEM of a CA that `verified` trusts in place of the default store. */
  trustedCa?: string
}

/** A text (UTF-8) as the latin1 string of its bytes: what the control connection writes. */
export const rawFromTyped = (text: string): string => Buffer.from(text, 'utf8').toString('latin1')

/** Only the port of an EPSV reply exists: the host is always the control connection's. */
export function epsvPort(message: string): number | null {
  const match = /[|!]{3}(\d{1,5})[|!]/.exec(message)
  const port = match ? Number(match[1]) : NaN
  return port >= 1 && port <= 65_535 ? port : null
}

/** The port of a PASV reply; its four address numbers are read past and never used. */
export function pasvPort(message: string): number | null {
  const match = /\d{1,3},\d{1,3},\d{1,3},\d{1,3},(\d{1,3}),(\d{1,3})/.exec(message)
  if (!match) return null
  const high = Number(match[1])
  const low = Number(match[2])
  const port = high * 256 + low
  return high <= 255 && low <= 255 && port >= 1 ? port : null
}

/**
 * A data connection to the pinned literal and the port the server named. Over TLS it resumes the
 * session of the control connection (vsftpd `require_ssl_reuse` refuses a fresh one).
 */
function openDataConnection(ftp: FTPContext, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const raw: Socket = ftp._newSocket()
    let settled = false
    const failed = (error: Error) => {
      if (settled) return
      settled = true
      raw.destroy()
      reject(error)
    }
    raw.setTimeout(ftp.timeout)
    raw.once('error', failed)
    raw.once('timeout', () => failed(new Error('Data connection timed out')))
    raw.connect({ host, port }, () => {
      if (settled) return
      settled = true
      let socket: Socket | TLSSocket = raw
      if (ftp.socket instanceof TLSSocket) {
        const secure = tlsConnect({
          ...ftp.tlsOptions,
          socket: raw,
          session: ftp.tlsSessionStore ?? ftp.socket.getSession(),
        })
        secure.on('session', (session: Buffer) => {
          ftp.tlsSessionStore = session
        })
        socket = secure
      }
      raw.setTimeout(0)
      ftp.dataSocket = socket
      resolve()
    })
  })
}

/** EPSV first; a server that refuses it gets PASV from then on. Either way only the port is taken. */
function passiveToPinned(literal: string): (ftp: FTPContext) => Promise<FTPResponse> {
  let extended = true
  return async (ftp) => {
    let response: FTPResponse | null = null
    let port: number | null = null
    if (extended) {
      try {
        response = await ftp.request('EPSV')
        port = epsvPort(response.message)
      } catch (error) {
        if (!(error instanceof FTPError)) throw error
      }
      if (port === null) extended = false
    }
    if (port === null) {
      response = await ftp.request('PASV')
      port = pasvPort(response.message)
    }
    if (port === null || response === null) throw new Error('Unreadable passive reply')
    await openDataConnection(ftp, literal, port)
    return response
  }
}

function tlsOptions(access: FtpAccess, address: PinnedAddress, trustedCa: string | undefined) {
  if (access.tls === 'plain') return null
  const verified = access.tls === 'verified'
  return {
    ...tlsIdentity(address),
    rejectUnauthorized: verified,
    ...(verified && trustedCa ? { ca: trustedCa } : {}),
  }
}

function failure(error: unknown, refused: ConnectionCheckReason): Error {
  if (isSiteConnectionError(error) || error instanceof HostingGuardError) return error
  if (error instanceof FTPError) {
    if (error.code === 550) return new SiteConnectionError('not_found')
    if (error.code === 530) return new SiteConnectionError('auth_failed')
    return new SiteConnectionError(refused)
  }
  // A listing past `maxListingBytes` and every broken socket: the transfer failed.
  return new SiteConnectionError('transfer_failed')
}

/** The permission bits a listing gave, or null: `rwx` of the owner, the group and the others. */
export function modeOf(info: Pick<FileInfo, 'permissions'>): number | null {
  const bits = info.permissions
  if (!bits) return null
  const part = (value: number) => (Number.isInteger(value) && value >= 0 && value <= 7 ? value : 0)
  return (part(bits.user) << 6) | (part(bits.group) << 3) | part(bits.world)
}

function entryOf(info: FileInfo): HostingEntry {
  const type =
    info.type === FileType.File
      ? 'file'
      : info.type === FileType.Directory
        ? 'directory'
        : info.type === FileType.SymbolicLink
          ? 'link'
          : 'other'
  return {
    type,
    size: Number.isFinite(info.size) && info.size >= 0 ? info.size : 0,
    mode: type === 'file' ? modeOf(info) : null,
  }
}

class FtpHostingSession implements HostingSession {
  readonly #client: Client
  /** The root as PWD reported it after CWD: raw bytes as latin1. */
  readonly #root: string
  readonly #idleMs: number
  readonly #signal: AbortSignal
  readonly #stop: () => void
  /** Listings of folders this session read, by their full raw path; a write drops its folder's. */
  readonly #listings = new Map<string, Map<string, HostingEntry>>()
  /** The last call of the session: the next one starts when it has settled. */
  #tail: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(
    client: Client,
    root: string,
    options: { idleMs: number; signal: AbortSignal; stop: () => void },
  ) {
    this.#client = client
    this.#root = root
    this.#idleMs = options.idleMs
    this.#signal = options.signal
    this.#stop = options.stop
  }

  /** One call at a time on the control connection; after close() a call answers at once. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work)
    this.#tail = run.catch(() => {})
    return run
  }

  async #call<T>(work: () => Promise<T>, refused: ConnectionCheckReason = 'transfer_failed') {
    if (this.#closed) throw new SiteConnectionError('transfer_failed')
    try {
      return await withinIdle(work(), this.#idleMs, this.#signal)
    } catch (error) {
      throw failure(error, refused)
    }
  }

  #raw(path: HostingPath): string {
    return hostingFullPath(this.#root, path.map(rawFromTyped))
  }

  #folder(path: HostingPath): string {
    return path.length <= 1 ? this.#root : this.#raw(path.slice(0, -1))
  }

  async #listing(folder: string): Promise<Map<string, HostingEntry> | null> {
    const cached = this.#listings.get(folder)
    if (cached) return cached
    let list: FileInfo[]
    try {
      list = await this.#call(() => this.#client.list(folder))
    } catch (error) {
      if (isSiteConnectionError(error) && error.reason === 'not_found') return null
      throw error
    }
    const entries = new Map<string, HostingEntry>()
    for (const info of list)
      if (info.name !== '.' && info.name !== '..') entries.set(info.name, entryOf(info))
    this.#listings.set(folder, entries)
    return entries
  }

  #forget(path: HostingPath): void {
    this.#listings.delete(this.#folder(path))
  }

  /** The entry of `path` in its folder's listing; null — absent (or a folder on the way is). */
  async #entry(path: HostingPath): Promise<HostingEntry | null> {
    const listing = await this.#listing(this.#folder(path))
    if (listing === null) return null
    return listing.get(rawFromTyped(path.at(-1) ?? '')) ?? null
  }

  async #walk(path: HostingPath, missing: 'null' | 'throw'): Promise<boolean> {
    for (const ancestor of ancestorsOf(path)) {
      const entry = await this.#entry(ancestor)
      if (entry === null) {
        if (missing === 'null') return false
        throw new SiteConnectionError('not_found')
      }
      if (entry.type !== 'directory') throw new HostingGuardError('not_a_directory')
    }
    return true
  }

  stat(path: HostingPath): Promise<HostingEntry | null> {
    return this.#serial(async () => {
      if (!(await this.#walk(path, 'null'))) return null
      return this.#entry(path)
    })
  }

  read(path: HostingPath, maxBytes: number): Promise<Uint8Array> {
    return this.#serial(() => this.#read(path, maxBytes))
  }

  writeAtomic(path: HostingPath, bytes: Uint8Array, options: HostingWriteOptions): Promise<void> {
    return this.#serial(() => this.#writeAtomic(path, bytes, options))
  }

  remove(path: HostingPath): Promise<void> {
    return this.#serial(() => this.#remove(path))
  }

  mkdirp(path: HostingPath): Promise<void> {
    return this.#serial(() => this.#mkdirp(path))
  }

  removeEmptyDirectory(path: HostingPath): Promise<void> {
    return this.#serial(() => this.#removeEmptyDirectory(path))
  }

  async #read(path: HostingPath, maxBytes: number): Promise<Uint8Array> {
    await this.#walk(path, 'throw')
    const entry = await this.#entry(path)
    if (entry === null) throw new SiteConnectionError('not_found')
    if (entry.type !== 'file') throw new HostingGuardError('not_a_file')
    if (entry.size > maxBytes) throw new HostingGuardError('bytes')
    const chunks: Buffer[] = []
    let total = 0
    let tooLarge = false
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        total += chunk.length
        if (total > maxBytes) {
          tooLarge = true
          done(new Error('too large'))
          return
        }
        chunks.push(chunk)
        done()
      },
    })
    try {
      await this.#call(() => this.#client.downloadTo(sink, this.#raw(path)))
    } catch (error) {
      if (tooLarge) throw new HostingGuardError('bytes')
      throw error
    }
    return Buffer.concat(chunks, total)
  }

  async #writeAtomic(path: HostingPath, bytes: Uint8Array, options: HostingWriteOptions) {
    await this.#walk(path, 'throw')
    const existing = await this.#entry(path)
    if (existing !== null) {
      if (existing.type !== 'file') throw new HostingGuardError('not_a_file')
      if (!options.replace) throw new HostingGuardError('exists')
    }
    const temporaryPath = [...path.slice(0, -1), temporaryFor(options)]
    const temporary = this.#raw(temporaryPath)
    const target = this.#raw(path)
    if (options.temporaryKey !== undefined) {
      // A temporary of the same key left by a broken connection.
      const left = await this.#entry(temporaryPath)
      if (left !== null && left.type !== 'file') throw new HostingGuardError('not_a_file')
      if (left !== null) {
        this.#forget(path)
        await this.#call(() => this.#client.remove(temporary))
      }
    }
    this.#forget(path)
    let placed = false
    try {
      await this.#call(() =>
        this.#client.uploadFrom(Readable.from([Buffer.from(bytes)]), temporary),
      )
      // FTP has no portable way to set a mode: SITE CHMOD where the server has it, else its default.
      await this.#call(() =>
        this.#client.sendIgnoringError(`SITE CHMOD ${options.mode.toString(8)} ${temporary}`),
      )
      if (!options.replace) {
        this.#forget(path)
        if ((await this.#entry(path)) !== null) throw new HostingGuardError('exists')
      }
      try {
        await this.#call(() => this.#client.rename(temporary, target))
      } catch (error) {
        this.#forget(path)
        const now = await this.#entry(path)
        if (!options.replace && now !== null) throw new HostingGuardError('exists')
        // RNTO refused over an existing file: DELE, then RNTO — absent for one command.
        if (!options.replace || now?.type !== 'file') throw error
        await this.#call(() => this.#client.remove(target))
        this.#forget(path)
        await this.#call(() => this.#client.rename(temporary, target))
      }
      placed = true
    } finally {
      this.#forget(path)
      if (!placed) await this.#call(() => this.#client.remove(temporary, true)).catch(() => {})
    }
  }

  async #remove(path: HostingPath): Promise<void> {
    if (!(await this.#walk(path, 'null'))) return
    const entry = await this.#entry(path)
    if (entry === null) return
    if (entry.type !== 'file') throw new HostingGuardError('not_a_file')
    this.#forget(path)
    await this.#call(() => this.#client.remove(this.#raw(path)))
  }

  async #mkdirp(path: HostingPath): Promise<void> {
    for (const prefix of [...ancestorsOf(path), path]) {
      const entry = await this.#entry(prefix)
      if (entry?.type === 'directory') continue
      if (entry !== null) throw new HostingGuardError('not_a_directory')
      this.#forget(prefix)
      try {
        await this.#call(() => this.#client.send(`MKD ${this.#raw(prefix)}`))
      } catch (error) {
        this.#forget(prefix)
        if ((await this.#entry(prefix))?.type !== 'directory') throw error
      }
      this.#forget(prefix)
    }
  }

  async #removeEmptyDirectory(path: HostingPath): Promise<void> {
    if (!(await this.#walk(path, 'null'))) return
    const entry = await this.#entry(path)
    if (entry === null) return
    if (entry.type !== 'directory') throw new HostingGuardError('not_a_directory')
    const full = this.#raw(path)
    this.#listings.delete(full)
    const inside = await this.#listing(full)
    if (inside !== null && inside.size > 0) throw new HostingGuardError('not_empty')
    this.#listings.delete(full)
    this.#forget(path)
    try {
      await this.#call(() => this.#client.send(`RMD ${full}`))
    } catch (error) {
      this.#forget(path)
      const after = await this.#entry(path)
      if (after === null) return
      if (after.type === 'directory') throw new HostingGuardError('not_empty')
      throw error
    }
    for (const known of this.#listings.keys())
      if (known === full || known.startsWith(`${full}/`)) this.#listings.delete(known)
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#stop()
    this.#client.close()
  }
}

/** The FTP writer with the limits of a test; the exported one keeps the domain's. */
export function createFtpHostingWriter(options: FtpWriterOptions = {}): HostingWriter<FtpAccess> {
  const idleMs = options.idleMs ?? siteImportLimits.idleMs
  const loginTimeoutMs = options.loginTimeoutMs ?? 20_000
  return {
    method: 'ftp',
    accessSchema: ftpAccessSchema,
    endpointOf: (access) => ({ host: access.host, port: Number(access.port) }),
    async open(access: FtpAccess, context: ConnectionContext): Promise<HostingSession> {
      const { address, signal } = context
      if (signal.aborted) throw new SiteConnectionError('unreachable')
      // The socket's own idle bound; every step of the login is bounded by loginTimeoutMs as well.
      const client = new Client(idleMs, {
        allowSeparateTransferHost: false,
        maxListingBytes: siteImportLimits.listingBytes,
      })
      client.ftp.encoding = 'latin1'
      client.prepareTransfer = passiveToPinned(address.address)
      const stop = whenAborted(signal, () => client.close())
      const step = <T>(work: Promise<T>, reason: ConnectionCheckReason): Promise<T> =>
        withinIdle(work, loginTimeoutMs, signal, reason)
      let phase: ConnectionCheckReason = 'unreachable'
      try {
        await step(client.connect(address.address, Number(access.port)), 'unreachable')
        const tls = tlsOptions(access, address, options.trustedCa)
        if (tls) {
          phase = 'tls_unavailable'
          await step(client.useTLS(tls), 'tls_unavailable')
        }
        phase = 'auth_failed'
        await step(
          client.login(rawFromTyped(access.username), rawFromTyped(access.password)),
          'auth_failed',
        )
        phase = 'unsupported'
        const features = await step(client.features(), 'unsupported')
        client.availableListCommands = features.has('MLST')
          ? ['MLSD', 'LIST -a', 'LIST']
          : ['LIST -a', 'LIST']
        await step(client.send('TYPE I'), 'unsupported')
        if (tls) {
          await step(client.send('PBSZ 0'), 'tls_unavailable')
          await step(client.send('PROT P'), 'tls_unavailable')
        }
        phase = 'not_found'
        await step(client.cd(rawFromTyped(access.rootPath)), 'not_found')
        const root = await step(client.pwd(), 'not_found')
        if (!root.startsWith('/')) throw new SiteConnectionError('not_found')
        return new FtpHostingSession(client, root, { idleMs, signal, stop })
      } catch (error) {
        stop()
        client.close()
        if (isSiteConnectionError(error)) throw error
        if (error instanceof FTPError && error.code === 530)
          throw new SiteConnectionError('auth_failed')
        throw new SiteConnectionError(signal.aborted ? 'unreachable' : phase)
      }
    },
  }
}

export const ftpHostingWriter: HostingWriter<FtpAccess> = createFtpHostingWriter()
