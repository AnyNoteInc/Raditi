import type { Socket } from 'node:net'
import { Writable } from 'node:stream'
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
  badRequest,
  FileSourceGuardError,
  ftpAccessSchema,
  isFileSourceGuardError,
  isSiteConnectionError,
  siteConnectionLimits,
  siteImportLimits,
  SiteConnectionError,
  type CodeSourceInput,
  type CodeSourceTarget,
  type ConnectionCheckReason,
  type ConnectionContext,
  type ConnectionTls,
  type FileSourceAdapter,
  type FileSourceEntry,
  type FileSourceSession,
  type FtpAccess,
  type PinnedAddress,
  type PreparedAccess,
  type SourceCheckContext,
  type SourceCheckOutcome,
} from '@repo/domain'

import { abortable, isOperationAborted, whenAborted } from '../abort.ts'
import { clientTlsOptions, isCertificateError, type TestTrust } from '../tls.ts'
import { inspectRoot, isSafeRef, type CheckBrowser, type DirectoryListing } from './root-check.ts'
import { secretFits, SinkFailure, uniqueValues } from './shared.ts'

// FTP with explicit TLS (AUTH TLS), or without encryption by the user's explicit choice; implicit
// FTPS is not spoken. The control connection is latin1, so every name keeps its raw bytes (`ref`)
// whatever the server's encoding; the name shown to the repository is decoded from them. Data
// connections are passive only and always go to the pinned address of the control connection —
// the address in a PASV reply is never dialled (FTP bounce, and a way to reach internal hosts).
// Read only: the adapter sends no command that writes, renames, deletes or changes a mode.

type FtpInput = Extract<CodeSourceInput, { kind: 'ftp' }>

/** basic-ftp's message when a listing passes `maxListingBytes`: the one text the adapter reads. */
const LISTING_OVERFLOW = 'StringWriter: Maximum bytes exceeded'

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const cp1251 = new TextDecoder('windows-1251')

/**
 * The name of a raw segment (latin1 string of its bytes): UTF-8 when the bytes are valid UTF-8, else
 * windows-1251 — the other encoding Russian hostings still list in. The one byte cp1251 cannot map
 * (0x98) becomes U+0098, which isImportSegment refuses.
 */
export function decodeServerName(raw: string): string {
  const bytes = Buffer.from(raw, 'latin1')
  try {
    return utf8.decode(bytes)
  } catch {
    return cp1251.decode(bytes)
  }
}

/** A text the user typed (UTF-8) as the latin1 string of its bytes, the form the control connection writes. */
export function rawFromTyped(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1')
}

/** The path inside a `257` reply; a quote inside it is doubled (RFC 959). null when there is none. */
export function parsePwdReply(message: string): string | null {
  const start = message.indexOf('"')
  if (start === -1) return null
  let path = ''
  for (let index = start + 1; index < message.length; index += 1) {
    const character = message[index]
    if (character === '"') {
      if (message[index + 1] !== '"') return path
      path += '"'
      index += 1
    } else {
      path += character
    }
  }
  return null
}

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

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path
}

/** The root as the server reported it, plus listed refs. */
function joinRaw(root: string, refs: readonly string[]): string {
  if (refs.length === 0) return root
  return `${root === '/' ? '' : root}/${refs.join('/')}`
}

function entryOf(info: FileInfo): FileSourceEntry {
  const type =
    info.type === FileType.File
      ? 'file'
      : info.type === FileType.Directory
        ? 'directory'
        : info.type === FileType.SymbolicLink
          ? 'link'
          : 'other'
  const size = Number.isFinite(info.size) && info.size >= 0 ? info.size : 0
  return { name: decodeServerName(info.name), ref: info.name, type, size }
}

/** basic-ftp with the knobs the adapter needs: the listing cap is per call. */
class PinnedClient extends Client {
  setListingCap(bytes: number): void {
    this.options.maxListingBytes = bytes
  }
}

/**
 * A data connection to the pinned literal and the port the server named. Over TLS it resumes the
 * session of the control connection — a server that requires it (vsftpd `require_ssl_reuse`) refuses
 * a fresh one, and a fresh one could be a stranger who guessed the port.
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
        // TLS 1.3 tickets are single use: the next data connection presents the newest one.
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

/** The transfer of a check reached its byte budget: not a failure. */
class HeadReached extends Error {
  constructor() {
    super('Read enough')
    this.name = 'HeadReached'
  }
}

