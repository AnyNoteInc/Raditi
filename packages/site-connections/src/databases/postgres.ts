import type { ClientConfig } from 'pg'
import pg from 'pg'

import {
  SiteConnectionError,
  type ConnectionCheckReason,
  type ConnectionTls,
  type DatabaseInspector,
  type DbAccess,
} from '@repo/domain'

import { whenAborted } from '../abort.ts'
import {
  clientTlsOptions,
  errorCode,
  isCertificateError,
  isTlsProtocolError,
  type TestTrust,
} from '../tls.ts'
import { BoundedSocket } from './bounded-socket.ts'
import {
  CHECK_RECEIVED_BYTES,
  createDatabaseInspector,
  type CatalogLogin,
  type CatalogSession,
} from './inspector.ts'

// PostgreSQL through `pg`, over a socket the adapter dials itself (BoundedSocket): pg is given the
// pinned literal as its host and every TLS option explicitly, so no environment variable of the
// process (PGSSLMODE, PGHOST, …) decides where it connects or how.

/** What the inspector takes of `pg.Client`; a test hands in a scripted one. */
export interface PgClientLike {
  connect(): Promise<unknown>
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<void>
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type PgClientFactory = (config: ClientConfig) => PgClientLike

const ASCII_N = 0x4e

/** A server error: pg gives its SQLSTATE as `code` next to a `severity`. */
function sqlState(error: unknown): string | null {
  const code = errorCode(error)
  if (code === undefined || !/^[0-9A-Z]{5}$/.test(code)) return null
  return typeof error === 'object' && error !== null && 'severity' in error ? code : null
}

/** By SQLSTATE class and by the socket's own record — never by the server's or the driver's text. */
export function postgresFailure(
  error: unknown,
  socket: Pick<BoundedSocket, 'exceeded' | 'firstByte'> | null,
  tls: ConnectionTls,
  phase: 'connect' | 'query',
): ConnectionCheckReason {
  if (socket?.exceeded) return 'transfer_failed'
  // The server answered the SSLRequest with `N`: it does not speak TLS.
  if (tls !== 'plain' && socket?.firstByte === ASCII_N) return 'tls_unavailable'
  const state = sqlState(error)
  if (state !== null) {
    if (state === '28P01') return 'auth_failed'
    // pg_hba.conf: no entry for this address (or not without TLS), and the role refused outright.
    // `tls_required` is never answered here: a `hostssl`-only server refuses a plain login with the
    // same 28000, and only its text («SSL off») tells the two apart — which is not read.
    if (state === '28000') return 'host_not_allowed'
    if (state.startsWith('28')) return 'auth_failed'
    if (state === '3D000') return 'not_found'
    if (state === '42501') return 'access_denied'
    if (state.startsWith('08') || state.startsWith('57P') || state === '53300') return 'unreachable'
    return phase === 'connect' ? 'unsupported' : 'transfer_failed'
  }
  if (isCertificateError(error)) return 'certificate_untrusted'
  if (tls !== 'plain' && isTlsProtocolError(error)) return 'tls_unavailable'
  return phase === 'connect' ? 'unreachable' : 'transfer_failed'
}

export const postgresStatements = {
  begin: 'BEGIN TRANSACTION READ ONLY',
  probe: 'SELECT 1',
  // Ordinary and partitioned tables of every schema but the system ones (pg_catalog, pg_toast, the
  // temporary ones) and information_schema. The catalog lists them whatever the grants of the role.
  count:
    "SELECT count(*)::int AS tables FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'",
  end: 'ROLLBACK',
} as const

export interface PostgresInspectorOptions {
  createClient?: PgClientFactory
  trust?: TestTrust
}

export function createPostgresInspector(
  options: PostgresInspectorOptions = {},
): DatabaseInspector<DbAccess> {
  const createClient: PgClientFactory = options.createClient ?? ((config) => new pg.Client(config))
  const trust = options.trust ?? {}

  async function open(login: CatalogLogin): Promise<CatalogSession> {
    if (login.signal.aborted) throw new SiteConnectionError('unreachable')
    const socket = new BoundedSocket({
      address: login.address,
      port: login.port,
      maxReceivedBytes: CHECK_RECEIVED_BYTES,
      connectNow: false,
    })
    const stop = whenAborted(login.signal, () => socket.destroy())
    const client = createClient({
      host: login.address.address,
      port: login.port,
      database: login.database,
      user: login.username,
      password: login.password,
      ssl: clientTlsOptions(login.tls, login.address, trust) ?? false,
      stream: () => socket,
      application_name: 'raditi',
      keepAlive: false,
    })
    // A failure after the login reaches the query that is waiting; this only keeps it off the process.
    client.on('error', () => {})
    try {
      await client.connect()
    } catch (error) {
      stop()
      socket.destroy()
      throw new SiteConnectionError(postgresFailure(error, socket, login.tls, 'connect'))
    }
    return {
      async query(sql) {
        try {
          return (await client.query(sql)).rows
        } catch (error) {
          throw new SiteConnectionError(postgresFailure(error, socket, login.tls, 'query'))
        }
      },
      close() {
        stop()
        client.end().catch(() => {})
        setTimeout(() => socket.destroy(), 1_000).unref()
      },
    }
  }

  return createDatabaseInspector({
    engine: 'postgres',
    defaultPort: 5432,
    statements: postgresStatements,
    open,
  })
}

export const postgresInspector: DatabaseInspector<DbAccess> = createPostgresInspector()
