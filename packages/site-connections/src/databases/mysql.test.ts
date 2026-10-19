import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { createSecureContext, TLSSocket } from 'node:tls'

import type { ConnectionOptions } from 'mysql2'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  dbAccessSchema,
  resolvePinnedAddress,
  type DatabaseInput,
  type PinnedAddress,
} from '@repo/domain'

import {
  createTestCertificates,
  type TestCertificate,
  type TestCertificates,
} from '../testing/certificates.ts'
import { BoundedSocket } from './bounded-socket.ts'
import { databaseInspector, mysqlInspector } from './index.ts'
import { createMysqlInspector, mysqlStatements, type MysqlConnectionLike } from './mysql.ts'

async function pin(host: string): Promise<PinnedAddress> {
  const result = await resolvePinnedAddress(
    { appEnv: 'development', lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    host,
    new AbortController().signal,
  )
  if (!result.ok) throw new Error(`cannot pin ${host}`)
  return result.address
}

function input(overrides: Partial<DatabaseInput> = {}): DatabaseInput {
  return {
    engine: 'mysql',
    host: 'localhost',
    port: 3306,
    database: 'wordpress',
    username: 'reader',
    password: 'p@ss',
    tls: 'verified',
    ...overrides,
  }
}

function serverError(errno: number): Error {
  return Object.assign(new Error(`server says ${errno}`), {
    errno,
    sqlState: 'HY000',
    code: 'ER_SOMETHING',
  })
}

function scripted(script: { connect?: Error; failOn?: [string, Error]; tables?: unknown } = {}) {
  const configs: ConnectionOptions[] = []
  const sent: string[] = []
  let ended = false
  const factory = (config: ConnectionOptions): MysqlConnectionLike => {
    configs.push(config)
    return {
      connect: (callback) => queueMicrotask(() => callback(script.connect ?? null)),
      query: (sql, callback) => {
        sent.push(sql)
        queueMicrotask(() => {
          if (script.failOn && sql === script.failOn[0])
            return callback(script.failOn[1], undefined)
          if (sql === mysqlStatements.count)
            return callback(null, [{ tables: 'tables' in script ? script.tables : 7 }])
          // START TRANSACTION and ROLLBACK answer a header, not rows.
          callback(null, { affectedRows: 0 })
        })
      },
      end: (callback) => {
        ended = true
        callback()
      },
      on: () => {},
    }
  }
  return { factory, configs, sent, ended: () => ended }
}

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function fakeServer(onConnection: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    socket.on('error', () => {})
    onConnection(socket)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

/** A HandshakeV10 greeting; with `tls`, of a server that offers CLIENT_SSL. */
function greeting(tls = false): Buffer {
  const capabilities =
    0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0200 | 0x2000 | 0x8000 | 0x80000 | (tls ? 0x0800 : 0)
  const scramble = Buffer.from('abcdefghijklmnopqrst')
  const payload = Buffer.concat([
    Buffer.from([0x0a]),
    Buffer.from('8.4.0-fake\0'),
    Buffer.from([1, 0, 0, 0]),
    scramble.subarray(0, 8),
    Buffer.from([0]),
    Buffer.from([capabilities & 0xff, (capabilities >> 8) & 0xff]),
    Buffer.from([0xff]),
    Buffer.from([0x02, 0x00]),
    Buffer.from([(capabilities >> 16) & 0xff, (capabilities >> 24) & 0xff]),
    Buffer.from([21]),
    Buffer.alloc(10),
    scramble.subarray(8),
    Buffer.from([0]),
    Buffer.from('mysql_native_password\0'),
  ])
  const header = Buffer.from([
    payload.length & 0xff,
    (payload.length >> 8) & 0xff,
    (payload.length >> 16) & 0xff,
    0,
  ])
  return Buffer.concat([header, payload])
}

/** The SSLRequest a client sends before its ClientHello: a 4-byte header and 32 bytes. */
const SSL_REQUEST_BYTES = 36

/**
 * After the SSLRequest, the server side of a TLS handshake with `certificate`, over a stream of its own:
 * the ClientHello may arrive in the same read as the request.
 */
function answerTls(socket: Socket, certificate: TestCertificate): void {
  let pending = Buffer.alloc(0)
  let upgraded = false
  const inner = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      socket.write(chunk, callback)
    },
  })
  socket.on('data', (chunk: Buffer) => {
    if (upgraded) return void inner.push(chunk)
    pending = Buffer.concat([pending, chunk])
    if (pending.length < SSL_REQUEST_BYTES) return
    upgraded = true
    const tls = new TLSSocket(inner, {
      isServer: true,
      secureContext: createSecureContext(certificate),
    })
    tls.on('error', () => {})
    const rest = pending.subarray(SSL_REQUEST_BYTES)
    if (rest.length > 0) inner.push(rest)
  })
  socket.on('end', () => inner.push(null))
}

