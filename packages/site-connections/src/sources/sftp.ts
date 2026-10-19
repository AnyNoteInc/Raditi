import type {
  AnyAuthMethod,
  Client as SshClient,
  FileEntryWithStats,
  ParsedKey,
  Prompt,
  SFTPWrapper,
  Stats,
} from 'ssh2'
import ssh2 from 'ssh2'

import {
  badRequest,
  FileSourceGuardError,
  hostKeySchema,
  isFileSourceGuardError,
  isSiteConnectionError,
  siteConnectionLimits,
  siteImportLimits,
  SiteConnectionError,
  sshAccessSchema,
  type CodeSourceInput,
  type CodeSourceTarget,
  type ConnectionCheckReason,
  type ConnectionContext,
  type FileSourceAdapter,
  type FileSourceEntry,
  type FileSourceSession,
  type PinnedAddress,
  type PreparedAccess,
  type SourceCheckContext,
  type SourceCheckOutcome,
  type SourceCheckPassed,
  type SshAccess,
} from '@repo/domain'

import {
  abortable,
  ignoreRejection,
  isOperationAborted,
  whenAborted,
  withinIdle,
} from '../abort.ts'
import { sshKeyFingerprint } from './host-key.ts'
import { keyDerivationAllowed } from './private-key.ts'
import { inspectRoot, isSafeRef, type CheckBrowser, type DirectoryListing } from './root-check.ts'
import { secretFits, SinkFailure, uniqueValues } from './shared.ts'

// SFTP over SSH (owner's decision of 17.10.2026: SSH access means SFTP, never a shell). The host key
// is learnt by a check that logs in nowhere, confirmed by the user, then pinned: in the secret, in
// site_code_sources.host_key and in every later connection, which accepts no other key. Read only:
// the adapter opens files for reading and directories for listing, and sends nothing that writes.

const { Client, utils } = ssh2

type SftpInput = Extract<CodeSourceInput, { kind: 'sftp' }>

const STATUS = ssh2.utils.sftp.STATUS_CODE
/** File type bits of `st_mode`. */
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

/** One READ asks for this much: under the 34 000-byte packet of a server that is not OpenSSH. */
const READ_CHUNK = 32 * 1024
/** READ requests in flight per file: 256 KiB of read-ahead, so a long path is not one round trip per chunk. */
const READ_WINDOW = 8
/** The bytes a listed entry is counted for beyond its two names: what ATTRS carries. */
const ENTRY_OVERHEAD = 32

/** The limits of a session, for the tests of this package; the exported adapter keeps the domain's. */
export interface SftpSourceOptions {
  /** A request without an answer for this long fails `transfer_failed` (siteImportLimits.idleMs). */
  idleMs?: number
  /** The bound of the handshake and the SFTP subsystem of a session (default `idleMs`). */
  readyTimeoutMs?: number
  /** The byte cap of one session listing (siteImportLimits.listingBytes). */
  listingBytes?: number
}