interface FtpLogin {
  address: PinnedAddress
  port: number
  tls: ConnectionTls
  username: string
  password: string
  signal: AbortSignal
  timeoutMs: number
  trust: TestTrust
}

type LoginPhase = 'connect' | 'tls' | 'login' | 'settings' | 'protect'

function loginFailure(phase: LoginPhase, error: unknown): ConnectionCheckReason {
  switch (phase) {
    case 'connect':
      return 'unreachable'
    case 'tls':
      // AUTH TLS refused, or a handshake that never completed: the server offers no TLS.
      return isCertificateError(error) ? 'certificate_untrusted' : 'tls_unavailable'
    case 'login':
      if (!(error instanceof FTPError)) return 'unreachable'
      // 421: the server closes the connection (too many, not now) — not a refused password.
      if (error.code === 421) return 'unreachable'
      // 534 (RFC 2228; IIS: «Policy requires SSL»): a login without encryption refused by policy before
      // any password — not a refused login, so the gate does not count it. 530 stays a refused login:
      // vsftpd and ProFTPD answer it to both, and only their text tells which.
      if (error.code === 534) return 'tls_required'
      return 'auth_failed'
    case 'settings':
      return error instanceof FTPError ? 'unsupported' : 'unreachable'
    case 'protect':
      // PBSZ or PROT P refused: the data would travel in clear, which the user did not choose.
      return error instanceof FTPError ? 'tls_unavailable' : 'unreachable'
  }
}

/** A final reply of the 2xx class. */
function isPositiveCompletion(code: number): boolean {
  return code >= 200 && code < 300
}

/** One logged-in control connection. Once a transfer of it failed it is `broken` and only closed. */
class FtpControl {
  readonly client: PinnedClient
  broken = false
  private lastTransferBytes = 0
  private readonly stopOnAbort: () => void
  /** The server advertised MLST: it can say whether one path exists. */
  private readonly mlst: boolean

  private constructor(client: PinnedClient, stopOnAbort: () => void, mlst: boolean) {
    this.client = client
    this.stopOnAbort = stopOnAbort
    this.mlst = mlst
    client.trackProgress((info) => {
      this.lastTransferBytes = info.bytes
    })
  }

  /**
   * Dials the pinned literal, protects the connection as chosen (never another mode), logs in. basic-ftp
   * leaves a step of it unbounded — after AUTH TLS its control timeout is 0, and `close()` strips the
   * listeners of the raw socket, so a TLS handshake the server stalls never settles. Every step therefore
   * races the caller's signal and one deadline of `timeoutMs` for the whole login: past either the client
   * is closed and the step given up (a stalled handshake is `tls_unavailable`, any other step
   * `unreachable`).
   */
  static async connect(login: FtpLogin): Promise<FtpControl> {
    if (login.signal.aborted) throw new SiteConnectionError('unreachable')
    const client = new PinnedClient(login.timeoutMs, { allowSeparateTransferHost: false })
    client.ftp.encoding = 'latin1'
    client.prepareTransfer = passiveToPinned(login.address.address)
    const stop = whenAborted(login.signal, () => client.close())
    const handshake = new AbortController()
    const deadline = setTimeout(() => handshake.abort(), login.timeoutMs)
    deadline.unref()
    const stopHandshake = whenAborted(login.signal, () => handshake.abort())
    const step = <T>(work: Promise<T>): Promise<T> => abortable(handshake.signal, work)
    let phase: LoginPhase = 'connect'
    let mlst: boolean
    try {
      await step(client.connect(login.address.address, login.port))
      const tls = clientTlsOptions(login.tls, login.address, login.trust)
      if (tls) {
        phase = 'tls'
        await step(client.useTLS(tls))
      }
      phase = 'login'
      await step(client.login(rawFromTyped(login.username), rawFromTyped(login.password)))
      phase = 'settings'
      const features = await step(client.features())
      mlst = features.has('MLST')
      // The order basic-ftp's own defaults use; LIST -a also lists dotfiles on servers without MLSD.
      client.availableListCommands = mlst ? ['MLSD', 'LIST -a', 'LIST'] : ['LIST -a', 'LIST']
      await step(client.send('TYPE I'))
      await step(client.sendIgnoringError('OPTS UTF8 ON'))
      if (mlst) await step(client.sendIgnoringError('OPTS MLST type;size;'))
      if (tls) {
        phase = 'protect'
        await step(client.send('PBSZ 0'))
        await step(client.send('PROT P'))
      }
    } catch (error) {
      stop()
      client.close()
      throw new SiteConnectionError(
        login.signal.aborted ? 'unreachable' : loginFailure(phase, error),
      )
    } finally {
      clearTimeout(deadline)
      stopHandshake()
    }
    return new FtpControl(client, stop, mlst)
  }

