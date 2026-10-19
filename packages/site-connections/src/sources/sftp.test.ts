import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  isFileSourceGuardError,
  isSiteConnectionError,
  resolvePinnedAddress,
  sshAccessSchema,
  type CodeSourceInput,
  type PinnedAddress,
  type SourceCheckContext,
  type SshAccess,
} from '@repo/domain'

import {
  generateTestSshKey,
  startTestSftpServer,
  withKdfRounds,
  type TestSftpServer,
} from '../testing/index.ts'
import { createSftpSource, sftpSource } from './sftp.ts'

const MARKERS = ['wp-content', 'wp-includes']
const BIG = Buffer.alloc(1024 * 1024 + 4321, 0)
for (let index = 0; index < BIG.length; index += 1) BIG[index] = (index * 31 + 7) % 251

const userKey = generateTestSshKey()
const lockedKey = generateTestSshKey({ type: 'ecdsa', passphrase: 'correct horse' })
const otherHostKey = generateTestSshKey()

const files = {
  'public_html/index.php': '<?php require "wp-blog-header.php";',
  'public_html/wp-includes/version.php': '<?php $wp_version = "6.9";',
  'public_html/wp-content/themes/site/style.css': 'body {}',
  'public_html/wp-content/uploads/big.bin': BIG,
  'public_html/private/secret.txt': 'no',
  'other/readme.txt': 'not a site',
  'large/wp-content/a.txt': 'a',
  'large/wp-includes/b.txt': 'b',
  'large/blob.bin': BIG,
  // A root with folders only: the check reads a file of a marker folder.
  'bare/wp-content/index.php': '<?php // Silence is golden.',
  'bare/wp-includes/version.php': '<?php $wp_version = "6.9";',
}

let server: TestSftpServer
let address: PinnedAddress

