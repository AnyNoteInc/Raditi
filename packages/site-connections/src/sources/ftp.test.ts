import { createHash } from 'node:crypto'
import { createServer, type AddressInfo, type Server } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ftpAccessSchema,
  isFileSourceGuardError,
  isSiteConnectionError,
  resolvePinnedAddress,
  type CodeSourceInput,
  type ConnectionTls,
  type FtpAccess,
  type PinnedAddress,
  type SourceCheckContext,
} from '@repo/domain'

import {
  createTestCertificates,
  startTestFtpServer,
  type TestCertificates,
  type TestFtpServer,
  type TestFtpServerOptions,
} from '../testing/index.ts'
import {
  createFtpSource,
  decodeServerName,
  epsvPort,
  ftpSource,
  parsePwdReply,
  pasvPort,
  rawFromTyped,
} from './ftp.ts'

const MARKERS = ['wp-content', 'wp-includes']
const BIG = Buffer.alloc(512 * 1024 + 777)
for (let index = 0; index < BIG.length; index += 1) BIG[index] = (index * 17 + 3) % 253

const files = {
  'public_html/index.php': '<?php require "wp-blog-header.php";',
  'public_html/wp-includes/version.php': '<?php $wp_version = "6.9";',
  'public_html/wp-content/themes/site/style.css': 'body {}',
  'public_html/wp-content/uploads/big.bin': BIG,
  'public_html/private/secret.txt': 'no',
  'public_html/Файл.txt': 'utf-8 name',
  'other/readme.txt': 'not a site',
  // A root with folders only: the check reads a file of a marker folder.
  'bare/wp-content/index.php': '<?php // Silence is golden.',
  'bare/wp-includes/version.php': '<?php $wp_version = "6.9";',
}
const shared = {
  files,
  // A root whose marker folders hold no file at all: nothing to read.
  directories: ['hollow/wp-content', 'hollow/wp-includes'],
  links: { 'public_html/linked': '/other' },
  listLinksAsTargets: true,
  deniedPaths: ['public_html/private', 'public_html/wp-content/themes/site/style.css'],
  username: 'site',
  password: 'пароль 1',
} satisfies Partial<TestFtpServerOptions>

let certificates: TestCertificates | null
let loopback: PinnedAddress
let localhost: PinnedAddress
const started: TestFtpServer[] = []

