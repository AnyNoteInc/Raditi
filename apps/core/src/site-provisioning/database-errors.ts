import { Prisma } from '@repo/db'

// A failure of PostgreSQL that the next run of the same attempt may not meet: the connection
// lost or never made, the pool or a lock waited on past its bound, a statement cancelled by its
// timeout, a serialization conflict, a server restarting. The import goes back to the queue for
// it (docs/plan/39-site-connection-wizard.md, «Импорт»: short failures return to the queue), as
// for Vault away; anything else of the database is a final `internal`.

/** Prisma's own codes of a lost connection, a pool or transaction wait, a conflict. */
const transientCodes: ReadonlySet<string> = new Set([
  'P1001', // database not reachable
  'P1008', // operation timed out
  'P1017', // server closed the connection
  'P2024', // timed out fetching a connection from the pool
  'P2028', // transaction API: could not start in maxWait, or expired
  'P2034', // write conflict or deadlock
  'P2037', // too many connections
])

/** What PrismaPg names a socket failure, when the client gives the query its own code. */
const transientKinds: ReadonlySet<string> = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TransactionWriteConflict',
  'TooManyConnections',
])

/** SQLSTATE: connection exceptions (class 08) and the codes below. */
const transientStates: ReadonlySet<string> = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
])

const field = (value: unknown, name: string): unknown =>
  value !== null && typeof value === 'object' && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined

/** Whether an error of the store is a hiccup of PostgreSQL rather than an answer of it. */
export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError)
    return error.errorCode !== undefined && transientCodes.has(error.errorCode)
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (transientCodes.has(error.code)) return true
  // A raw query (P2010) or a database-specific error (P2039) carries the driver's cause.
  const cause = field(field(error.meta, 'driverAdapterError'), 'cause')
  const kind = field(cause, 'kind')
  if (typeof kind === 'string' && transientKinds.has(kind)) return true
  const state = field(cause, 'originalCode')
  return typeof state === 'string' && (state.startsWith('08') || transientStates.has(state))
}