async function pin(host: string): Promise<PinnedAddress> {
  const result = await resolvePinnedAddress(
    { appEnv: 'development', lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    host,
    new AbortController().signal,
  )
  if (!result.ok) throw new Error(`cannot pin ${host}`)
  return result.address
}

function context(overrides: Partial<SourceCheckContext> = {}): SourceCheckContext {
  return {
    address,
    signal: AbortSignal.timeout(10_000),
    markers: MARKERS,
    pinRequired: false,
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}): CodeSourceInput {
  return {
    kind: 'sftp',
    host: '127.0.0.1',
    port: server.port,
    username: 'site',
    auth: { method: 'password', password: 'p@ss word' },
    rootPath: 'public_html',
    hostKey: server.hostKey,
    ...overrides,
  } as CodeSourceInput
}

function access(overrides: Partial<Record<string, string>> = {}): SshAccess {
  return sshAccessSchema.parse({
    v: '1',
    host: '127.0.0.1',
    port: String(server.port),
    hostKey: server.hostKey,
    rootPath: 'public_html',
    username: 'site',
    auth: 'password',
    password: 'p@ss word',
    ...overrides,
  })
}

beforeAll(async () => {
  server = await startTestSftpServer({
    files,
    // `hollow`: a root whose marker folders hold no file at all.
    directories: ['public_html/empty', 'hollow/wp-content', 'hollow/wp-includes'],
    links: { 'public_html/linked': '/other' },
    listLinksAsTargets: true,
    deniedPaths: ['public_html/private', 'public_html/private/secret.txt'],
    home: '/',
    users: [
      { username: 'site', password: 'p@ss word' },
      { username: 'keyed', publicKey: userKey.publicKey },
      { username: 'locked', publicKey: lockedKey.publicKey },
    ],
  })
  address = await pin('127.0.0.1')
})

afterAll(async () => {
  await server.close()
})

describe('sftpSource.check', () => {
  it('without a host key logs in nowhere and answers the key the server presented', async () => {
    const attempts = server.authAttempts.length
    const outcome = await sftpSource.check(input({ hostKey: undefined }), context())
    expect(outcome).toEqual({ ok: false, reason: 'host_key_unknown', hostKey: server.hostKey })
    expect(server.hostKey).toMatch(/^ssh-ed25519 SHA256:[A-Za-z0-9+/]{43}$/)
    expect(server.authAttempts.length).toBe(attempts)
  })

  it('refuses to connect without a key where one is required', async () => {
    const attempts = server.authAttempts.length
    const outcome = await sftpSource.check(
      input({ hostKey: undefined }),
      context({ pinRequired: true }),
    )
    expect(outcome).toEqual({ ok: false, reason: 'host_key_changed' })
    expect(server.authAttempts.length).toBe(attempts)
  })

  it('answers another key with host_key_changed and the key presented, before any login', async () => {
    const attempts = server.authAttempts.length
    const outcome = await sftpSource.check(input({ hostKey: otherHostKey.fingerprint }), context())
    expect(outcome).toEqual({ ok: false, reason: 'host_key_changed', hostKey: server.hostKey })
    expect(server.authAttempts.length).toBe(attempts)
  })

  it('names RSA and ECDSA host keys by their key type', async () => {
    for (const type of ['rsa', 'ecdsa'] as const) {
      const key = generateTestSshKey({ type })
      const other = await startTestSftpServer({
        files,
        hostKeyPem: key.privateKey,
        users: [{ username: 'site', password: 'p@ss word' }],
      })
      try {
        expect(other.hostKey).toBe(key.fingerprint)
        expect(key.fingerprint).toMatch(
          type === 'rsa' ? /^ssh-rsa SHA256:/ : /^ecdsa-sha2-nistp256 SHA256:/,
        )
        const outcome = await sftpSource.check(
          input({ port: other.port, hostKey: undefined }),
          context(),
        )
        expect(outcome).toEqual({ ok: false, reason: 'host_key_unknown', hostKey: key.fingerprint })
        const pinned = await sftpSource.check(
          input({ port: other.port, hostKey: key.fingerprint }),
          context(),
        )
        expect(pinned).toMatchObject({ ok: true, hostKey: key.fingerprint })
      } finally {
        await other.close()
      }
    }
  })

  it('passes with the confirmed key and a password', async () => {
    const outcome = await sftpSource.check(input(), context())
    expect(outcome).toEqual({
      ok: true,
      hostKey: server.hostKey,
      canonicalUrl: null,
      defaultBranch: null,
      entries: 6,
    })
    expect(server.writeAttempts).toEqual([])
  })

  it('passes with a private key, and with an encrypted one and its passphrase', async () => {
    const plain = await sftpSource.check(
      input({ username: 'keyed', auth: { method: 'key', privateKey: userKey.privateKey } }),
      context(),
    )
    expect(plain).toMatchObject({ ok: true })
    const locked = await sftpSource.check(
      input({
        username: 'locked',
        auth: { method: 'key', privateKey: lockedKey.privateKey, passphrase: 'correct horse' },
      }),
      context(),
    )
    expect(locked).toMatchObject({ ok: true })
  })

  it('answers key_invalid for a key it cannot read, without contacting the server', async () => {
    const attempts = server.authAttempts.length
    const cases = [
      { method: 'key', privateKey: lockedKey.privateKey, passphrase: 'wrong' },
      { method: 'key', privateKey: lockedKey.privateKey },
      { method: 'key', privateKey: 'not a key' },
      { method: 'key', privateKey: userKey.publicKey },
    ]
    for (const auth of cases) {
      const outcome = await sftpSource.check(input({ username: 'locked', auth }), context())
      expect(outcome).toEqual({ ok: false, reason: 'key_invalid' })
    }
    expect(server.authAttempts.length).toBe(attempts)
  })

  it('refuses a key whose KDF asks for more rounds at once, before ssh2 spends one', async () => {
    const attempts = server.authAttempts.length
    // About 13 ms a round in ssh2: these would hold the process for hours.
    const costly = withKdfRounds(lockedKey.privateKey, 1 << 20)
    const started = performance.now()
    const outcome = await sftpSource.check(
      input({
        username: 'locked',
        auth: { method: 'key', privateKey: costly, passphrase: 'correct horse' },
      }),
      context(),
    )
    expect(outcome).toEqual({ ok: false, reason: 'key_invalid' })
    expect(performance.now() - started).toBeLessThan(200)
    expect(server.authAttempts.length).toBe(attempts)
  })

  it('answers auth_failed for a wrong password and for a key the server does not know', async () => {
    expect(
      await sftpSource.check(input({ auth: { method: 'password', password: 'nope' } }), context()),
    ).toEqual({
      ok: false,
      reason: 'auth_failed',
    })
    const stranger = generateTestSshKey()
    expect(
      await sftpSource.check(
        input({ username: 'keyed', auth: { method: 'key', privateKey: stranger.privateKey } }),
        context(),
      ),
    ).toEqual({ ok: false, reason: 'auth_failed' })
  })

  it('answers not_found for a folder that does not exist or is a file', async () => {
    expect(await sftpSource.check(input({ rootPath: '/missing' }), context())).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(await sftpSource.check(input({ rootPath: 'public_html/index.php' }), context())).toEqual(
      {
        ok: false,
        reason: 'not_found',
      },
    )
  })

  it('suggests the folder one level down that holds the site', async () => {
    expect(await sftpSource.check(input({ rootPath: '/' }), context())).toEqual({
      ok: false,
      reason: 'not_site_root',
      suggestedRoot: '/public_html',
    })
    expect(await sftpSource.check(input({ rootPath: 'other' }), context())).toEqual({
      ok: false,
      reason: 'not_site_root',
    })
  })

  it('reads at most 4 KiB of a file to prove reading', async () => {
    const before = server.bytesServed()
    const outcome = await sftpSource.check(input({ rootPath: 'large' }), context())
    expect(outcome).toMatchObject({ ok: true, entries: 3 })
    expect(server.bytesServed() - before).toBeLessThanOrEqual(4096)
    expect(server.bytesServed() - before).toBeGreaterThan(0)
  })

  it('reads a file of a marker folder where the root has none, and fails where nothing can be read', async () => {
    const before = server.bytesServed()
    expect(await sftpSource.check(input({ rootPath: 'bare' }), context())).toEqual({
      ok: true,
      hostKey: server.hostKey,
      canonicalUrl: null,
      defaultBranch: null,
      entries: 2,
    })
    expect(server.bytesServed() - before).toBe(files['bare/wp-content/index.php'].length)
    expect(await sftpSource.check(input({ rootPath: 'hollow' }), context())).toEqual({
      ok: false,
      reason: 'transfer_failed',
    })
  })

  it('accepts a password through keyboard-interactive', async () => {
    const strict = await startTestSftpServer({
      files,
      keyboardInteractiveOnly: true,
      users: [{ username: 'site', password: 'p@ss word' }],
    })
    try {
      const outcome = await sftpSource.check(
        input({ port: strict.port, hostKey: strict.hostKey }),
        context(),
      )
      expect(outcome).toMatchObject({ ok: true })
      expect(strict.authAttempts.map(({ method }) => method)).toEqual([
        'password',
        'keyboard-interactive',
      ])
    } finally {
      await strict.close()
    }
  })

  it('answers unreachable for a closed port and for a server that never speaks', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const closedPort = (closed.address() as { port: number }).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    expect(await sftpSource.check(input({ port: closedPort }), context())).toEqual({
      ok: false,
      reason: 'unreachable',
    })

    const silent: Server = createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    try {
      const started = Date.now()
      const outcome = await sftpSource.check(
        input({ port: (silent.address() as { port: number }).port }),
        context({ signal: AbortSignal.timeout(300) }),
      )
      expect(outcome).toEqual({ ok: false, reason: 'unreachable' })
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      silent.close()
    }
  })

  it('settles promptly when its signal aborts during a stalled read', async () => {
    const stalled = await startTestSftpServer({
      files,
      stallReads: true,
      users: [{ username: 'site', password: 'p@ss word' }],
    })
    try {
      const controller = new AbortController()
      const pending = sftpSource.check(input({ port: stalled.port, hostKey: stalled.hostKey }), {
        ...context(),
        signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 300)
      const started = Date.now()
      expect(await pending).toEqual({ ok: false, reason: 'unreachable' })
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await stalled.close()
    }
  })
})

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (isSiteConnectionError(error)) return `connection:${error.reason}`
    if (isFileSourceGuardError(error)) return `guard:${error.guard}`
    throw error
  }
  return 'resolved'
}

