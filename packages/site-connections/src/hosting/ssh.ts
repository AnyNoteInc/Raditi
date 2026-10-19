import type { AnyAuthMethod, Client as SshClient, ParsedKey, Prompt, SFTPWrapper } from 'ssh2'
import ssh2 from 'ssh2'

import {
  SiteConnectionError,
  type ConnectionCheckReason,
  type PinnedAddress,
  type SshAccess,
} from '@repo/domain'

import { sshKeyFingerprint } from '../sources/host-key.ts'
import { keyDerivationAllowed } from '../sources/private-key.ts'
import { whenAborted, withinIdle } from './abort.ts'

// The SSH half of the SFTP writer: the login, with the host key fingerprint and the bound on a
// private key's KDF of the wizard's file sources (src/sources/host-key.ts, private-key.ts).

const { Client, utils } = ssh2

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