async function pin(host: string): Promise<PinnedAddress> {
  const result = await resolvePinnedAddress(
    { appEnv: 'development', lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    host,
    new AbortController().signal,
  )
  if (!result.ok) throw new Error(`cannot pin ${host}`)
  return result.address
}

async function start(options: Partial<TestFtpServerOptions> = {}): Promise<TestFtpServer> {
  const server = await startTestFtpServer({ ...shared, ...options } as TestFtpServerOptions)
  started.push(server)
  return server
}

/**
 * A server that answers 220 and then 234 to AUTH TLS, and never says another word: the TLS handshake
 * stalls, which basic-ftp alone never gives up on.
 */
async function stallingTlsServer(): Promise<{ port: number; close(): void }> {
  const server: Server = createServer((socket) => {
    socket.on('error', () => {})
    socket.write('220 ready\r\n')
    socket.once('data', () => socket.write('234 Proceed with negotiation.\r\n'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, close: () => server.close() }
}

function context(
  address: PinnedAddress,
  overrides: Partial<SourceCheckContext> = {},
): SourceCheckContext {
  return {
    address,
    signal: AbortSignal.timeout(10_000),
    markers: MARKERS,
    pinRequired: true,
    ...overrides,
  }
}

function input(
  server: TestFtpServer,
  tls: ConnectionTls,
  overrides: Record<string, unknown> = {},
): CodeSourceInput {
  return {
    kind: 'ftp',
    host: '127.0.0.1',
    port: server.port,
    username: 'site',
    password: 'пароль 1',
    rootPath: 'public_html',
    tls,
    ...overrides,
  } as CodeSourceInput
}

function access(
  server: TestFtpServer,
  tls: ConnectionTls,
  overrides: Partial<Record<string, string>> = {},
): FtpAccess {
  return ftpAccessSchema.parse({
    v: '1',
    host: '127.0.0.1',
    port: String(server.port),
    tls,
    rootPath: 'public_html',
    username: 'site',
    password: 'пароль 1',
    ...overrides,
  })
}

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

beforeAll(async () => {
  certificates = await createTestCertificates()
  loopback = await pin('127.0.0.1')
  localhost = await pin('localhost')
})

afterAll(async () => {
  await Promise.all(started.map((server) => server.close()))
})

describe('replies and names', () => {
  it('reads PWD, EPSV and PASV replies, never the address of a PASV reply', () => {
    expect(parsePwdReply('257 "/home/site" is the current directory')).toBe('/home/site')
    expect(parsePwdReply('257 "/a ""quoted"" b" created')).toBe('/a "quoted" b')
    expect(parsePwdReply('257 no quotes')).toBeNull()
    expect(parsePwdReply('257 "/unterminated')).toBeNull()
    expect(epsvPort('229 Entering Extended Passive Mode (|||6446|)')).toBe(6446)
    expect(epsvPort('229 Entering Extended Passive Mode (!!!21!)')).toBe(21)
    expect(epsvPort('229 (|||70000|)')).toBeNull()
    expect(pasvPort('227 Entering Passive Mode (10,0,0,9,19,137).')).toBe(19 * 256 + 137)
    expect(pasvPort('227 Entering Passive Mode (10,0,0,9,300,1).')).toBeNull()
    expect(pasvPort('227 garbage')).toBeNull()
  })

  it('decodes UTF-8 names and falls back to windows-1251, keeping the raw bytes as the ref', () => {
    const utf8Raw = Buffer.from('Файл', 'utf8').toString('latin1')
    const cp1251Raw = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]).toString('latin1')
    expect(decodeServerName(utf8Raw)).toBe('Файл')
    expect(decodeServerName(cp1251Raw)).toBe('Привет')
    expect(decodeServerName('plain.txt')).toBe('plain.txt')
    // 0x98 has no cp1251 character: it becomes a C1 control, which the import refuses.
    expect(decodeServerName(Buffer.from([0x41, 0x98]).toString('latin1'))).toBe('A\u0098')
    expect(rawFromTyped('Файл')).toBe(utf8Raw)
  })
})

describe('ftpSource.check', () => {
  it('passes without encryption by the explicit choice, with a UTF-8 password', async () => {
    const server = await start()
    const outcome = await ftpSource.check(input(server, 'plain'), context(loopback))
    expect(outcome).toEqual({
      ok: true,
      hostKey: null,
      canonicalUrl: null,
      defaultBranch: null,
      entries: 6,
    })
    expect(server.writeAttempts).toEqual([])
    expect(server.commands).not.toContain('AUTH TLS')
    expect(server.logins()).toBe(1)
  })

  it('answers the coarse reasons of a failed check', async () => {
    const server = await start()
    expect(
      await ftpSource.check(input(server, 'plain', { password: 'wrong' }), context(loopback)),
    ).toEqual({
      ok: false,
      reason: 'auth_failed',
    })
    expect(
      await ftpSource.check(input(server, 'plain', { rootPath: '/missing' }), context(loopback)),
    ).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(
      await ftpSource.check(input(server, 'plain', { rootPath: '/' }), context(loopback)),
    ).toEqual({
      ok: false,
      reason: 'not_site_root',
      suggestedRoot: '/public_html',
    })
    expect(
      await ftpSource.check(input(server, 'plain', { rootPath: 'other' }), context(loopback)),
    ).toEqual({
      ok: false,
      reason: 'not_site_root',
    })
    // TLS asked of a server that offers none: refused before any login, never retried in clear.
    for (const tls of ['verified', 'unverified'] as const) {
      expect(await ftpSource.check(input(server, tls), context(loopback))).toEqual({
        ok: false,
        reason: 'tls_unavailable',
      })
    }
    expect(server.commands.filter((command) => command.startsWith('USER')).length).toBe(4)
  })

  it('reads a file of a marker folder where the root has none, and fails where nothing can be read', async () => {
    const server = await start()
    expect(
      await ftpSource.check(input(server, 'plain', { rootPath: 'bare' }), context(loopback)),
    ).toEqual({ ok: true, hostKey: null, canonicalUrl: null, defaultBranch: null, entries: 2 })
    expect(server.commands).toContain('RETR /bare/wp-content/index.php')
    expect(
      await ftpSource.check(input(server, 'plain', { rootPath: 'hollow' }), context(loopback)),
    ).toEqual({ ok: false, reason: 'transfer_failed' })
  })

  it('answers unreachable for a closed port', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as { port: number }).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const fake = { port } as TestFtpServer
    expect(await ftpSource.check(input(fake, 'plain'), context(loopback))).toEqual({
      ok: false,
      reason: 'unreachable',
    })
  })

  it('lists with LIST where the server has no MLSD', async () => {
    const server = await start({ mlsd: false })
    expect(await ftpSource.check(input(server, 'plain'), context(loopback))).toMatchObject({
      ok: true,
      entries: 6,
    })
    expect(server.commands).toContain('LIST -a')
  })

  it('dials the pinned address whatever a PASV reply names', async () => {
    const server = await start({ epsv: false, pasvAddress: '10.9.8.7' })
    expect(await ftpSource.check(input(server, 'plain'), context(loopback))).toMatchObject({
      ok: true,
    })
    expect(server.commands).toContain('EPSV')
    expect(server.commands).toContain('PASV')
  })

  it('settles promptly when its signal aborts during a stalled transfer', async () => {
    const server = await start({ stallTransfersAfter: 0 })
    const controller = new AbortController()
    const pending = ftpSource.check(
      input(server, 'plain'),
      context(loopback, { signal: controller.signal }),
    )
    setTimeout(() => controller.abort(), 300)
    const begun = Date.now()
    expect(await pending).toEqual({ ok: false, reason: 'unreachable' })
    expect(Date.now() - begun).toBeLessThan(2_000)
  })

  describe('with TLS', () => {
    it('verifies the certificate for the name, encrypts the data, resumes the session', async (test) => {
      if (!certificates) return test.skip()
      const trusted = createFtpSource({ trust: { ca: certificates.ca } })
      const server = await start({
        tls: certificates.dnsOnly,
        requireTls: true,
        requireSessionReuse: true,
      })
      const outcome = await trusted.check(
        input(server, 'verified', { host: 'localhost' }),
        context(localhost),
      )
      expect(outcome).toMatchObject({ ok: true, entries: 6 })
      expect(server.dataConnections.length).toBeGreaterThan(0)
      expect(server.dataConnections.every((data) => data.protected && data.resumed)).toBe(true)
      expect(server.commands).toEqual(expect.arrayContaining(['AUTH TLS', 'PBSZ 0', 'PROT P']))
    })

    it('verifies an IP literal against the literal, never against localhost', async (test) => {
      if (!certificates) return test.skip()
      const trusted = createFtpSource({ trust: { ca: certificates.ca } })
      const forName = await start({ tls: certificates.dnsOnly })
      expect(await trusted.check(input(forName, 'verified'), context(loopback))).toEqual({
        ok: false,
        reason: 'certificate_untrusted',
      })
      const forLiteral = await start({ tls: certificates.ipOnly })
      expect(await trusted.check(input(forLiteral, 'verified'), context(loopback))).toMatchObject({
        ok: true,
      })
    })

    it('trusts no CA of its own in the exported adapter, and no foreign one', async (test) => {
      if (!certificates) return test.skip()
      const server = await start({ tls: certificates.both })
      expect(await ftpSource.check(input(server, 'verified'), context(loopback))).toEqual({
        ok: false,
        reason: 'certificate_untrusted',
      })
      const foreign = await start({ tls: certificates.foreign })
      const trusted = createFtpSource({ trust: { ca: certificates.ca } })
      expect(await trusted.check(input(foreign, 'verified'), context(loopback))).toEqual({
        ok: false,
        reason: 'certificate_untrusted',
      })
      // Without verification by the explicit choice: encrypted all the same.
      expect(await ftpSource.check(input(foreign, 'unverified'), context(loopback))).toMatchObject({
        ok: true,
      })
      expect(foreign.dataConnections.every((data) => data.protected)).toBe(true)
    })

    it('refuses a plain login where the server demands TLS', async (test) => {
      if (!certificates) return test.skip()
      const server = await start({ tls: certificates.both, requireTls: true })
      expect(await ftpSource.check(input(server, 'plain'), context(loopback))).toEqual({
        ok: false,
        reason: 'auth_failed',
      })
      expect(server.commands).not.toContain('PASS ***')
    })

    it('answers tls_required, not a refused login, to 534 for a login without TLS', async (test) => {
      if (!certificates) return test.skip()
      const server = await start({ tls: certificates.both, requireTls: true, requireTlsCode: 534 })
      expect(await ftpSource.check(input(server, 'plain'), context(loopback))).toEqual({
        ok: false,
        reason: 'tls_required',
      })
      expect(server.commands).not.toContain('PASS ***')
      expect(
        await reasonOf(
          ftpSource.open(access(server, 'plain'), {
            address: loopback,
            signal: AbortSignal.timeout(10_000),
          }),
        ),
      ).toBe('connection:tls_required')
    })

    it('settles with its signal while a server stalls the TLS handshake after 234', async () => {
      const stalling = await stallingTlsServer()
      try {
        const fake = { port: stalling.port } as TestFtpServer
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 300)
        const begun = Date.now()
        expect(
          await ftpSource.check(
            input(fake, 'unverified'),
            context(loopback, { signal: controller.signal }),
          ),
        ).toEqual({ ok: false, reason: 'unreachable' })
        expect(Date.now() - begun).toBeLessThan(2_000)
      } finally {
        stalling.close()
      }
    })
  })
})