  private failure(error: unknown, ftpReason: ConnectionCheckReason): SiteConnectionError {
    if (isSiteConnectionError(error)) return error
    return new SiteConnectionError(error instanceof FTPError ? ftpReason : 'transfer_failed')
  }

  async cwd(path: string, refused: ConnectionCheckReason): Promise<void> {
    try {
      await this.client.cd(path)
    } catch (error) {
      if (!(error instanceof FTPError)) this.broken = true
      throw this.failure(error, refused)
    }
  }

  /**
   * Whether `path` exists, asked right after a final refusal, while the connection is still in step:
   * FTP answers 550 alike to an entry that is gone and to one that may not be opened. `MLST` asks of a
   * directory (only where the server advertised it), `SIZE` of a file; null when the server cannot tell.
   * A connection lost meanwhile decides nothing: `transfer_failed`, never a file taken for absent.
   */
  private async exists(path: string, command: 'MLST' | 'SIZE'): Promise<boolean | null> {
    if (command === 'MLST' && !this.mlst) return null
    let response: FTPResponse
    try {
      response = await this.client.sendIgnoringError(`${command} ${path}`)
    } catch {
      this.broken = true
      throw new SiteConnectionError('transfer_failed')
    }
    if (isPositiveCompletion(response.code)) return true
    return response.code === 550 ? false : null
  }

  /**
   * CWD into a directory its parent listed: refused → `access_denied`, gone → `not_found`. A server
   * without MLST cannot tell the two apart; its refusal stays `access_denied` (the walker leaves out
   * either alike, as `unreadable`).
   */
  async enter(path: string): Promise<void> {
    try {
      await this.client.cd(path)
    } catch (error) {
      if (!(error instanceof FTPError)) {
        this.broken = true
        throw this.failure(error, 'access_denied')
      }
      const exists = await this.exists(path, 'MLST')
      throw new SiteConnectionError(exists === false ? 'not_found' : 'access_denied')
    }
  }

  async pwd(): Promise<string> {
    let response: FTPResponse
    try {
      response = await this.client.send('PWD')
    } catch (error) {
      if (!(error instanceof FTPError)) this.broken = true
      throw this.failure(error, 'unsupported')
    }
    const path = parsePwdReply(response.message)
    if (path === null) throw new SiteConnectionError('unsupported')
    return trimTrailingSlash(path)
  }

  /** The working directory, at most `maxBytes` of listing: past it FileSourceGuardError('listing'). */
  async list(maxBytes: number): Promise<{ infos: FileInfo[]; bytes: number }> {
    this.client.setListingCap(maxBytes)
    this.lastTransferBytes = 0
    try {
      const infos = await this.client.list()
      return { infos, bytes: this.lastTransferBytes }
    } catch (error) {
      if (!(error instanceof FTPError)) this.broken = true
      if (error instanceof Error && error.message.startsWith(LISTING_OVERFLOW))
        throw new FileSourceGuardError('listing')
      // Entered, but every listing command refused: no right to list it.
      throw this.failure(error, 'access_denied')
    }
  }