describe('sftpSource.open', () => {
  it('lists, reads and confirms where it is, through the pinned key only', async () => {
    const session = await sftpSource.open(access(), {
      address,
      signal: AbortSignal.timeout(20_000),
    })
    try {
      expect(session.concurrency).toBe(4)
      const root = await session.list([], 100)
      expect(root.map(({ name, type }) => `${type}:${name}`)).toEqual([
        'directory:empty',
        'file:index.php',
        'directory:linked',
        'directory:private',
        'directory:wp-content',
        'directory:wp-includes',
      ])
      expect(root.every(({ name, ref }) => name === ref)).toBe(true)
      expect(await session.list(['empty'], 10)).toEqual([])

      const chunks: Buffer[] = []
      const bytes = await session.read(
        ['wp-content', 'uploads', 'big.bin'],
        async (chunk) => {
          chunks.push(Buffer.from(chunk))
          await new Promise((resolve) => setImmediate(resolve))
        },
        BIG.length,
      )
      expect(bytes).toBe(BIG.length)
      const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
      expect(digest(Buffer.concat(chunks))).toBe(digest(BIG))

      const small: Buffer[] = []
      await session.read(['index.php'], async (chunk) => void small.push(Buffer.from(chunk)), 1024)
      expect(Buffer.concat(small).toString()).toBe(files['public_html/index.php'])
    } finally {
      await session.close()
    }
    expect(server.writeAttempts).toEqual([])
  })

  it('trips its guards and maps the server statuses', async () => {
    const session = await sftpSource.open(access(), {
      address,
      signal: AbortSignal.timeout(20_000),
    })
    try {
      expect(await reasonOf(session.list(['linked'], 100))).toBe('guard:outside_root')
      expect(await reasonOf(session.list(['..'], 100))).toBe('guard:outside_root')
      expect(await reasonOf(session.list([], 2))).toBe('guard:entries')
      expect(
        await reasonOf(
          session.read(['wp-content', 'uploads', 'big.bin'], async () => {}, BIG.length - 1),
        ),
      ).toBe('guard:bytes')
      expect(await reasonOf(session.read(['missing.php'], async () => {}, 100))).toBe(
        'connection:not_found',
      )
      expect(await reasonOf(session.read(['private', 'secret.txt'], async () => {}, 100))).toBe(
        'connection:access_denied',
      )
      // A folder the root listed that the server refuses to open, and one that is gone.
      expect(await reasonOf(session.list(['private'], 100))).toBe('connection:access_denied')
      expect(await reasonOf(session.list(['gone'], 100))).toBe('connection:not_found')
      // The session is still usable after each guard.
      expect((await session.list(['wp-includes'], 10)).map(({ name }) => name)).toEqual([
        'version.php',
      ])
    } finally {
      await session.close()
    }
  })

  it('hands back an error of the sink unchanged', async () => {
    const session = await sftpSource.open(access(), {
      address,
      signal: AbortSignal.timeout(20_000),
    })
    const mine = new Error('disk full')
    try {
      await expect(
        session.read(
          ['index.php'],
          async () => {
            throw mine
          },
          1024,
        ),
      ).rejects.toBe(mine)
    } finally {
      await session.close()
    }
  })

  it('caps a listing by its bytes', async () => {
    const tight = createSftpSource({ listingBytes: 300 })
    const session = await tight.open(access(), { address, signal: AbortSignal.timeout(20_000) })
    try {
      expect(await reasonOf(session.list([], 100))).toBe('guard:listing')
    } finally {
      await session.close()
    }
  })

  it('accepts no other host key and no unreadable private key', async () => {
    expect(
      await reasonOf(
        sftpSource.open(access({ hostKey: otherHostKey.fingerprint }), {
          address,
          signal: AbortSignal.timeout(10_000),
        }),
      ),
    ).toBe('connection:host_key_changed')
    expect(
      await reasonOf(
        sftpSource.open(
          sshAccessSchema.parse({
            v: '1',
            host: '127.0.0.1',
            port: String(server.port),
            hostKey: server.hostKey,
            rootPath: 'public_html',
            username: 'keyed',
            auth: 'key',
            privateKey: 'garbage',
          }),
          { address, signal: AbortSignal.timeout(10_000) },
        ),
      ),
    ).toBe('connection:key_invalid')
  })

  it('refuses at open a stored key whose KDF asks for more rounds, before ssh2 spends one', async () => {
    const attempts = server.authAttempts.length
    const started = performance.now()
    expect(
      await reasonOf(
        sftpSource.open(
          sshAccessSchema.parse({
            v: '1',
            host: '127.0.0.1',
            port: String(server.port),
            hostKey: server.hostKey,
            rootPath: 'public_html',
            username: 'locked',
            auth: 'key',
            privateKey: withKdfRounds(lockedKey.privateKey, 1 << 20),
            passphrase: 'correct horse',
          }),
          { address, signal: AbortSignal.timeout(10_000) },
        ),
      ),
    ).toBe('connection:key_invalid')
    expect(performance.now() - started).toBeLessThan(200)
    expect(server.authAttempts.length).toBe(attempts)
  })

  it('fails a stalled read as transfer_failed after the idle bound, and ends with its signal', async () => {
    const stalled = await startTestSftpServer({
      files,
      stallReads: true,
      users: [{ username: 'site', password: 'p@ss word' }],
    })
    try {
      // A short idle bound for the stalled read only: a busy runner may take longer to log in.
      const quick = createSftpSource({ idleMs: 200, readyTimeoutMs: 20_000 })
      const stalledAccess = access({ port: String(stalled.port), hostKey: stalled.hostKey })
      const session = await quick.open(stalledAccess, {
        address,
        signal: AbortSignal.timeout(20_000),
      })
      expect(await reasonOf(session.read(['index.php'], async () => {}, 100))).toBe(
        'connection:transfer_failed',
      )
      await session.close()

      const controller = new AbortController()
      const aborted = await sftpSource.open(stalledAccess, { address, signal: controller.signal })
      const pending = reasonOf(aborted.read(['index.php'], async () => {}, 100))
      setTimeout(() => controller.abort(), 100)
      expect(await pending).toBe('connection:transfer_failed')
      expect(await reasonOf(aborted.list([], 10))).toBe('connection:transfer_failed')
      await aborted.close()
    } finally {
      await stalled.close()
    }
  })
})

