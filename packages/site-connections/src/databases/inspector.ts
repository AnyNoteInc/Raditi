import {
  badRequest,
  dbAccessSchema,
  isSiteConnectionError,
  notImplemented,
  siteConnectionLimits,
  type ConnectionCheckReason,
  type ConnectionTls,
  type DatabaseCheckOutcome,
  type DatabaseEngine,
  type DatabaseInput,
  type DatabaseInspector,
  type DbAccess,
  type PinnedAddress,
} from '@repo/domain'

import { abortable, isOperationAborted } from '../abort.ts'
import { secretFits, uniqueValues } from '../sources/shared.ts'

// The check of a database is the same for every engine: log in over the chosen protection, then in
// one read-only transaction `SELECT 1` and a count of the tables of this database from the catalog.
// No row of a user table is read and nothing is written; ROLLBACK ends the transaction. An engine
// adds only how it connects, what its statements are and how its errors read.

export interface CatalogLogin {
  address: PinnedAddress
  port: number
  database: string
  username: string
  password: string
  tls: ConnectionTls
  signal: AbortSignal
}

/** One logged-in connection. Both methods reject with SiteConnectionError only. */
export interface CatalogSession {
  query(sql: string): Promise<Record<string, unknown>[]>
  close(): void
}

export interface CatalogEngine {
  engine: DatabaseEngine
  defaultPort: number
  /** In this order, each its own statement; `count` answers one row with a `tables` column. */
  statements: { begin: string; probe: string; count: string; end: string }
  /** Connects to the pinned literal and logs in; rejects with SiteConnectionError. */
  open(login: CatalogLogin): Promise<CatalogSession>
}

function reasonOf(
  error: unknown,
  signal: AbortSignal,
  otherwise: ConnectionCheckReason,
): ConnectionCheckReason {
  if (signal.aborted || isOperationAborted(error)) return 'unreachable'
  return isSiteConnectionError(error) ? error.reason : otherwise
}

/** A count that is a non-negative safe integer, as a number or as the digits a driver may return. */
function tableCount(rows: readonly Record<string, unknown>[]): number | null {
  const value = rows[0]?.tables
  const count =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

export function createDatabaseInspector(engine: CatalogEngine): DatabaseInspector<DbAccess> {
  const asOwn = (input: DatabaseInput): DatabaseInput => {
    if (input.engine !== engine.engine) throw badRequest('Not a database of this engine')
    return input
  }

  return {
    engine: engine.engine,
    accessKind: 'db',
    accessSchema: dbAccessSchema,
    defaultPort: engine.defaultPort,

    endpoint(input) {
      const own = asOwn(input)
      return { host: own.host, port: own.port }
    },

    async check(input, context): Promise<DatabaseCheckOutcome> {
      const own = asOwn(input)
      let session: CatalogSession
      try {
        session = await abortable(
          context.signal,
          engine.open({
            address: context.address,
            port: own.port,
            database: own.database,
            username: own.username,
            password: own.password,
            tls: own.tls,
            signal: context.signal,
          }),
        )
      } catch (error) {
        return { ok: false, reason: reasonOf(error, context.signal, 'unreachable') }
      }
      try {
        const { begin, probe, count, end } = engine.statements
        await abortable(context.signal, session.query(begin))
        await abortable(context.signal, session.query(probe))
        const tables = tableCount(await abortable(context.signal, session.query(count)))
        await abortable(context.signal, session.query(end))
        return tables === null ? { ok: false, reason: 'unsupported' } : { ok: true, tables }
      } catch (error) {
        return { ok: false, reason: reasonOf(error, context.signal, 'transfer_failed') }
      } finally {
        session.close()
      }
    },

    prepare(input) {
      const own = asOwn(input)
      const secret: Record<string, string> = {
        v: '1',
        engine: own.engine,
        host: own.host,
        port: String(own.port),
        tls: own.tls,
        database: own.database,
        username: own.username,
        password: own.password,
      }
      // The schema's error would carry the values: only the verdict is kept.
      if (!dbAccessSchema.safeParse(secret).success || !secretFits(secret))
        throw badRequest('Invalid database access')
      return {
        accessKind: 'db',
        secret,
        target: {
          engine: own.engine,
          host: own.host,
          port: own.port,
          databaseName: own.database,
          tls: own.tls,
        },
      }
    },

    endpointOf(access) {
      return { host: access.host, port: Number(access.port) }
    },

    matchesTarget(access, target) {
      return (
        access.engine === engine.engine &&
        target.engine === access.engine &&
        target.host === access.host &&
        target.port === Number(access.port) &&
        target.databaseName === access.database &&
        target.tls === access.tls
      )
    },

    scanValues(access) {
      return uniqueValues([access.password])
    },

    readSchema() {
      return Promise.reject(notImplemented('DatabaseInspector.readSchema (database_schema stage)'))
    },
  }
}

/** What every engine bounds a check by. */
export const CHECK_RECEIVED_BYTES = siteConnectionLimits.checkReceivedBytes
