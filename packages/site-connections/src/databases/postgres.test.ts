import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'

import type { ClientConfig } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'

import {
  dbAccessSchema,
  isDomainError,
  resolvePinnedAddress,
  type DatabaseInput,
  type PinnedAddress,
} from '@repo/domain'

import { BoundedSocket } from './bounded-socket.ts'
import {
  createPostgresInspector,
  postgresInspector,
  postgresStatements,
  type PgClientLike,
} from './postgres.ts'

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
    engine: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'site',
    username: 'reader',
    password: 'p@ss',
    tls: 'verified',
    ...overrides,
  }
}

function serverError(code: string): Error {
  return Object.assign(new Error(`server says ${code}`), { code, severity: 'FATAL' })
}

/** A scripted pg client: the configuration it was built with and every statement it was sent. */
function scripted(script: { connect?: Error; failOn?: [string, Error]; tables?: unknown } = {}) {
  const configs: ClientConfig[] = []
  const sent: string[] = []
  let ended = false
  const factory = (config: ClientConfig): PgClientLike => {
    configs.push(config)
    return {
      connect: async () => {
        if (script.connect) throw script.connect
      },
      query: async (sql: string) => {
        sent.push(sql)
        if (script.failOn && sql === script.failOn[0]) throw script.failOn[1]
        if (sql === postgresStatements.count)
          return { rows: [{ tables: 'tables' in script ? script.tables : 42 }] }
        return { rows: [] }
      },
      end: async () => {
        ended = true
      },
      on: () => undefined,
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

describe('postgresInspector.check with a scripted client', () => {
  it('dials the pinned literal, names the server for TLS and sends only the catalog statements', async () => {
    const fake = scripted({ tables: 42 })
    const inspector = createPostgresInspector({ createClient: fake.factory })
    const outcome = await inspector.check(input(), {
      address: await pin('localhost'),
      signal: AbortSignal.timeout(5_000),
    })
    expect(outcome).toEqual({ ok: true, tables: 42 })
    const [config] = fake.configs
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 5432,
      database: 'site',
      user: 'reader',
      password: 'p@ss',
      ssl: { servername: 'localhost', rejectUnauthorized: true },
    })
    expect(typeof config?.stream).toBe('function')
    expect(fake.sent).toEqual([
      'BEGIN TRANSACTION READ ONLY',
      'SELECT 1',
      postgresStatements.count,
      'ROLLBACK',
    ])
    expect(postgresStatements.count).toMatch(
      /FROM pg_catalog\.pg_class c JOIN pg_catalog\.pg_namespace n/,
    )
    expect(fake.ended()).toBe(true)
  })

  it('checks an IP literal against the literal, and maps the modes without falling back', async () => {
    const literal = await pin('127.0.0.1')
    for (const [tls, ssl] of [
      ['verified', { host: '127.0.0.1', rejectUnauthorized: true }],
      ['unverified', { host: '127.0.0.1', rejectUnauthorized: false }],
      ['plain', false],
    ] as const) {
      const fake = scripted()
      await createPostgresInspector({ createClient: fake.factory }).check(
        input({ tls, host: '127.0.0.1' }),
        {
          address: literal,
          signal: AbortSignal.timeout(5_000),
        },
      )
      expect(fake.configs[0]?.ssl).toEqual(ssl)
    }
  })

  it('maps the server and socket failures of the login to coarse reasons', async () => {
    const cases: Array<[Error, string, DatabaseInput['tls']?]> = [
      [serverError('28P01'), 'auth_failed'],
      [serverError('28000'), 'host_not_allowed'],
      [serverError('3D000'), 'not_found'],
      [serverError('42501'), 'access_denied'],
      [serverError('53300'), 'unreachable'],
      [serverError('08006'), 'unreachable'],
      [serverError('XX000'), 'unsupported'],
      [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'unreachable'],
      [
        Object.assign(new Error('cert'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
        'certificate_untrusted',
      ],
      [
        Object.assign(new Error('name'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
        'certificate_untrusted',
      ],
      [Object.assign(new Error('tls'), { code: 'EPROTO' }), 'tls_unavailable'],
      [Object.assign(new Error('tls'), { code: 'EPROTO' }), 'unreachable', 'plain'],
      // A code that looks like a SQLSTATE but comes without a severity is not the server's.
      [Object.assign(new Error('odd'), { code: '28P01' }), 'unreachable'],
    ]
    for (const [error, reason, tls] of cases) {
      const fake = scripted({ connect: error })
      const outcome = await createPostgresInspector({ createClient: fake.factory }).check(
        input({ tls: tls ?? 'verified' }),
        {
          address: await pin('localhost'),
          signal: AbortSignal.timeout(5_000),
        },
      )
      expect(outcome, `${error.message} ${tls ?? ''}`).toEqual({ ok: false, reason })
      expect(fake.sent).toEqual([])
    }
  })

  it('maps a failed statement and refuses a count it cannot read', async () => {
    const denied = scripted({ failOn: [postgresStatements.count, serverError('42501')] })
    expect(
      await createPostgresInspector({ createClient: denied.factory }).check(input(), {
        address: await pin('localhost'),
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ ok: false, reason: 'access_denied' })
    expect(denied.sent).not.toContain('ROLLBACK')

    const broken = scripted({ failOn: ['SELECT 1', new Error('Connection terminated')] })
    expect(
      await createPostgresInspector({ createClient: broken.factory }).check(input(), {
        address: await pin('localhost'),
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ ok: false, reason: 'transfer_failed' })

    for (const tables of ['12', -1, 1.5, null, 'many']) {
      const odd = scripted({ tables })
      const outcome = await createPostgresInspector({ createClient: odd.factory }).check(input(), {
        address: await pin('localhost'),
        signal: AbortSignal.timeout(5_000),
      })
      expect(outcome).toEqual(
        tables === '12' ? { ok: true, tables: 12 } : { ok: false, reason: 'unsupported' },
      )
    }
  })

  it('refuses an input of the other engine', async () => {
    await expect(
      postgresInspector.check(input({ engine: 'mysql' }), {
        address: await pin('localhost'),
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow()
  })
})

describe('postgresInspector.check with the real driver', () => {
  it('answers tls_unavailable when the server refuses the SSLRequest', async () => {
    const port = await fakeServer((socket) => socket.once('data', () => socket.write('N')))
    expect(
      await postgresInspector.check(input({ host: '127.0.0.1', port }), {
        address: await pin('127.0.0.1'),
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ ok: false, reason: 'tls_unavailable' })
  })

  it('stops reading at checkReceivedBytes', async () => {
    const port = await fakeServer((socket) =>
      socket.once('data', () => {
        // An ErrorResponse that announces a megabyte, then more than the cap of it.
        const header = Buffer.from([0x45, 0x00, 0x10, 0x00, 0x00])
        socket.write(Buffer.concat([header, Buffer.alloc(300 * 1024, 0x41)]))
      }),
    )
    expect(
      await postgresInspector.check(input({ host: '127.0.0.1', port, tls: 'plain' }), {
        address: await pin('127.0.0.1'),
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ ok: false, reason: 'transfer_failed' })
  })

  it('answers unreachable for a closed port and settles with its signal', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    expect(
      await postgresInspector.check(input({ host: '127.0.0.1', port: closedPort }), {
        address: await pin('127.0.0.1'),
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ ok: false, reason: 'unreachable' })

    const silent = await fakeServer(() => {})
    const begun = Date.now()
    expect(
      await postgresInspector.check(input({ host: '127.0.0.1', port: silent }), {
        address: await pin('127.0.0.1'),
        signal: AbortSignal.timeout(300),
      }),
    ).toEqual({ ok: false, reason: 'unreachable' })
    expect(Date.now() - begun).toBeLessThan(2_000)
  })
})

describe('postgresInspector records', () => {
  it('prepares the secret and the row, and compares every shared field', () => {
    const prepared = postgresInspector.prepare(input())
    expect(prepared).toEqual({
      accessKind: 'db',
      secret: {
        v: '1',
        engine: 'postgres',
        host: 'localhost',
        port: '5432',
        tls: 'verified',
        database: 'site',
        username: 'reader',
        password: 'p@ss',
      },
      target: {
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
        databaseName: 'site',
        tls: 'verified',
      },
    })
    const stored = dbAccessSchema.parse(prepared.secret)
    expect(postgresInspector.matchesTarget(stored, prepared.target)).toBe(true)
    for (const changed of [
      { host: 'db.example' },
      { port: 6432 },
      { databaseName: 'other' },
      { tls: 'plain' as const },
      { engine: 'mysql' as const },
    ]) {
      expect(postgresInspector.matchesTarget(stored, { ...prepared.target, ...changed })).toBe(
        false,
      )
    }
    expect(postgresInspector.scanValues(stored)).toEqual(['p@ss'])
    expect(postgresInspector.endpoint(input())).toEqual({ host: 'localhost', port: 5432 })
    expect(postgresInspector.endpointOf(stored)).toEqual({ host: 'localhost', port: 5432 })
    expect(postgresInspector).toMatchObject({
      engine: 'postgres',
      accessKind: 'db',
      defaultPort: 5432,
    })
    expect(() => postgresInspector.prepare(input({ engine: 'mysql' }))).toThrow()
  })

  it('leaves the structure of a database to its own stage', async () => {
    const error = await postgresInspector
      .readSchema(dbAccessSchema.parse(postgresInspector.prepare(input()).secret), {
        address: await pin('localhost'),
        signal: AbortSignal.timeout(1_000),
      })
      .catch((caught: unknown) => caught)
    expect(isDomainError(error) && error.code).toBe('NOT_IMPLEMENTED')
  })
})

describe('BoundedSocket', () => {
  it('dials the pinned literal whatever host it is given, and records the first byte', async () => {
    const port = await fakeServer((socket) => socket.end('Shello'))
    const socket = new BoundedSocket({
      address: await pin('localhost'),
      port,
      maxReceivedBytes: 1024,
      connectNow: false,
    })
    socket.connect(1, 'elsewhere.example')
    const received: Buffer[] = []
    socket.on('data', (chunk: Buffer) => received.push(chunk))
    await new Promise((resolve) => socket.once('end', resolve))
    expect(Buffer.concat(received).toString()).toBe('Shello')
    expect(socket.firstByte).toBe(0x53)
    expect(socket.exceeded).toBe(false)
    expect((socket as unknown as { _host: string })._host).toBe('127.0.0.1')
  })

  it('destroys itself past its cap', async () => {
    const port = await fakeServer((socket) => socket.write(Buffer.alloc(4096)))
    const socket = new BoundedSocket({
      address: await pin('127.0.0.1'),
      port,
      maxReceivedBytes: 1000,
      connectNow: true,
    })
    socket.resume()
    await new Promise((resolve) => socket.once('close', resolve))
    expect(socket.exceeded).toBe(true)
    expect(socket.receivedBytes).toBeGreaterThan(1000)
  })
})