describe('sftpSource records', () => {
  const passed = (hostKey: string | null) => ({
    hostKey,
    canonicalUrl: null,
    defaultBranch: null,
    entries: 3,
  })

  it('prepares the secret and the row of a password access', () => {
    const prepared = sftpSource.prepare(input(), passed(server.hostKey))
    expect(prepared.accessKind).toBe('ssh')
    expect(prepared.secret).toEqual({
      v: '1',
      host: '127.0.0.1',
      port: String(server.port),
      hostKey: server.hostKey,
      rootPath: 'public_html',
      username: 'site',
      auth: 'password',
      password: 'p@ss word',
    })
    expect(sshAccessSchema.safeParse(prepared.secret).success).toBe(true)
    expect(prepared.target).toEqual({
      kind: 'sftp',
      host: '127.0.0.1',
      port: server.port,
      rootPath: 'public_html',
      repositoryUrl: null,
      branch: null,
      tls: null,
      hostKey: server.hostKey,
    })
    const stored = sshAccessSchema.parse(prepared.secret)
    expect(sftpSource.matchesTarget(stored, prepared.target)).toBe(true)
    for (const changed of [
      { host: 'example.com' },
      { port: 2222 },
      { rootPath: '/' },
      { hostKey: otherHostKey.fingerprint },
      { tls: 'verified' as const },
      { kind: 'ftp' as const },
    ]) {
      expect(sftpSource.matchesTarget(stored, { ...prepared.target, ...changed })).toBe(false)
    }
    expect(sftpSource.scanValues(stored)).toEqual(['p@ss word'])
    expect(sftpSource.endpoint(input())).toEqual({ host: '127.0.0.1', port: server.port })
    expect(sftpSource.endpointOf(stored)).toEqual({ host: '127.0.0.1', port: server.port })
  })

  it('prepares a key access with its passphrase, and scans the key and its lines', () => {
    const prepared = sftpSource.prepare(
      input({
        username: 'locked',
        auth: { method: 'key', privateKey: lockedKey.privateKey, passphrase: 'correct horse' },
      }),
      passed(server.hostKey),
    )
    const stored = sshAccessSchema.parse(prepared.secret)
    expect(stored).toMatchObject({ auth: 'key', passphrase: 'correct horse' })
    const values = sftpSource.scanValues(stored)
    expect(values[0]).toBe(lockedKey.privateKey.trim())
    expect(values).toContain('correct horse')
    expect(new Set(values).size).toBe(values.length)
    expect(values.slice(1).every((value) => value !== '' && !value.startsWith('-----'))).toBe(true)

    const bare = sftpSource.prepare(
      input({ username: 'keyed', auth: { method: 'key', privateKey: userKey.privateKey } }),
      passed(server.hostKey),
    )
    expect('passphrase' in bare.secret).toBe(false)
  })

  it('refuses to prepare without the host key of a passed check, or for another kind', () => {
    expect(() => sftpSource.prepare(input(), passed(null))).toThrow()
    expect(() => sftpSource.prepare(input(), passed('ssh-ed25519 nope'))).toThrow()
    const ftp = { ...input(), kind: 'ftp' } as unknown as CodeSourceInput
    expect(() => sftpSource.prepare(ftp, passed(server.hostKey))).toThrow()
  })
})