  /** Streams one file into `sink` (awaited per chunk: backpressure); past `maxBytes` the guard trips. */
  async download(
    path: string,
    sink: (chunk: Uint8Array) => Promise<void>,
    maxBytes: number,
  ): Promise<number> {
    let total = 0
    let stopped: Error | null = null
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        total += chunk.length
        if (total > maxBytes) {
          stopped = new FileSourceGuardError('bytes')
          callback(stopped)
          return
        }
        sink(chunk).then(
          () => callback(),
          (error: unknown) => {
            stopped = new SinkFailure(error)
            callback(stopped)
          },
        )
      },
    })
    try {
      await this.client.downloadTo(destination, path)
    } catch (error) {
      // RETR refused by a final 550 before any byte: no transfer was cut, the connection is in step.
      // SIZE tells a file that may not be read (`access_denied`) from one that is not there.
      if (!stopped && error instanceof FTPError && error.code === 550 && total === 0) {
        const exists = await this.exists(path, 'SIZE')
        throw new SiteConnectionError(exists === true ? 'access_denied' : 'not_found')
      }
      // Whatever the reply of the cut transfer will be, it must not answer the next command.
      this.broken = true
      if (stopped) throw stopped
      throw this.failure(error, 'not_found')
    }
    return total
  }

  /** At most `bytes` of the file, then the transfer is cut: the connection is not used again. */
  async readHead(path: string, bytes: number): Promise<void> {
    let received = 0
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        callback(received >= bytes ? new HeadReached() : null)
      },
    })
    try {
      await this.client.downloadTo(destination, path)
    } catch (error) {
      this.broken = true
      if (received >= bytes) return
      // Listed, yet RETR refused: no right to read it.
      throw this.failure(error, 'access_denied')
    }
  }

  close(): void {
    this.stopOnAbort()
    this.client.close()
  }

  /**
   * Closes the connection and resolves a little after the socket closed (at most `waitMs` for the
   * close itself). A hosting that allows two connections per user counts this one until its server
   * process has seen the end, so the pool opens a replacement only after that: a FIN when the
   * socket is still open, then the close, then a short grace. basic-ftp may have destroyed the
   * socket already (a cut transfer closes the context), and a destroyed socket closes at once,
   * before the server noticed — the grace is what covers it.
   */
  closeAndWait(waitMs = CONTROL_CLOSE_WAIT_MS): Promise<void> {
    this.stopOnAbort()
    const socket = this.client.ftp.socket
    return new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.client.close()
        setTimeout(resolve, CONTROL_CLOSE_GRACE_MS)
      }
      const timer = setTimeout(done, waitMs)
      if (socket.closed) {
        done()
        return
      }
      socket.once('close', done)
      if (!socket.destroyed) socket.end()
    })
  }
}

/** How long a broken connection may take to close before its replacement is opened anyway. */
const CONTROL_CLOSE_WAIT_MS = 2_000
/** After the close: the server process of a hosting ends the session a moment later. */
const CONTROL_CLOSE_GRACE_MS = 250

/** Runs one call of the tree on a control connection that no other call uses meanwhile. */
type ControlUse = <T>(work: (control: FtpControl) => Promise<T>) => Promise<T>

/** The check's one connection: every call goes to it, and none after a transfer of it failed. */
function onlyControl(control: FtpControl): ControlUse {
  return (work) =>
    control.broken ? Promise.reject(new SiteConnectionError('transfer_failed')) : work(control)
}

/**
 * The folder of a site. Every call names its directory or file by the absolute path PWD gave for the
 * root plus listed refs, so any logged-in connection serves any call and none leaves state for the next.
 */
class FtpTree implements CheckBrowser {
  private readonly use: ControlUse
  readonly root: string

  private constructor(use: ControlUse, root: string) {
    this.use = use
    this.root = root
  }

  /** CWD to the folder as typed (relative to the login folder unless absolute); PWD names the root. */
  static async locate(control: FtpControl, rootPath: string, use: ControlUse): Promise<FtpTree> {
    await control.cwd(rawFromTyped(rootPath), 'not_found')
    return new FtpTree(use, await control.pwd())
  }

  /**
   * The server confirms where it is before anything is listed: PWD after CWD must be the root plus the
   * segments, else the directory is a link shown as a folder (`outside_root`).
   */
  async listDirectory(
    refs: readonly string[],
    maxEntries: number,
    maxBytes: number,
  ): Promise<DirectoryListing> {
    if (!refs.every(isSafeRef)) throw new FileSourceGuardError('outside_root')
    const path = joinRaw(this.root, refs)
    return this.use(async (control) => {
      if (refs.length === 0) {
        await control.cwd(path, 'not_found')
      } else {
        await control.enter(path)
        if ((await control.pwd()) !== path) throw new FileSourceGuardError('outside_root')
      }
      const { infos, bytes } = await control.list(maxBytes)
      const entries = infos.map(entryOf)
      if (entries.length > maxEntries) throw new FileSourceGuardError('entries')
      return { entries, bytes }
    })
  }

  list(directory: readonly string[], maxBytes: number): Promise<DirectoryListing> {
    return this.listDirectory(directory, Number.MAX_SAFE_INTEGER, maxBytes)
  }

  private filePath(refs: readonly string[]): string {
    if (refs.length === 0 || !refs.every(isSafeRef)) throw new SiteConnectionError('not_found')
    return joinRaw(this.root, refs)
  }