let certificates: TestCertificates | null = null
beforeAll(async () => {
  certificates = await createTestCertificates()
})

describe('mysqlInspector.check with a scripted connection', () => {
  it('hands mysql2 its own socket and the TLS name, and sends only the catalog statements', async () => {
    const fake = scripted({ tables: 7 })
    const inspector = createMysqlInspector({ createConnection: fake.factory })
    const outcome = await inspector.check(input(), {
      address: await pin('localhost'),
      signal: AbortSignal.timeout(5_000),
    })
    expect(outcome).toEqual({ ok: true, tables: 7 })
    const [config] = fake.configs
    expect(config).toMatchObject({
      host: 'localhost',
      port: 3306,
      user: 'reader',
      password: 'p@ss',
      database: 'wordpress',
      ssl: { rejectUnauthorized: true, verifyIdentity: true },
      flags: ['-LOCAL_FILES'],
      multipleStatements: false,
    })
    expect(config?.stream).toBeInstanceOf(BoundedSocket)
    expect(config?.enableCleartextPlugin).toBeUndefined()
    expect(config?.authPlugins).toBeUndefined()
    expect(fake.sent).toEqual([
      'START TRANSACTION READ ONLY',
      'SELECT 1',
      mysqlStatements.count,
      'ROLLBACK',
    ])
    expect(mysqlStatements.count).toMatch(
      /FROM information_schema\.TABLES WHERE TABLE_SCHEMA = DATABASE\(\)/,
    )
    expect(fake.ended()).toBe(true)
  })

  it('names an IP literal by the literal, and maps the modes without falling back', async () => {
    const literal = await pin('127.0.0.1')
    for (const [tls, ssl] of [
      ['verified', { rejectUnauthorized: true, verifyIdentity: true }],
      ['unverified', { rejectUnauthorized: false, verifyIdentity: false }],
      ['plain', undefined],
    ] as const) {
      const fake = scripted()
      await createMysqlInspector({ createConnection: fake.factory }).check(
        input({ tls, host: '127.0.0.1' }),
        {
          address: literal,
          signal: AbortSignal.timeout(5_000),
        },
      )
      expect(fake.configs[0]?.host).toBe('127.0.0.1')
      expect(fake.configs[0]?.ssl).toEqual(ssl)
    }
  })

  it('maps the server and client failures of the login to coarse reasons', async () => {
    const cases: Array<[Error, string, DatabaseInput['tls']?]> = [
      [serverError(1045), 'auth_failed'],
      [serverError(1044), 'access_denied'],
      [serverError(1049), 'not_found'],
      [serverError(1130), 'host_not_allowed'],
      [serverError(1129), 'host_not_allowed'],
      [serverError(3159), 'tls_required'],
      [serverError(1040), 'unreachable'],
      [serverError(1251), 'unsupported'],
      [serverError(9999), 'unsupported'],
      [
        Object.assign(new Error('no tls'), { code: 'HANDSHAKE_NO_SSL_SUPPORT', fatal: true }),
        'tls_unavailable',
      ],
      [
        Object.assign(new Error('clear'), { code: 'MYSQL_CLEAR_PASSWORD_NOT_ENABLED' }),
        'unsupported',
      ],
      [Object.assign(new Error('refused'), { code: 'ECONNREFUSED', errno: -61 }), 'unreachable'],
      [
        Object.assign(new Error('cert'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
        'certificate_untrusted',
      ],
      [
        Object.assign(new Error('tls'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }),
        'tls_unavailable',
      ],
      // mysql2's rewrite of a failed handshake: a certificate only with a sign of one.
      [
        Object.assign(new Error('cut'), { code: 'HANDSHAKE_SSL_ERROR', fatal: true }),
        'tls_unavailable',
      ],
      [
        Object.assign(new Error('identity'), {
          code: 'HANDSHAKE_SSL_ERROR',
          cert: {},
          fatal: true,
        }),
        'certificate_untrusted',
      ],
      [
        Object.assign(new Error('identity'), { code: 'HANDSHAKE_SSL_ERROR', cert: {} }),
        'tls_unavailable',
        'unverified',
      ],
    ]
    for (const [error, reason, tls] of cases) {
      const fake = scripted({ connect: error })
      const outcome = await createMysqlInspector({ createConnection: fake.factory }).check(
        input({ tls: tls ?? 'verified' }),
        {
          address: await pin('localhost'),
          signal: AbortSignal.timeout(5_000),
        },
      )
      expect(outcome, error.message).toEqual({ ok: false, reason })
      expect(fake.sent).toEqual([])
    }
  })

  it('maps a failed statement and reads a count given as digits', async () => {
    const denied = scripted({ failOn: [mysqlStatements.count, serverError(1142)] })
    expect(
      await createMysqlInspector({ createConnection: denied.factory }).check(input(), {
        address: await pin('localhost'),
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ ok: false, reason: 'access_denied' })
    const digits = scripted({ tables: '15' })
    expect(
      await createMysqlInspector({ createConnection: digits.factory }).check(input(), {
        address: await pin('localhost'),
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ ok: true, tables: 15 })
  })
})

describe('mysqlInspector.check with the real driver', () => {
  it('answers tls_unavailable for a server that does not offer TLS', async () => {
    const port = await fakeServer((socket) => socket.write(greeting()))
    expect(
      await mysqlInspector.check(input({ host: '127.0.0.1', port }), {
        address: await pin('127.0.0.1'),
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ ok: false, reason: 'tls_unavailable' })
  })

  it('answers tls_unavailable, never a certificate, when the server cuts the TLS handshake', async () => {
    for (const cut of ['end', 'destroy'] as const) {
      const port = await fakeServer((socket) => {
        socket.write(greeting(true))
        socket.once('data', () => (cut === 'end' ? socket.end() : socket.destroy()))
      })
      for (const tls of ['verified', 'unverified'] as const) {
        expect(
          await mysqlInspector.check(input({ host: '127.0.0.1', port, tls }), {
            address: await pin('127.0.0.1'),
            signal: AbortSignal.timeout(5_000),
          }),
          `${cut} ${tls}`,
        ).toEqual({ ok: false, reason: 'tls_unavailable' })
      }
    }
  })

  it('answers certificate_untrusted for a certificate that does not verify, or not for the address', async (test) => {
    if (!certificates) return test.skip()
    const trusted = createMysqlInspector({ trust: { ca: certificates.ca } })
    // Another CA; then the CA trusted, but a certificate for `localhost` at the literal.
    for (const certificate of [certificates.foreign, certificates.dnsOnly]) {
      const port = await fakeServer((socket) => {
        socket.write(greeting(true))
        answerTls(socket, certificate)
      })
      expect(
        await trusted.check(input({ host: '127.0.0.1', port }), {
          address: await pin('127.0.0.1'),
          signal: AbortSignal.timeout(5_000),
        }),
      ).toEqual({ ok: false, reason: 'certificate_untrusted' })
    }
  })

  it('stops reading at checkReceivedBytes', async () => {
    const port = await fakeServer((socket) => {
      // A packet header announcing 16 MiB, then more than the cap of it.
      socket.write(
        Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0x00]), Buffer.alloc(300 * 1024, 0x41)]),
      )
    })
    expect(
      await mysqlInspector.check(input({ host: '127.0.0.1', port, tls: 'plain' }), {
        address: await pin('127.0.0.1'),
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ ok: false, reason: 'transfer_failed' })
  })

  it('settles with its signal against a server that never speaks', async () => {
    const port = await fakeServer(() => {})
    const begun = Date.now()
    expect(
      await mysqlInspector.check(input({ host: '127.0.0.1', port }), {
        address: await pin('127.0.0.1'),
        signal: AbortSignal.timeout(300),
      }),
    ).toEqual({ ok: false, reason: 'unreachable' })
    expect(Date.now() - begun).toBeLessThan(2_000)
  })
})

describe('mysqlInspector records', () => {
  it('prepares the secret and the row, and is the inspector of its engine', () => {
    const prepared = mysqlInspector.prepare(input({ tls: 'unverified' }))
    expect(prepared.secret).toEqual({
      v: '1',
      engine: 'mysql',
      host: 'localhost',
      port: '3306',
      tls: 'unverified',
      database: 'wordpress',
      username: 'reader',
      password: 'p@ss',
    })
    const stored = dbAccessSchema.parse(prepared.secret)
    expect(mysqlInspector.matchesTarget(stored, prepared.target)).toBe(true)
    expect(mysqlInspector.matchesTarget(stored, { ...prepared.target, tls: 'verified' })).toBe(
      false,
    )
    expect(mysqlInspector.scanValues(stored)).toEqual(['p@ss'])
    expect(databaseInspector('mysql')).toBe(mysqlInspector)
    expect(mysqlInspector).toMatchObject({ engine: 'mysql', accessKind: 'db', defaultPort: 3306 })
  })
})
