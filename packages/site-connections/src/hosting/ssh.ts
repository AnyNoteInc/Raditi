import { createHash } from 'node:crypto'

import type { AnyAuthMethod, Client as SshClient, ParsedKey, Prompt, SFTPWrapper } from 'ssh2'
import ssh2 from 'ssh2'

import {
  hostKeySchema,
  SiteConnectionError,
  type ConnectionCheckReason,
  type PinnedAddress,
  type SshAccess,
} from '@repo/domain'

import { whenAborted, withinIdle } from './abort.ts'

// The SSH half of the SFTP writer: the host key fingerprint, the bound on a private key's KDF and
// the login. The same rules as src/sources/{host-key,private-key,sftp}.ts of the site connection
// wizard (plan 39, not merged into this branch yet): the merge keeps one copy.

const { Client, utils } = ssh2

/**
 * "<key type> SHA256:<base64 of the SHA-256 of the key blob, no padding>", the form `ssh-keygen -l`
 * prints and hostKeySchema accepts; null for a blob ssh2 cannot read or a type the schema refuses.
 */
export function sshKeyFingerprint(blob: Buffer): string | null {
  const parsed: unknown = utils.parseKey(blob)
  const key = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed
  if (key instanceof Error || typeof key !== 'object' || key === null) return null
  const { type } = key as { type?: unknown }
  if (typeof type !== 'string') return null
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  const fingerprint = `${type} SHA256:${digest}`
  return hostKeySchema.safeParse(fingerprint).success ? fingerprint : null
}

/** ssh-keygen writes 16 KDF rounds by default; ssh2 runs bcrypt_pbkdf synchronously. */
export const MAX_KEY_KDF_ROUNDS = 64
const OPENSSH_KEY =
  /^-----BEGIN OPENSSH PRIVATE KEY-----(?:\r\n|\n)([\s\S]+)(?:\r\n|\n)-----END OPENSSH PRIVATE KEY-----$/
const MAGIC = 'openssh-key-v1\0'

function readString(data: Buffer, offset: number): { value: Buffer; end: number } | null {
  if (offset < 0 || offset + 4 > data.length) return null
  const length = data.readUInt32BE(offset)
  const end = offset + 4 + length
  if (end > data.length) return null
  return { value: data.subarray(offset + 4, end), end }
}

/**
 * Whether ssh2 may be given this private key: an OpenSSH key without a KDF or with a bcrypt KDF of
 * at most MAX_KEY_KDF_ROUNDS rounds, or any other format ssh2 reads.
 */
export function keyDerivationAllowed(privateKey: string): boolean {
  const match = OPENSSH_KEY.exec(privateKey.trim())
  if (match === null) return true
  const data = Buffer.from(match[1] ?? '', 'base64')
  if (data.length < MAGIC.length || data.toString('latin1', 0, MAGIC.length) !== MAGIC) return false
  const cipher = readString(data, MAGIC.length)
  if (!cipher) return false
  const kdf = readString(data, cipher.end)
  if (!kdf) return false
  const options = readString(data, kdf.end)
  if (!options) return false
  const kdfName = kdf.value.toString('latin1')
  if (kdfName === 'none') return true
  if (kdfName !== 'bcrypt') return false
  const salt = readString(options.value, 0)
  if (!salt || salt.end + 4 > options.value.length) return false
  return options.value.readUInt32BE(salt.end) <= MAX_KEY_KDF_ROUNDS
}

/** The private key as ssh2 will sign with it; null when it cannot be read or the passphrase is wrong. */
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
 * Only the method of the access — never `none`, an agent or a key file of the machine. A password
 * is offered as `password` and once as the single hidden prompt of `keyboard-interactive`.
 */
function authMethods(access: SshAccess): AnyAuthMethod[] {
  const { username } = access
  if (access.auth === 'key') {
    const key = readPrivateKey(access.privateKey, access.passphrase)
    if (key === null) throw new SiteConnectionError('key_invalid')
    return [{ type: 'publickey', username, key }]
  }
  const { password } = access
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

/** ssh2 marks where an error came from; that is all the writer reads of it. */
function loginFailure(error: unknown): ConnectionCheckReason {
  const level =
    typeof error === 'object' && error !== null && 'level' in error
      ? (error as { level: unknown }).level
      : undefined
  if (level === 'client-authentication') return 'auth_failed'
  if (level === 'handshake') return 'unsupported'
  return 'unreachable'
}

export interface SftpConnection {
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
 * Dials the pinned literal (no lookup), accepts exactly the host key of the access before anything
 * else is sent, logs in and opens the SFTP subsystem. A changed key is `host_key_changed`.
 */
export function connectSftp(
  access: SshAccess,
  address: PinnedAddress,
  signal: AbortSignal,
  readyTimeoutMs: number,
): Promise<SftpConnection> {
  return new Promise<SftpConnection>((resolve, reject) => {
    if (signal.aborted) {
      reject(new SiteConnectionError('unreachable'))
      return
    }
    let methods: AnyAuthMethod[]
    try {
      methods = authMethods(access)
    } catch (error) {
      reject(error instanceof Error ? error : new SiteConnectionError('key_invalid'))
      return
    }
    const client = new Client()
    let settled = false
    let keyRefused = false
    let unsubscribe: () => void = () => {}
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      unsubscribe()
      client.destroy()
      reject(error)
    }
    client.on('error', (error: unknown) =>
      fail(new SiteConnectionError(keyRefused ? 'host_key_changed' : loginFailure(error))),
    )
    client.on('close', () =>
      fail(new SiteConnectionError(keyRefused ? 'host_key_changed' : 'unreachable')),
    )
    client.on('ready', () => {
      if (settled) return
      const subsystem = new Promise<SFTPWrapper>((resolveSftp, rejectSftp) =>
        client.sftp((error, sftp) => (error ? rejectSftp(error) : resolveSftp(sftp))),
      )
      withinIdle(subsystem, readyTimeoutMs, undefined, 'unsupported').then(
        (sftp) => {
          if (settled) return
          settled = true
          unsubscribe()
          // A connection lives on after `ready`: its later errors end the session, not the process.
          client.on('error', () => {})
          resolve({ client, sftp, close: () => endClient(client) })
        },
        () => fail(new SiteConnectionError('unsupported')),
      )
    })
    unsubscribe = whenAborted(signal, () => fail(new SiteConnectionError('unreachable')))
    try {
      client.connect({
        host: address.address,
        port: Number(access.port),
        username: access.username,
        hostVerifier: (key: Buffer) => {
          const accepted = sshKeyFingerprint(key) === access.hostKey
          if (!accepted) keyRefused = true
          return accepted
        },
        authHandler: methods,
        readyTimeout: readyTimeoutMs,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
      })
    } catch {
      fail(new SiteConnectionError('unreachable'))
    }
  })
}