  async read(
    refs: readonly string[],
    sink: (chunk: Uint8Array) => Promise<void>,
    maxBytes: number,
  ): Promise<number> {
    const path = this.filePath(refs)
    return this.use((control) => control.download(path, sink, maxBytes))
  }

  async readHead(refs: readonly string[], bytes: number): Promise<void> {
    const path = this.filePath(refs)
    await this.use((control) => control.readHead(path, bytes))
  }

  /** FTP names are bytes: a folder is typed only when its name is UTF-8, which is what the field sends. */
  typedSegment(entry: FileSourceEntry): string | null {
    return rawFromTyped(entry.name) === entry.ref ? entry.name : null
  }
}

/**
 * The control connections of a session: never more than `limit` (siteImportLimits.ftpSessions) at once,
 * the one `open` logged in with among them — a hosting that allows an account two logins refuses a
 * third. Any of them lists or reads, whichever call finds it idle, so `limit` reads run at once and a
 * listing waits for a free one. More are logged in only when a call finds none idle and fewer than
 * `limit` are open. A connection whose transfer failed is closed, never reused (its late reply would
 * answer the next command); the next call that needs one logs in again.
 */
class FtpConnections {
  private readonly open: () => Promise<FtpControl>
  private readonly limit: number
  private readonly idle: FtpControl[]
  private readonly all = new Set<FtpControl>()
  private readonly waiting: Array<() => void> = []
  private size: number
  private closed = false

  constructor(first: FtpControl, open: () => Promise<FtpControl>, limit: number) {
    this.open = open
    this.limit = Math.max(limit, 1)
    this.idle = [first]
    this.all.add(first)
    this.size = 1
  }

  readonly use: ControlUse = async (work) => {
    const control = await this.acquire()
    try {
      return await work(control)
    } finally {
      this.release(control)
    }
  }