describe('ftpSource.open', () => {
  it('lists, reads in parallel on its own connections and confirms where it is', async () => {
    const server = await start()
    const session = await ftpSource.open(access(server, 'plain'), {
      address: loopback,
      signal: AbortSignal.timeout(20_000),
    })
    try {
      expect(session.concurrency).toBe(2)
      const root = await session.list([], 100)
      expect(root.map(({ name, type }) => `${type}:${name}`)).toEqual([
        'file:index.php',
        'directory:linked',
        'directory:private',
        'directory:wp-content',
        'directory:wp-includes',
        'file:Файл.txt',
      ])
      const utf8 = root.find(({ name }) => name === 'Файл.txt')
      expect(utf8?.ref).toBe(rawFromTyped('Файл.txt'))

      const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
      const readAll = async (path: string[]) => {
        const chunks: Buffer[] = []
        const bytes = await session.read(
          path,
          async (chunk) => {
            chunks.push(Buffer.from(chunk))
            await new Promise((resolve) => setImmediate(resolve))
          },
          BIG.length,
        )
        return { bytes, data: Buffer.concat(chunks) }
      }
      const [first, second] = await Promise.all([
        readAll(['wp-content', 'uploads', 'big.bin']),
        readAll(['wp-content', 'uploads', 'big.bin']),
      ])
      expect(first.bytes).toBe(BIG.length)
      expect(digest(first.data)).toBe(digest(BIG))
      expect(digest(second.data)).toBe(digest(BIG))
      expect((await readAll([utf8?.ref ?? ''])).data.toString()).toBe('utf-8 name')
      // ftpSessions logins in all: the one of open lists and reads, one more reads beside it.
      expect(server.logins()).toBe(2)
    } finally {
      await session.close()
    }
    expect(server.writeAttempts).toEqual([])
  })

  it('never holds more than ftpSessions control connections, a failed one replaced', async () => {
    const server = await start()
    const session = await ftpSource.open(access(server, 'plain'), {
      address: loopback,
      signal: AbortSignal.timeout(20_000),
    })
    const read = (path: string[]) => session.read(path, async () => {}, BIG.length)
    try {
      const mine = new Error('disk full')
      await expect(
        session.read(
          ['index.php'],
          async () => {
            throw mine
          },
          1024,
        ),
      ).rejects.toBe(mine)
      const results = await Promise.all([
        read(['wp-content', 'uploads', 'big.bin']),
        read(['wp-content', 'uploads', 'big.bin']),
        session.list(['wp-content'], 10),
        read(['index.php']),
        read(['wp-includes', 'version.php']),
        session.list([], 10),
      ])
      expect(results.slice(0, 2)).toEqual([BIG.length, BIG.length])
      expect(results[3]).toBe(files['public_html/index.php'].length)
      // The connection of the failed read was closed, and its place was given again only after the
      // server had let it go: a replacement logged in, and never more than two were open at once.
      expect(server.logins()).toBeGreaterThanOrEqual(2)
      expect(server.peakConnections()).toBeLessThanOrEqual(2)
    } finally {
      await session.close()
    }
  })

  it('tells a refused folder or file from one that is gone', async () => {
    const server = await start()
    const session = await ftpSource.open(access(server, 'plain'), {
      address: loopback,
      signal: AbortSignal.timeout(20_000),
    })
    try {
      expect(await reasonOf(session.list(['private'], 100))).toBe('connection:access_denied')
      expect(await reasonOf(session.list(['gone'], 100))).toBe('connection:not_found')
      expect(
        await reasonOf(
          session.read(['wp-content', 'themes', 'site', 'style.css'], async () => {}, 100),
        ),
      ).toBe('connection:access_denied')
      expect(await reasonOf(session.read(['gone.php'], async () => {}, 100))).toBe(
        'connection:not_found',
      )
      // A clean refusal leaves its connection in step: no login more for any of them.
      expect((await session.list(['wp-includes'], 10)).map(({ name }) => name)).toEqual([
        'version.php',
      ])
      expect(server.logins()).toBe(1)
    } finally {
      await session.close()
    }

    // Without MLST the server cannot say a folder is gone: the refusal stays access_denied.
    const plain = await start({ mlsd: false })
    const old = await ftpSource.open(access(plain, 'plain'), {
      address: loopback,
      signal: AbortSignal.timeout(20_000),
    })
    try {
      expect(await reasonOf(old.list(['gone'], 100))).toBe('connection:access_denied')
      expect(plain.commands.some((command) => command.startsWith('MLST'))).toBe(false)
    } finally {
      await old.close()
    }
  })

  it('gives up a stalled TLS handshake at its idle bound, and settles with its signal', async () => {
    const stalling = await stallingTlsServer()
    const stalled = (port: number) =>
      ftpAccessSchema.parse({
        v: '1',
        host: '127.0.0.1',
        port: String(port),
        tls: 'unverified',
        rootPath: 'public_html',
        username: 'site',
        password: 'пароль 1',
      })
    try {
      const quick = createFtpSource({ idleMs: 300 })
      let begun = Date.now()
      expect(
        await reasonOf(
          quick.open(stalled(stalling.port), {
            address: loopback,
            signal: AbortSignal.timeout(20_000),
          }),
        ),
      ).toBe('connection:tls_unavailable')
      expect(Date.now() - begun).toBeLessThan(2_000)

      const controller = new AbortController()
      setTimeout(() => controller.abort(), 300)
      begun = Date.now()
      expect(
        await reasonOf(
          ftpSource.open(stalled(stalling.port), { address: loopback, signal: controller.signal }),
        ),
      ).toBe('connection:unreachable')
      expect(Date.now() - begun).toBeLessThan(2_000)
    } finally {
      stalling.close()
    }
  })

  it('trips its guards and keeps working after them', async () => {
    const server = await start()
    const session = await ftpSource.open(access(server, 'plain'), {
      address: loopback,
      signal: AbortSignal.timeout(20_000),
    })
    try {
      expect(await reasonOf(session.list(['linked'], 100))).toBe('guard:outside_root')
      expect(await reasonOf(session.list(['..'], 100))).toBe('guard:outside_root')
      expect(await reasonOf(session.list([], 2))).toBe('guard:entries')
      expect(await reasonOf(session.list(['private'], 100))).toBe('connection:access_denied')
      expect(
        await reasonOf(
          session.read(['wp-content', 'uploads', 'big.bin'], async () => {}, BIG.length - 1),
        ),
      ).toBe('guard:bytes')
      expect(await reasonOf(session.read(['missing.php'], async () => {}, 100))).toBe(
        'connection:not_found',
      )
      expect((await session.list(['wp-includes'], 10)).map(({ name }) => name)).toEqual([
        'version.php',
      ])
      const content: Buffer[] = []
      await session.read(
        ['index.php'],
        async (chunk) => void content.push(Buffer.from(chunk)),
        1024,
      )
      expect(Buffer.concat(content).toString()).toBe(files['public_html/index.php'])
    } finally {
      await session.close()
    }
  })

  it('hands back an error of the sink unchanged', async () => {
    const server = await start()
    const session = await ftpSource.open(access(server, 'plain'), {
      address: loopback,
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
    const server = await start()
    const tight = createFtpSource({ listingBytes: 100 })
    const session = await tight.open(access(server, 'plain'), {
      address: loopback,
      signal: AbortSignal.timeout(20_000),
    })
    try {
      expect(await reasonOf(session.list([], 100))).toBe('guard:listing')
    } finally {
      await session.close()
    }
  })

  it('keeps the raw bytes of names in a windows-1251 tree', async () => {
    const cp1251 = (text: string) =>
      Buffer.from([...text].map((character) => character.charCodeAt(0) - 0x350)).toString('latin1')
    const name = `${cp1251('Привет')}.txt`
    const server = await start({
      nameEncoding: 'latin1',
      files: {
        'site/wp-content/a.txt': 'a',
        'site/wp-includes/b.txt': 'b',
        [`site/${name}`]: 'cp1251 name',
      },
      links: {},
      deniedPaths: [],
      password: rawFromTyped('пароль 1'),
    })
    const session = await ftpSource.open(access(server, 'plain', { rootPath: 'site' }), {
      address: loopback,
      signal: AbortSignal.timeout(20_000),
    })
    try {
      const entry = (await session.list([], 10)).find(({ ref }) => ref === name)
      expect(entry?.name).toBe('Привет.txt')
      const content: Buffer[] = []
      await session.read([name], async (chunk) => void content.push(Buffer.from(chunk)), 100)
      expect(Buffer.concat(content).toString()).toBe('cp1251 name')
    } finally {
      await session.close()
    }
  })

  it('reads over TLS on data connections that resume the control session', async (test) => {
    if (!certificates) return test.skip()
    const server = await start({
      tls: certificates.ipOnly,
      requireTls: true,
      requireSessionReuse: true,
    })
    const trusted = createFtpSource({ trust: { ca: certificates.ca } })
    const session = await trusted.open(access(server, 'verified'), {
      address: loopback,
      signal: AbortSignal.timeout(20_000),
    })
    try {
      const chunks: Buffer[] = []
      await session.read(
        ['wp-content', 'uploads', 'big.bin'],
        async (chunk) => void chunks.push(Buffer.from(chunk)),
        BIG.length,
      )
      expect(Buffer.concat(chunks).equals(BIG)).toBe(true)
      expect((await session.list(['wp-content'], 10)).map(({ name }) => name)).toEqual([
        'themes',
        'uploads',
      ])
      expect(server.dataConnections.every((data) => data.protected && data.resumed)).toBe(true)
    } finally {
      await session.close()
    }
  })

  it('fails a stalled read after the idle bound, and ends with its signal', async () => {
    const server = await start({ stallTransfersAfter: 10 })
    const quick = createFtpSource({ idleMs: 300 })
    const session = await quick.open(access(server, 'plain'), {
      address: loopback,
      signal: AbortSignal.timeout(20_000),
    })
    expect(await reasonOf(session.read(['index.php'], async () => {}, 1024))).toBe(
      'connection:transfer_failed',
    )
    await session.close()

    const controller = new AbortController()
    const aborted = await ftpSource.open(access(server, 'plain'), {
      address: loopback,
      signal: controller.signal,
    })
    const pending = reasonOf(aborted.read(['index.php'], async () => {}, 1024))
    setTimeout(() => controller.abort(), 100)
    expect(await pending).toBe('connection:transfer_failed')
    expect(await reasonOf(aborted.list([], 10))).toBe('connection:transfer_failed')
    await aborted.close()
  })

  it('refuses a wrong password at open', async () => {
    const server = await start()
    expect(
      await reasonOf(
        ftpSource.open(access(server, 'plain', { password: 'nope' }), {
          address: loopback,
          signal: AbortSignal.timeout(10_000),
        }),
      ),
    ).toBe('connection:auth_failed')
  })
})

describe('ftpSource records', () => {
  it('prepares the secret and the row, and compares every shared field', async () => {
    const server = await start()
    const prepared = ftpSource.prepare(input(server, 'verified'), {
      hostKey: null,
      canonicalUrl: null,
      defaultBranch: null,
      entries: 7,
    })
    expect(prepared.accessKind).toBe('ftp')
    expect(prepared.secret).toEqual({
      v: '1',
      host: '127.0.0.1',
      port: String(server.port),
      tls: 'verified',
      rootPath: 'public_html',
      username: 'site',
      password: 'пароль 1',
    })
    expect(prepared.target).toEqual({
      kind: 'ftp',
      host: '127.0.0.1',
      port: server.port,
      rootPath: 'public_html',
      repositoryUrl: null,
      branch: null,
      tls: 'verified',
      hostKey: null,
    })
    const stored = ftpAccessSchema.parse(prepared.secret)
    expect(ftpSource.matchesTarget(stored, prepared.target)).toBe(true)
    for (const changed of [
      { host: 'example.com' },
      { port: 2121 },
      { rootPath: '/' },
      { tls: 'plain' as const },
      { hostKey: 'ssh-ed25519 SHA256:x' },
      { kind: 'sftp' as const },
    ]) {
      expect(ftpSource.matchesTarget(stored, { ...prepared.target, ...changed })).toBe(false)
    }
    expect(ftpSource.scanValues(stored)).toEqual(['пароль 1'])
    expect(ftpSource.endpoint(input(server, 'plain'))).toEqual({
      host: '127.0.0.1',
      port: server.port,
    })
    expect(ftpSource.endpointOf(stored)).toEqual({ host: '127.0.0.1', port: server.port })
    expect(() =>
      ftpSource.prepare({ ...input(server, 'plain'), kind: 'sftp' } as unknown as CodeSourceInput, {
        hostKey: null,
        canonicalUrl: null,
        defaultBranch: null,
        entries: null,
      }),
    ).toThrow()
  })
})