function entryType(mode: number | undefined, longname: string): FileSourceEntry['type'] {
  if (typeof mode === 'number' && Number.isFinite(mode)) {
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
  // A server that leaves the permissions out of ATTRS still prints `ls -l` in the long name.
  switch (longname[0]) {
    case '-':
      return 'file'
    case 'd':
      return 'directory'
    case 'l':
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
function sftpFailure(error: unknown): SiteConnectionError {
  if (isSiteConnectionError(error)) return error
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

/** One SFTP request: settles within `idleMs` or fails `transfer_failed`; a status becomes its reason. */
async function request<T>(idleMs: number, call: (callback: Callback<T>) => void): Promise<T> {
  const work = new Promise<T>((resolve, reject) => {
    try {
      call((error, value) => (error ? reject(error) : resolve(value)))
    } catch (error) {
      reject(error instanceof Error ? error : new Error('SFTP request failed'))
    }
  })
  try {
    return await withinIdle(work, idleMs)
  } catch (error) {
    throw sftpFailure(error)
  }
}

/** Ends of EOF: the status a READDIR or READ answers when nothing is left. */
function isEof(error: unknown): boolean {
  return statusCode(error) === STATUS.EOF
}

/** The folder of a site on one SFTP channel: every path the adapter sends is `root` plus listed refs. */
class SftpTree {
  private readonly sftp: SFTPWrapper
  readonly root: string
  private readonly idleMs: number

  private constructor(sftp: SFTPWrapper, root: string, idleMs: number) {
    this.sftp = sftp
    this.root = root
    this.idleMs = idleMs
  }

  /** `realpath` of the folder as typed (relative to the login folder unless absolute); it must be a directory. */
  static async locate(sftp: SFTPWrapper, rootPath: string, idleMs: number): Promise<SftpTree> {
    const root = await request<string>(idleMs, (callback) => sftp.realpath(rootPath, callback))
    const stats = await request<Stats>(idleMs, (callback) => sftp.stat(root, callback))
    if (entryType(stats.mode, '') !== 'directory') throw new SiteConnectionError('not_found')
    return new SftpTree(sftp, root, idleMs)
  }

  private path(refs: readonly string[]): string {
    if (refs.length === 0) return this.root
    return `${this.root === '/' ? '' : this.root}/${refs.join('/')}`
  }

  private request<T>(call: (callback: Callback<T>) => void): Promise<T> {
    return request(this.idleMs, call)
  }

  /**
   * The server confirms where it is before anything is listed: `realpath` of the directory must be
   * the root plus the segments, else the directory is a link shown as a folder (`outside_root`).
   */
  async list(
    refs: readonly string[],
    maxEntries: number,
    maxBytes: number,
  ): Promise<DirectoryListing> {
    if (!refs.every(isSafeRef)) throw new FileSourceGuardError('outside_root')
    const path = this.path(refs)
    if (refs.length > 0) {
      const real = await this.request<string>((callback) => this.sftp.realpath(path, callback))
      if (real !== path) throw new FileSourceGuardError('outside_root')
    }
    const handle = await this.request<Buffer>((callback) => this.sftp.opendir(path, callback))
    const entries: FileSourceEntry[] = []
    let bytes = 0
    try {
      for (;;) {
        let batch: FileEntryWithStats[]
        try {
          batch = await withinIdle(
            new Promise<FileEntryWithStats[]>((resolve, reject) =>
              this.sftp.readdir(handle, (error, list) => (error ? reject(error) : resolve(list))),
            ),
            this.idleMs,
          )
        } catch (error) {
          if (isEof(error)) break
          throw sftpFailure(error)
        }
        // A server that answers an empty batch instead of EOF would otherwise loop forever.
        if (!Array.isArray(batch) || batch.length === 0) break
        for (const { filename, longname, attrs } of batch) {
          if (filename === '.' || filename === '..') continue
          bytes += Buffer.byteLength(filename) + Buffer.byteLength(longname ?? '') + ENTRY_OVERHEAD
          if (bytes > maxBytes) throw new FileSourceGuardError('listing')
          entries.push({
            name: filename,
            ref: filename,
            type: entryType(attrs?.mode, longname ?? ''),
            size: typeof attrs?.size === 'number' && Number.isFinite(attrs.size) ? attrs.size : 0,
          })
          if (entries.length > maxEntries) throw new FileSourceGuardError('entries')
        }
      }
    } finally {
      this.closeHandle(handle)
    }
    return { entries, bytes }
  }

  private readAt(handle: Buffer, offset: number, length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length)
    const read = new Promise<Buffer>((resolve, reject) => {
      this.sftp.read(handle, buffer, 0, length, offset, (error, bytesRead) =>
        error ? reject(error) : resolve(buffer.subarray(0, bytesRead)),
      )
    })
    ignoreRejection(read)
    return read
  }

  private open(refs: readonly string[]): Promise<Buffer> {
    if (refs.length === 0 || !refs.every(isSafeRef)) throw new SiteConnectionError('not_found')
    const path = this.path(refs)
    return this.request<Buffer>((callback) => this.sftp.open(path, 'r', callback))
  }

  /** Closing never blocks the caller: the answer is not awaited, an error is dropped. */
  private closeHandle(handle: Buffer): void {
    try {
      this.sftp.close(handle, () => {})
    } catch {
      // The channel is already gone: nothing is left to close.
    }
  }

  /**
   * Streams the file into `sink` in order, READ_WINDOW requests ahead; the next request waits until
   * `sink` took the chunk (backpressure). It asks for at most `maxBytes + 1` bytes: one more proves
   * the file is longer. A short answer is not the end: its rest is asked again before the next.
   */
  async read(
    refs: readonly string[],
    sink: (chunk: Uint8Array) => Promise<void>,
    maxBytes: number,
  ): Promise<number> {
    const handle = await this.open(refs)
    const limit = maxBytes + 1
    const queue: { offset: number; length: number; data: Promise<Buffer> }[] = []
    let next = 0
    let total = 0
    const ask = (offset: number, length: number) => ({
      offset,
      length,
      data: this.readAt(handle, offset, length),
    })
    const topUp = () => {
      while (queue.length < READ_WINDOW && next < limit) {
        const length = Math.min(READ_CHUNK, limit - next)
        queue.push(ask(next, length))
        next += length
      }
    }
    try {
      topUp()
      for (let head = queue.shift(); head; head = queue.shift()) {
        let data: Buffer
        try {
          data = await withinIdle(head.data, this.idleMs)
        } catch (error) {
          throw sftpFailure(error)
        }
        if (data.length === 0) break
        total += data.length
        if (total > maxBytes) throw new FileSourceGuardError('bytes')
        if (data.length < head.length)
          queue.unshift(ask(head.offset + data.length, head.length - data.length))
        try {
          await sink(data)
        } catch (error) {
          throw new SinkFailure(error)
        }
        topUp()
      }
      return total
    } finally {
      this.closeHandle(handle)
    }
  }

  /** One READ of at most `bytes` at the start of the file: what a check needs to prove reading. */
  async readHead(refs: readonly string[], bytes: number): Promise<void> {
    const handle = await this.open(refs)
    try {
      await withinIdle(this.readAt(handle, 0, bytes), this.idleMs).catch((error: unknown) => {
        throw sftpFailure(error)
      })
    } finally {
      this.closeHandle(handle)
    }
  }
}

type SshAuth = { method: 'password'; password: string } | { method: 'key'; key: ParsedKey }

/**
 * The private key as ssh2 will sign with it; null when it cannot be read or the passphrase is wrong.
 * The one place a key of a user is parsed (check and open): its KDF rounds are bounded first.
 */
function readPrivateKey(privateKey: string, passphrase: string | undefined): ParsedKey | null {
  if (!keyDerivationAllowed(privateKey)) return null
  let parsed: unknown
  try {
    parsed = utils.parseKey(privateKey, passphrase)
  } catch {
    return null
  }
  const key = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed
  if (key instanceof Error || typeof key !== 'object' || key === null) return null
  const candidate = key as ParsedKey
  return typeof candidate.isPrivateKey === 'function' && candidate.isPrivateKey() ? candidate : null
}

/**
 * Only the method the user chose — never `none`, an agent or a key file of the machine. A password
 * is offered as `password` and then once as the single hidden prompt of `keyboard-interactive`, the
 * only way some servers take one; any other prompt is answered with nothing.
 */
function authMethods(username: string, auth: SshAuth): AnyAuthMethod[] {
  if (auth.method === 'key') return [{ type: 'publickey', username, key: auth.key }]
  const { password } = auth
  return [
    { type: 'password', username, password },
    {
      type: 'keyboard-interactive',
      username,
      prompt(_name: string, _instructions: string, _lang: string, prompts: Prompt[], finish) {
        finish(prompts.length === 1 && prompts[0]?.echo !== true ? [password] : [])
      },
    },
  ]
}

interface SshLogin {
  address: PinnedAddress
  port: number
  username: string
  auth: SshAuth
  /** The verdict on the key the server presented (null: a key the platform cannot read). */
  acceptHostKey(fingerprint: string | null): boolean
  signal: AbortSignal
  readyTimeoutMs: number
}

/** ssh2 marks where an error came from; that is all the adapter reads of it. */
function loginFailure(error: unknown): ConnectionCheckReason {
  const level =
    typeof error === 'object' && error !== null && 'level' in error
      ? (error as { level: unknown }).level
      : undefined
  if (level === 'client-authentication') return 'auth_failed'
  // No algorithm in common, or a key exchange that failed: a server the platform does not speak.
  if (level === 'handshake') return 'unsupported'
  return 'unreachable'
}

interface SftpConnection {
  client: SshClient
  sftp: SFTPWrapper
  close(): void
}

/** Ends the connection; a server that does not close its side is cut a second later. */
function endClient(client: SshClient): void {
  try {
    client.end()
  } catch {
    // Already closed.
  }
  setTimeout(() => client.destroy(), 1_000).unref()
}

/**
 * Dials the pinned literal (no lookup), verifies the host key before anything else is sent, logs in
 * and opens the SFTP subsystem. Rejects with SiteConnectionError, or OperationAborted.
 */
function connectSftp(login: SshLogin): Promise<SftpConnection> {
  return new Promise<SftpConnection>((resolve, reject) => {
    if (login.signal.aborted) {
      reject(new SiteConnectionError('unreachable'))
      return
    }
    const client = new Client()
    let settled = false
    let unsubscribe: () => void = () => {}
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      unsubscribe()
      client.destroy()
      reject(error)
    }
    // A connection lives on after `ready`: its later errors end the session, never the process.
    client.on('error', (error: unknown) => fail(new SiteConnectionError(loginFailure(error))))
    client.on('close', () => fail(new SiteConnectionError('unreachable')))
    client.on('ready', () => {
      if (settled) return
      const subsystem = new Promise<SFTPWrapper>((resolveSftp, rejectSftp) =>
        client.sftp((error, sftp) => (error ? rejectSftp(error) : resolveSftp(sftp))),
      )
      withinIdle(subsystem, login.readyTimeoutMs, 'unsupported').then(
        (sftp) => {
          if (settled) return
          settled = true
          unsubscribe()
          resolve({ client, sftp, close: () => endClient(client) })
        },
        // A login without the SFTP subsystem: a shell-only account.
        () => fail(new SiteConnectionError('unsupported')),
      )
    })
    unsubscribe = whenAborted(login.signal, () => fail(new SiteConnectionError('unreachable')))
    try {
      client.connect({
        host: login.address.address,
        port: login.port,
        username: login.username,
        hostVerifier: (key: Buffer) => login.acceptHostKey(sshKeyFingerprint(key)),
        authHandler: authMethods(login.username, login.auth),
        readyTimeout: login.readyTimeoutMs,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
      })
    } catch {
      fail(new SiteConnectionError('unreachable'))
    }
  })
}

function asSftp(input: CodeSourceInput): SftpInput {
  if (input.kind !== 'sftp') throw badRequest('Not an SFTP source')
  return input
}

function authOf(input: SftpInput): SshAuth | null {
  if (input.auth.method === 'password') return { method: 'password', password: input.auth.password }
  const key = readPrivateKey(input.auth.privateKey, input.auth.passphrase)
  return key ? { method: 'key', key } : null
}

function authOfAccess(access: SshAccess): SshAuth | null {
  if (access.auth === 'password') return { method: 'password', password: access.password }
  const key = readPrivateKey(access.privateKey, access.passphrase)
  return key ? { method: 'key', key } : null
}

/** The reason of a check that failed after the login: never thrown, never the server's text. */
function checkReason(error: unknown, signal: AbortSignal): ConnectionCheckReason {
  if (signal.aborted || isOperationAborted(error)) return 'unreachable'
  if (isSiteConnectionError(error)) return error.reason
  // A root listing past checkListingBytes, or anything unexpected after the login.
  return 'transfer_failed'
}

/** A session call: settles as soon as the signal aborts; an unexpected failure is `transfer_failed`. */
async function sessionCall<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  try {
    return await abortable(signal, work())
  } catch (error) {
    if (error instanceof SinkFailure) throw error.cause
    if (isSiteConnectionError(error) || isFileSourceGuardError(error)) throw error
    throw new SiteConnectionError('transfer_failed')
  }
}

/** The private key as stored, and each line of its body long enough to be key material on its own. */
function keyScanValues(privateKey: string): string[] {
  const lines = privateKey
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 64 && !line.startsWith('-----'))
  return [privateKey.trim(), ...lines]
}