  private async acquire(): Promise<FtpControl> {
    for (;;) {
      if (this.closed) throw new SiteConnectionError('transfer_failed')
      const ready = this.idle.pop()
      if (ready) return ready
      if (this.size < this.limit) {
        this.size += 1
        let control: FtpControl
        try {
          control = await this.open()
        } catch (error) {
          this.size -= 1
          this.wake()
          throw error
        }
        if (this.closed) {
          control.close()
          throw new SiteConnectionError('transfer_failed')
        }
        this.all.add(control)
        return control
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
  }

  private release(control: FtpControl): void {
    if (this.closed) {
      control.close()
      this.all.delete(control)
      this.size -= 1
      this.wake()
    } else if (control.broken) {
      this.all.delete(control)
      // Its place stays taken until the server has let go of it: see closeAndWait.
      void control.closeAndWait().then(() => {
        this.size -= 1
        this.wake()
      })
    } else {
      this.idle.push(control)
      this.wake()
    }
  }

  private wake(): void {
    this.waiting.shift()?.()
  }

  close(): void {
    this.closed = true
    for (const control of this.all) control.close()
    this.all.clear()
    this.idle.length = 0
    for (const resolve of this.waiting.splice(0)) resolve()
  }
}

function asFtp(input: CodeSourceInput): FtpInput {
  if (input.kind !== 'ftp') throw badRequest('Not an FTP source')
  return input
}

function checkReason(error: unknown, signal: AbortSignal): ConnectionCheckReason {
  if (signal.aborted || isOperationAborted(error)) return 'unreachable'
  if (isSiteConnectionError(error)) return error.reason
  return 'transfer_failed'
}

async function sessionCall<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  try {
    return await abortable(signal, work())
  } catch (error) {
    if (error instanceof SinkFailure) throw error.cause
    if (isSiteConnectionError(error) || isFileSourceGuardError(error)) throw error
    throw new SiteConnectionError('transfer_failed')
  }
}

/** The limits of a session and the trust of `verified`, for the tests of this package only. */
export interface FtpSourceOptions {
  trust?: TestTrust
  idleMs?: number
  listingBytes?: number
}

export function createFtpSource(options: FtpSourceOptions = {}): FileSourceAdapter<FtpAccess> {
  const trust = options.trust ?? {}
  const idleMs = options.idleMs ?? siteImportLimits.idleMs
  const listingBytes = options.listingBytes ?? siteImportLimits.listingBytes

  return {
    kind: 'ftp',
    accessKind: 'ftp',
    accessSchema: ftpAccessSchema,
    defaultPort: 21,
    transfer: 'files',

    endpoint(input) {
      const ftp = asFtp(input)
      return { host: ftp.host, port: ftp.port }
    },

    async check(input: CodeSourceInput, context: SourceCheckContext): Promise<SourceCheckOutcome> {
      const ftp = asFtp(input)
      let control: FtpControl
      try {
        control = await FtpControl.connect({
          address: context.address,
          port: ftp.port,
          tls: ftp.tls,
          username: ftp.username,
          password: ftp.password,
          signal: context.signal,
          timeoutMs: siteConnectionLimits.checkMs,
          trust,
        })
      } catch (error) {
        return { ok: false, reason: checkReason(error, context.signal) }
      }
      try {
        // One connection for the whole check: a second login would double the attempts the server counts.
        const tree = await abortable(
          context.signal,
          FtpTree.locate(control, ftp.rootPath, onlyControl(control)),
        )
        const inspection = await abortable(
          context.signal,
          inspectRoot(tree, ftp.rootPath, context.markers),
        )
        if (!inspection.ok) return inspection
        return {
          ok: true,
          hostKey: null,
          canonicalUrl: null,
          defaultBranch: null,
          entries: inspection.entries,
        }
      } catch (error) {
        return { ok: false, reason: checkReason(error, context.signal) }
      } finally {
        control.close()
      }
    },

    prepare(input: CodeSourceInput): PreparedAccess<CodeSourceTarget> {
      const ftp = asFtp(input)
      const secret: Record<string, string> = {
        v: '1',
        host: ftp.host,
        port: String(ftp.port),
        tls: ftp.tls,
        rootPath: ftp.rootPath,
        username: ftp.username,
        password: ftp.password,
      }
      // The schema's error would carry the values: only the verdict is kept.
      if (!ftpAccessSchema.safeParse(secret).success || !secretFits(secret))
        throw badRequest('Invalid FTP access')
      return {
        accessKind: 'ftp',
        secret,
        target: {
          kind: 'ftp',
          host: ftp.host,
          port: ftp.port,
          rootPath: ftp.rootPath,
          repositoryUrl: null,
          branch: null,
          tls: ftp.tls,
          hostKey: null,
        },
      }
    },

    endpointOf(access) {
      return { host: access.host, port: Number(access.port) }
    },

    matchesTarget(access, target) {
      return (
        target.kind === 'ftp' &&
        target.host === access.host &&
        target.port === Number(access.port) &&
        target.rootPath === access.rootPath &&
        target.tls === access.tls &&
        target.hostKey === null &&
        target.repositoryUrl === null &&
        target.branch === null
      )
    },

    scanValues(access) {
      return uniqueValues([access.password])
    },

    async open(access: FtpAccess, context: ConnectionContext): Promise<FileSourceSession> {
      const login: FtpLogin = {
        address: context.address,
        port: Number(access.port),
        tls: access.tls,
        username: access.username,
        password: access.password,
        signal: context.signal,
        timeoutMs: idleMs,
        trust,
      }
      const first = await FtpControl.connect(login)
      const connections = new FtpConnections(
        first,
        () => FtpControl.connect(login),
        siteImportLimits.ftpSessions,
      )
      let tree: FtpTree
      try {
        tree = await abortable(
          context.signal,
          FtpTree.locate(first, access.rootPath, connections.use),
        )
      } catch (error) {
        connections.close()
        if (isSiteConnectionError(error)) throw error
        throw new SiteConnectionError(context.signal.aborted ? 'unreachable' : 'transfer_failed')
      }

      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        stopOnAbort()
        connections.close()
      }
      // The deadline of the stage ends the session: every connection goes, every call settles.
      const stopOnAbort = whenAborted(context.signal, () => {
        closed = true
        connections.close()
      })
      const { signal } = context

      return {
        // As many reads at once as there are connections: a listing takes one of the same.
        concurrency: siteImportLimits.ftpSessions,
        list: (directory, maxEntries) =>
          sessionCall(signal, async () => {
            if (closed) throw new SiteConnectionError('transfer_failed')
            return (await tree.listDirectory(directory, maxEntries, listingBytes)).entries
          }),
        read: (path, sink, maxBytes) =>
          sessionCall(signal, () => {
            if (closed) throw new SiteConnectionError('transfer_failed')
            return tree.read(path, sink, maxBytes)
          }),
        close: async () => close(),
      }
    },
  }
}

export const ftpSource: FileSourceAdapter<FtpAccess> = createFtpSource()