export function createSftpSource(options: SftpSourceOptions = {}): FileSourceAdapter<SshAccess> {
  const idleMs = options.idleMs ?? siteImportLimits.idleMs
  const readyTimeoutMs = options.readyTimeoutMs ?? idleMs
  const listingBytes = options.listingBytes ?? siteImportLimits.listingBytes

  return {
    kind: 'sftp',
    accessKind: 'ssh',
    accessSchema: sshAccessSchema,
    defaultPort: 22,
    transfer: 'files',

    endpoint(input) {
      const sftp = asSftp(input)
      return { host: sftp.host, port: sftp.port }
    },

    async check(input: CodeSourceInput, context: SourceCheckContext): Promise<SourceCheckOutcome> {
      const sftp = asSftp(input)
      const expected = sftp.hostKey
      // create and replaceAccess: the key was confirmed before, and nothing else is accepted.
      if (expected === undefined && context.pinRequired)
        return { ok: false, reason: 'host_key_changed' }
      const auth = authOf(sftp)
      if (!auth) return { ok: false, reason: 'key_invalid' }

      const seen: { key: string | null; verdict: 'unknown' | 'changed' | 'unreadable' | null } = {
        key: null,
        verdict: null,
      }
      let connection: SftpConnection
      try {
        connection = await connectSftp({
          address: context.address,
          port: sftp.port,
          username: sftp.username,
          auth,
          signal: context.signal,
          readyTimeoutMs: siteConnectionLimits.checkMs,
          acceptHostKey(fingerprint) {
            if (fingerprint === null) {
              seen.verdict = 'unreadable'
              return false
            }
            seen.key = fingerprint
            // Without a key nothing is sent but the key exchange: the user confirms the key first.
            if (expected === undefined) seen.verdict = 'unknown'
            else if (fingerprint !== expected) seen.verdict = 'changed'
            return seen.verdict === null
          },
        })
      } catch (error) {
        if (seen.verdict === 'unknown' && seen.key !== null)
          return { ok: false, reason: 'host_key_unknown', hostKey: seen.key }
        if (seen.verdict === 'changed' && seen.key !== null)
          return { ok: false, reason: 'host_key_changed', hostKey: seen.key }
        if (seen.verdict === 'unreadable') return { ok: false, reason: 'unsupported' }
        return { ok: false, reason: checkReason(error, context.signal) }
      }

      try {
        const tree = await abortable(
          context.signal,
          SftpTree.locate(connection.sftp, sftp.rootPath, idleMs),
        )
        const browser: CheckBrowser = {
          list: (directory, maxBytes) => tree.list(directory, Number.MAX_SAFE_INTEGER, maxBytes),
          readHead: (path, bytes) => tree.readHead(path, bytes),
          // SFTP names are UTF-8 on the wire: what is listed is what a user types.
          typedSegment: (entry) => entry.name,
        }
        const inspection = await abortable(
          context.signal,
          inspectRoot(browser, sftp.rootPath, context.markers),
        )
        if (!inspection.ok) return inspection
        return {
          ok: true,
          hostKey: seen.key,
          canonicalUrl: null,
          defaultBranch: null,
          entries: inspection.entries,
        }
      } catch (error) {
        return { ok: false, reason: checkReason(error, context.signal) }
      } finally {
        connection.close()
      }
    },

    prepare(input: CodeSourceInput, passed: SourceCheckPassed): PreparedAccess<CodeSourceTarget> {
      const sftp = asSftp(input)
      const hostKey = passed.hostKey
      if (hostKey === null || !hostKeySchema.safeParse(hostKey).success)
        throw badRequest('An SFTP access needs the host key its check returned')
      const common = {
        v: '1',
        host: sftp.host,
        port: String(sftp.port),
        hostKey,
        rootPath: sftp.rootPath,
        username: sftp.username,
      }
      const secret: Record<string, string> =
        sftp.auth.method === 'password'
          ? { ...common, auth: 'password', password: sftp.auth.password }
          : {
              ...common,
              auth: 'key',
              privateKey: sftp.auth.privateKey,
              ...(sftp.auth.passphrase === undefined ? {} : { passphrase: sftp.auth.passphrase }),
            }
      // The schema's error would carry the values: only the verdict is kept.
      if (!sshAccessSchema.safeParse(secret).success || !secretFits(secret))
        throw badRequest('Invalid SFTP access')
      return {
        accessKind: 'ssh',
        secret,
        target: {
          kind: 'sftp',
          host: sftp.host,
          port: sftp.port,
          rootPath: sftp.rootPath,
          repositoryUrl: null,
          branch: null,
          tls: null,
          hostKey,
        },
      }
    },

    endpointOf(access) {
      return { host: access.host, port: Number(access.port) }
    },

    matchesTarget(access, target) {
      return (
        target.kind === 'sftp' &&
        target.host === access.host &&
        target.port === Number(access.port) &&
        target.rootPath === access.rootPath &&
        target.hostKey === access.hostKey &&
        target.tls === null &&
        target.repositoryUrl === null &&
        target.branch === null
      )
    },

    scanValues(access) {
      if (access.auth === 'password') return uniqueValues([access.password])
      return uniqueValues([...keyScanValues(access.privateKey), access.passphrase])
    },

    async open(access: SshAccess, context: ConnectionContext): Promise<FileSourceSession> {
      const auth = authOfAccess(access)
      if (!auth) throw new SiteConnectionError('key_invalid')
      let refusedKey = false
      let connection: SftpConnection
      try {
        connection = await connectSftp({
          address: context.address,
          port: Number(access.port),
          username: access.username,
          auth,
          signal: context.signal,
          readyTimeoutMs,
          // The worker accepts the pinned key and nothing else: there is no user here to ask.
          acceptHostKey(fingerprint) {
            refusedKey = fingerprint !== access.hostKey
            return !refusedKey
          },
        })
      } catch (error) {
        if (refusedKey) throw new SiteConnectionError('host_key_changed')
        throw isSiteConnectionError(error) ? error : new SiteConnectionError('unreachable')
      }

      let tree: SftpTree
      try {
        tree = await abortable(
          context.signal,
          SftpTree.locate(connection.sftp, access.rootPath, idleMs),
        )
      } catch (error) {
        connection.close()
        if (isSiteConnectionError(error)) throw error
        throw new SiteConnectionError(context.signal.aborted ? 'unreachable' : 'transfer_failed')
      }

      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        stopOnAbort()
        connection.close()
      }
      // The deadline of the stage ends the session: every socket goes, every call settles.
      const stopOnAbort = whenAborted(context.signal, () => {
        closed = true
        connection.client.destroy()
      })
      const { signal } = context

      return {
        concurrency: siteImportLimits.sftpStreams,
        list: (directory, maxEntries) =>
          sessionCall(signal, async () => {
            if (closed) throw new SiteConnectionError('transfer_failed')
            const listing = await tree.list(directory, maxEntries, listingBytes)
            return listing.entries
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

export const sftpSource: FileSourceAdapter<SshAccess> = createSftpSource()
