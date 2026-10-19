import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { Duplex } from 'node:stream'

import type {
  AppEnv,
  ConnectionCheckReason,
  DatabaseCopier,
  DatabaseCopyInput,
  DatabaseCopyPolicy,
  DatabaseCopySummary,
  DbAccess,
  HostLookup,
  PinnedAddress,
} from '@repo/domain'
import {
  badRequest,
  DatabaseCopyError,
  databaseCopyInputSchema,
  databaseCopyLimits,
  dbAccessSchema,
  DomainError,
  isDatabaseCopyError,
  isSiteConnectionError,
  resolvePinnedAddress,
  SiteConnectionError,
} from '@repo/domain'
import { createConnection, type Connection, type FieldPacket } from 'mysql2'

import { scrubNestedSecrets } from './nested-secrets.ts'
import { assertCopyPolicy, ruleColumns, rowFilter } from './policy-sql.ts'
import {
  EMPTY_LITERAL,
  hexLiteral,
  insertStatement,
  NULL_LITERAL,
  numberLiteral,
  seedCharsets,
  seedFooter,
  seedHeader,
  stringLiteral,
  tableStatement,
  tuple,
  utf8Literal,
} from './sql.ts'

// The DatabaseCopier of MySQL and MariaDB (docs/plan/53-chat-preview-release.md, Р15). One
// read-only transaction with a consistent snapshot; every table of the site's prefix is written
// as its structure, and only the rows the policy names are ever selected — filtered by the
// server, paged by an integer primary key, turned into SQL row by row and handed to `write`.
// Nothing of the source is kept: no file, no dump in memory, no value in an error or a log.

export interface MysqlDatabaseCopierDeps {
  /** How the host of the access is resolved and checked: the rule of site addresses (§12). */
  lookup: HostLookup
  appEnv: AppEnv
  /** CAs trusted for `verified` TLS instead of the system's: a stand's own CA. */
  ca?: string
}

export function createMysqlDatabaseCopier(deps: MysqlDatabaseCopierDeps): DatabaseCopier {
  return { copy: (input, write, signal) => copyDatabase(deps, input, write, signal) }
}

/** A base table of the site's database and the encoding it stores its text in. */
export interface DatabaseCatalogTable {
  name: string
  /** null — the server did not say (a table without a collation). */
  collation: string | null
  charset: string | null
}

/**
 * What the catalog of the site's database says of its tables (docs/plan/53, R5c): names and
 * collations, never a row. Where no configuration of the hosting can be read, core finds the
 * table prefix and the encoding of the copy here (previews/database-settings.ts).
 */
export interface MysqlDatabaseCatalog {
  tables(access: DbAccess, signal?: AbortSignal): Promise<DatabaseCatalogTable[]>
}

export function createMysqlDatabaseCatalog(deps: MysqlDatabaseCopierDeps): MysqlDatabaseCatalog {
  return { tables: (access, signal) => readCatalog(deps, access, signal) }
}

async function readCatalog(
  deps: MysqlDatabaseCopierDeps,
  input: DbAccess,
  outer?: AbortSignal,
): Promise<DatabaseCatalogTable[]> {
  const parsed = dbAccessSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid database access')
  const access = parsed.data
  if (access.engine !== 'mysql') throw badRequest('The MySQL catalog reads MySQL databases only')
  const deadline = AbortSignal.timeout(databaseCopyLimits.queryMs)
  const signal = outer ? AbortSignal.any([outer, deadline]) : deadline
  const pinned = await resolvePinnedAddress(deps, access.host, signal)
  if (!pinned.ok) throw new SiteConnectionError(pinned.reason)
  const guard = new ReceiveGuard()
  let connection: Connection | undefined
  let socket: Duplex | undefined
  const onAbort = () => socket?.destroy(new Error('Database catalog: stopped'))
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    connection = await open(deps, access, pinned.address, 'utf8mb4', guard, signal, (opened) => {
      socket = opened
    })
    const rows = await catalog<{ name: unknown; collation: unknown; charset: unknown }>(
      connection,
      `SELECT t.TABLE_NAME AS name, t.TABLE_COLLATION AS collation,
          c.CHARACTER_SET_NAME AS charset
        FROM information_schema.TABLES t
        LEFT JOIN information_schema.COLLATIONS c ON c.COLLATION_NAME = t.TABLE_COLLATION
        WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY t.TABLE_NAME
        LIMIT ${databaseCopyLimits.tables * 4}`,
    )
    const text = (value: unknown) =>
      typeof value === 'string' && PLAIN_NAME.test(value) ? value.toLowerCase() : null
    return rows.flatMap((row) => {
      const name = typeof row.name === 'string' && PLAIN_NAME.test(row.name) ? row.name : null
      return name ? [{ name, collation: text(row.collation), charset: text(row.charset) }] : []
    })
  } catch (error) {
    if (signal.aborted) throw new DatabaseCopyError('timed_out')
    throw copyFailure(error, guard, access)
  } finally {
    signal.removeEventListener('abort', onAbort)
    connection?.destroy()
    socket?.destroy()
  }
}

/** Bytes one row may bring besides its own: the packets of a page and the header of a result. */
const ROW_SLACK_BYTES = 1024 * 1024
const INTEGER_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint'])
const GENERATED = /\b(?:VIRTUAL|STORED|PERSISTENT) GENERATED\b/i
/** Names the seed can write as they are, in any of its encodings. */
const PLAIN_NAME = /^[A-Za-z0-9_$]{1,64}$/

// Types of the protocol (mysql2/lib/constants/types).
const NUMERIC_TYPES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x08, 0x09, 0x0d, 0xf6])
const STRING_TYPES = new Set([0x0f, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe])
const BIT = 0x10
const JSON_TYPE = 0xf5
const GEOMETRY = 0xff
const BINARY_CHARSET = 63

type ValueKind = 'number' | 'binary' | 'text'

function valueKind(field: FieldPacket): ValueKind {
  const type = field.columnType ?? field.type ?? -1
  if (NUMERIC_TYPES.has(type)) return 'number'
  if (type === BIT || type === GEOMETRY) return 'binary'
  if (type === JSON_TYPE) return 'text'
  // MariaDB's UUID and INET types come as their text.
  if (field.extendedTypeName && field.extendedTypeName !== 'point') return 'text'
  return STRING_TYPES.has(type) && field.characterSet === BINARY_CHARSET ? 'binary' : 'text'
}

function literal(kind: ValueKind, value: Buffer): Buffer {
  if (kind === 'binary') return hexLiteral(value)
  if (kind === 'number') return numberLiteral(value) ?? stringLiteral(value)
  return stringLiteral(value)
}

/** The writer's own failure: it goes back to the caller as it is, never as a reason of a copy. */
class SinkFailure extends Error {
  readonly original: unknown

  constructor(original: unknown) {
    super('Database copy: the writer failed')
    this.name = 'SinkFailure'
    this.original = original
  }
}

/** Counts what the server sends, before TLS and before mysql2 holds a byte of it. */
class ReceiveGuard {
  private total = 0
  private sinceRow = 0
  failure: DatabaseCopyError | null = null

  received(bytes: number): DatabaseCopyError | null {
    this.total += bytes
    this.sinceRow += bytes
    if (
      this.total > databaseCopyLimits.receivedBytes ||
      this.sinceRow > databaseCopyLimits.rowBytes + ROW_SLACK_BYTES
    )
      this.failure ??= new DatabaseCopyError('too_large')
    return this.failure
  }

  rowDone(): void {
    this.sinceRow = 0
  }
}

/**
 * The connection to the pinned address with the guard in its way. mysql2 starts TLS on it
 * itself; Node then checks the certificate of an IP literal against `_host` of the socket it is
 * handed, so that is set to the literal (a name goes as the server name).
 */
function guardedStream(address: PinnedAddress, port: number, guard: ReceiveGuard): Duplex {
  const socket = connect({ host: address.address, port, family: address.family })
  socket.setNoDelay(true)
  const stream = new Duplex({
    read() {
      socket.resume()
    },
    write(chunk: Buffer, _encoding, done) {
      socket.write(chunk, (error) => done(error ?? null))
    },
    final(done) {
      socket.end()
      done()
    },
    destroy(error, done) {
      socket.destroy()
      done(error)
    },
  })
  socket.on('data', (chunk: Buffer) => {
    const failure = guard.received(chunk.byteLength)
    if (failure) stream.destroy(failure)
    else if (!stream.push(chunk)) socket.pause()
  })
  socket.on('end', () => stream.push(null))
  socket.on('error', (error) => stream.destroy(error))
  socket.on('close', () => {
    if (!stream.destroyed) stream.destroy()
  })
  Object.defineProperty(stream, '_host', { value: address.address })
  return stream
}

const isTlsFailure = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === 'HANDSHAKE_SSL_ERROR'

function sslOf(access: DbAccess, ca: string | undefined) {
  if (access.tls === 'plain') return undefined
  const verified = access.tls === 'verified'
  return {
    rejectUnauthorized: verified,
    verifyIdentity: verified,
    minVersion: 'TLSv1.2',
    ...(verified && ca !== undefined ? { ca } : {}),
  }
}

function open(
  deps: MysqlDatabaseCopierDeps,
  access: DbAccess,
  address: PinnedAddress,
  charset: string,
  guard: ReceiveGuard,
  signal: AbortSignal,
  onSocket: (socket: Duplex) => void,
): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const ssl = sslOf(access, deps.ca)
    const connection = createConnection({
      host: address.isName ? address.host : address.address,
      port: Number(access.port),
      user: access.username,
      password: access.password,
      database: access.database,
      ...(ssl ? { ssl } : {}),
      stream: () => {
        const socket = guardedStream(address, Number(access.port), guard)
        onSocket(socket)
        return socket
      },
      connectTimeout: databaseCopyLimits.connectMs,
      // A server never makes this client read a file, and a query is one statement.
      flags: ['-LOCAL_FILES', '-MULTI_STATEMENTS'],
      multipleStatements: false,
      charset: seedCharsets[charset] ?? 'UTF8MB4',
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    })
    // A failed TLS handshake reports the lost connection first and its own error right after:
    // the handshake fails with every error the moment has brought, the TLS one preferred.
    const errors: unknown[] = []
    const collect = (error: unknown) => errors.push(error)
    // A destroyed connection reports nothing: the deadline rejects the handshake itself.
    const onAbort = () => {
      connection.destroy()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    connection.on('error', collect)
    connection.once('error', () =>
      setImmediate(() => {
        signal.removeEventListener('abort', onAbort)
        connection.destroy()
        reject(errors.find(isTlsFailure) ?? errors[0])
      }),
    )
    connection.once('connect', () => {
      signal.removeEventListener('abort', onAbort)
      connection.removeAllListeners('error')
      // Later errors reach the query that is running.
      connection.on('error', () => undefined)
      resolve(connection)
    })
  })
}

/** A query whose answer is small and of names and numbers: the session and the catalog. */
function catalog<Row>(connection: Connection, sql: string, values: unknown[] = []): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    connection.query(
      { sql, values, timeout: databaseCopyLimits.queryMs },
      (error: Error | null, rows: unknown) => (error ? reject(error) : resolve(rows as Row[])),
    )
  })
}

/** The bytes of every value as the server sent them, in its order. */
const rawValues = (field: { buffer(): Buffer | null }) => field.buffer()

/**
 * Rows of one query, one by one. `onRow` may hand back a write to wait for: the connection is
 * paused until it is done, so the server never sends faster than the writer takes. The query
 * ends the moment `signal` is aborted, a write still running or not, and no row reaches `onRow`
 * after it: rows mysql2 still parses from what has arrived are dropped.
 */
function streamRows(
  connection: Connection,
  query: { sql: string; values: unknown[]; signal: AbortSignal },
  onFields: (fields: FieldPacket[]) => void,
  onRow: (row: (Buffer | null)[]) => Promise<void> | null,
): Promise<void> {
  const { sql, values, signal } = query
  return new Promise((resolve, reject) => {
    let settled = false
    let writing: Promise<void> = Promise.resolve()
    const onAbort = () => fail(signal.reason)
    // A lost connection is told to the connection, never to a query without a callback.
    const onLost = (error: unknown) => fail(error)
    const settle = () => {
      settled = true
      signal.removeEventListener('abort', onAbort)
      connection.off('error', onLost)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settle()
      connection.destroy()
      reject(error)
    }
    if (signal.aborted) return fail(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    connection.on('error', onLost)
    const running = connection.query({
      sql,
      values,
      typeCast: rawValues,
      rowsAsArray: true,
      timeout: databaseCopyLimits.queryMs,
    })
    running.on('fields', (fields: FieldPacket[]) => {
      try {
        onFields(fields)
      } catch (error) {
        fail(error)
      }
    })
    running.on('result', (row: (Buffer | null)[]) => {
      if (settled) return
      if (signal.aborted) return fail(signal.reason)
      try {
        const write = onRow(row)
        if (write) {
          connection.pause()
          writing = write.then(() => {
            if (!settled) connection.resume()
          }, fail)
        }
      } catch (error) {
        fail(error)
      }
    })
    running.on('error', fail)
    running.on('end', () => {
      writing.then(() => {
        if (settled) return
        settle()
        resolve()
      }, fail)
    })
  })
}

/**
 * What goes to `write`: counted, hashed, and INSERTs grouped up to `statementBytes`. Nothing
 * goes once the copy is stopped.
 */
class SeedWriter {
  bytes = 0
  private readonly hash = createHash('sha256')
  private table = ''
  private columns: readonly string[] = []
  private tuples: Buffer[] = []
  private pending = 0
  private readonly sink: (chunk: Uint8Array) => Promise<void>
  private readonly signal: AbortSignal

  constructor(sink: (chunk: Uint8Array) => Promise<void>, signal: AbortSignal) {
    this.sink = sink
    this.signal = signal
  }

  async raw(chunk: Buffer): Promise<void> {
    this.signal.throwIfAborted()
    this.bytes += chunk.byteLength
    if (this.bytes > databaseCopyLimits.seedBytes) throw new DatabaseCopyError('too_large')
    this.hash.update(chunk)
    try {
      await this.sink(chunk)
    } catch (error) {
      throw new SinkFailure(error)
    }
  }

  begin(table: string, columns: readonly string[]): void {
    this.table = table
    this.columns = columns
  }

  /** A write to wait for once the statement is full; else null. */
  add(values: Buffer): Promise<void> | null {
    this.tuples.push(values)
    this.pending += values.byteLength
    return this.pending >= databaseCopyLimits.statementBytes ? this.flush() : null
  }

  async flush(): Promise<void> {
    if (this.tuples.length === 0) return
    const statement = insertStatement(this.table, this.columns, this.tuples)
    this.tuples = []
    this.pending = 0
    await this.raw(statement)
  }

  sha256(): string {
    return this.hash.digest('hex')
  }
}

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** A phpass-shaped hash of a password nobody knows: no password signs in with it. */
function randomPasswordHash(): string {
  return `$P$B${[...randomBytes(31)].map((byte) => ITOA64[byte % 64]).join('')}`
}

interface Column {
  name: string
  type: string
  generated: boolean
}

interface TableInfo {
  columns: Column[]
  primaryKey: string[]
}

function checkedInput(input: DatabaseCopyInput) {
  const access = dbAccessSchema.safeParse(input.access)
  const rest = databaseCopyInputSchema.safeParse({
    tablePrefix: input.tablePrefix,
    charset: input.charset,
    collation: input.collation,
    policy: input.policy,
  })
  if (!access.success || !rest.success) throw badRequest('Invalid database copy input')
  if (access.data.engine !== 'mysql' || rest.data.policy.engine !== 'mysql')
    throw badRequest('The MySQL copier copies MySQL databases only')
  const charset = rest.data.charset.toLowerCase()
  if (!Object.hasOwn(seedCharsets, charset)) throw new DatabaseCopyError('encoding_unsupported')
  assertCopyPolicy(rest.data.policy)
  return {
    access: access.data,
    tablePrefix: rest.data.tablePrefix,
    charset,
    collation: rest.data.collation?.toLowerCase() ?? null,
    policy: rest.data.policy,
  }
}

async function copyDatabase(
  deps: MysqlDatabaseCopierDeps,
  input: DatabaseCopyInput,
  write: (chunk: Uint8Array) => Promise<void>,
  outer?: AbortSignal,
): Promise<DatabaseCopySummary> {
  const { access, tablePrefix, charset, collation, policy } = checkedInput(input)
  const deadline = AbortSignal.timeout(databaseCopyLimits.copyMs)
  const signal = outer ? AbortSignal.any([outer, deadline]) : deadline
  const stopped = () =>
    outer?.aborted ? (outer.reason as unknown) : new DatabaseCopyError('timed_out')

  const pinned = await resolvePinnedAddress(deps, access.host, signal)
  if (signal.aborted) throw stopped()
  if (!pinned.ok) throw new SiteConnectionError(pinned.reason)

  const guard = new ReceiveGuard()
  let connection: Connection | undefined
  let socket: Duplex | undefined
  // mysql2's destroy() only half-closes and tells no running query: the socket itself goes, so
  // the query in progress fails at once and the server sends nothing more.
  const onAbort = () => socket?.destroy(new Error('Database copy: stopped'))
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    connection = await open(deps, access, pinned.address, charset, guard, signal, (opened) => {
      socket = opened
    })
    if (signal.aborted) throw stopped()
    return await copyTables(
      connection,
      guard,
      { tablePrefix, charset, collation, policy, signal },
      write,
    )
  } catch (error) {
    if (signal.aborted) throw stopped()
    throw copyFailure(error, guard, access)
  } finally {
    signal.removeEventListener('abort', onAbort)
    connection?.destroy()
    socket?.destroy()
  }
}

interface CopyPlan {
  tablePrefix: string
  charset: string
  collation: string | null
  policy: DatabaseCopyPolicy
  signal: AbortSignal
}

async function copyTables(
  connection: Connection,
  guard: ReceiveGuard,
  plan: CopyPlan,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<DatabaseCopySummary> {
  const { tablePrefix, charset, collation, policy, signal } = plan
  const writer = new SeedWriter(write, signal)

  // The session reads what the site's own connection reads, from one snapshot, and writes
  // nothing: backticks and backslash escapes as the seed uses them, times in UTC.
  await catalog(
    connection,
    `SET SESSION sql_mode = '', time_zone = '+00:00', sql_quote_show_create = 1`,
  )
  await catalog(connection, `SET NAMES ${charset}${collation ? ` COLLATE ${collation}` : ''}`)
  await catalog(connection, 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await catalog(connection, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [version] = await catalog<{ version: unknown }>(connection, 'SELECT VERSION() AS version')
  const serverVersion =
    typeof version?.version === 'string'
      ? version.version.replace(/\p{Cc}/gu, '').slice(0, 64) || null
      : null

  const listed = await catalog<{ name: unknown }>(
    connection,
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
  )
  const tables = listed
    .map((row) => String(row.name))
    .filter((name) => name.startsWith(tablePrefix) && PLAIN_NAME.test(name))
    .sort()
  if (tables.length > databaseCopyLimits.tables) throw new DatabaseCopyError('too_large')
  const present = new Set(tables)
  const nameOf = (table: string) => `${tablePrefix}${table}`
  const exists = (table: string) => present.has(nameOf(table))

  // The columns of every table the policy reads or sets: each column it names must be there.
  const named = new Set([
    ...policy.tables.map((rule) => rule.table),
    ...policy.overrides.map((override) => override.table),
  ])
  const info = new Map<string, TableInfo>()
  for (const table of named) {
    if (!exists(table)) continue
    const found = await tableInfo(connection, nameOf(table))
    const columns = new Set(found.columns.map((column) => column.name))
    if (ruleColumns(policy, table).some((column) => !columns.has(column)))
      throw new DatabaseCopyError('structure_unsupported')
    info.set(table, found)
  }

  await writer.raw(seedHeader(charset, collation))
  let rows = 0
  let structureOnly = 0
  for (const name of tables) {
    const table = name.slice(tablePrefix.length)
    await writer.raw(tableStatement(name, await createTable(connection, name)))
    const rule = policy.tables.find((candidate) => candidate.table === table)
    const overrides = policy.overrides.filter((override) => override.table === table)
    const seen = new Set<number>()
    if (rule) {
      const tableRows = new TableRows(rule, overrides, info.get(table)!, seen)
      rows += await copyRows(connection, guard, writer, {
        name,
        rows: tableRows,
        where: rowFilter(policy, table, nameOf, exists),
        limit: databaseCopyLimits.rows - rows,
        signal,
      })
    } else structureOnly += 1
    // An override without a copied row adds one.
    for (const [index, override] of overrides.entries()) {
      if (seen.has(index) || override.set === null) continue
      const columns = [override.match.column, ...Object.keys(override.set)]
      const values = [override.match.value, ...Object.values(override.set)].map(setLiteral)
      await writer.raw(insertStatement(name, columns, [tuple(values)]))
    }
  }
  await catalog(connection, 'COMMIT')
  await writer.raw(seedFooter())

  return {
    tables: tables.length,
    structureOnly,
    rows,
    bytes: writer.bytes,
    sha256: writer.sha256(),
    serverVersion,
  }
}

async function tableInfo(connection: Connection, name: string): Promise<TableInfo> {
  const columns = await catalog<{ name: unknown; type: unknown; extra: unknown }>(
    connection,
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, EXTRA AS extra FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [name],
  )
  const primaryKey = await catalog<{ name: unknown }>(
    connection,
    `SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
      ORDER BY SEQ_IN_INDEX`,
    [name],
  )
  const result: TableInfo = {
    columns: columns.map((column) => ({
      name: String(column.name),
      type: String(column.type).toLowerCase(),
      generated: GENERATED.test(String(column.extra ?? '')),
    })),
    primaryKey: primaryKey.map((column) => String(column.name)),
  }
  // A copied row is written by the names of its columns: each one the seed can spell.
  if (result.columns.some((column) => !PLAIN_NAME.test(column.name)))
    throw new DatabaseCopyError('structure_unsupported')
  return result
}

function createTable(connection: Connection, name: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    connection.query(
      {
        sql: 'SHOW CREATE TABLE ??',
        values: [name],
        typeCast: rawValues,
        rowsAsArray: true,
        timeout: databaseCopyLimits.queryMs,
      },
      (error: Error | null, rows: unknown) => {
        if (error) return reject(error)
        const statement = (rows as (Buffer | null)[][])[0]?.[1]
        if (!statement) return reject(new DatabaseCopyError('structure_unsupported'))
        if (statement.byteLength > databaseCopyLimits.createTableBytes)
          return reject(new DatabaseCopyError('too_large'))
        resolve(statement)
      },
    )
  })
}

function setLiteral(value: string | number): Buffer {
  if (typeof value === 'string') return utf8Literal(value)
  if (!Number.isFinite(value)) throw badRequest('Copy policy: an override is not a number')
  return Buffer.from(String(value))
}

type Override = DatabaseCopyPolicy['overrides'][number]

/** How the rows of one table become tuples: treatments, overrides, the synthetic id. */
class TableRows {
  readonly columns: string[]
  /** The integer primary key the pages follow; null — one query for the whole table. */
  readonly keyset: string[] | null
  private readonly treatments: (string | undefined)[]
  private readonly idIndex: number
  private readonly matches: { index: number; column: number; value: Buffer }[]
  private readonly overrides: readonly Override[]
  private readonly seen: Set<number>
  private kinds: ValueKind[] = []

  constructor(
    rule: DatabaseCopyPolicy['tables'][number],
    overrides: readonly Override[],
    info: TableInfo,
    seen: Set<number>,
  ) {
    this.overrides = overrides
    this.seen = seen
    const typeOf = new Map(info.columns.map((column) => [column.name, column.type]))
    this.columns = info.columns.filter((column) => !column.generated).map((column) => column.name)
    const integerKey =
      info.primaryKey.length > 0 &&
      info.primaryKey.every((column) => INTEGER_TYPES.has(typeOf.get(column) ?? ''))
    this.keyset = integerKey ? info.primaryKey : null
    this.treatments = this.columns.map((column) => rule.columns?.[column])
    const synthetic = this.treatments.some((treatment) => treatment?.startsWith('synthetic_'))
    // A synthetic value names the row by its one integer key.
    if (synthetic && !(integerKey && info.primaryKey.length === 1))
      throw new DatabaseCopyError('structure_unsupported')
    this.idIndex = synthetic ? this.columns.indexOf(info.primaryKey[0]!) : -1
    this.matches = overrides.map((override, index) => {
      const column = this.columns.indexOf(override.match.column)
      // A column the policy names is in the table; a generated one cannot be matched or set.
      if (
        column < 0 ||
        Object.keys(override.set ?? {}).some((name) => !this.columns.includes(name))
      )
        throw new DatabaseCopyError('structure_unsupported')
      return { index, column, value: Buffer.from(override.match.value, 'utf8') }
    })
  }

  fields(fields: FieldPacket[]): void {
    if (fields.length !== this.columns.length) throw new DatabaseCopyError('structure_unsupported')
    this.kinds = fields.map(valueKind)
  }

  /** The tuple of a row, or null when an override says the copy holds no such row. */
  tuple(row: (Buffer | null)[]): Buffer | null {
    const size = row.reduce((sum, value) => sum + (value?.byteLength ?? 0), 0)
    if (size > databaseCopyLimits.rowBytes) throw new DatabaseCopyError('too_large')
    let set: Override['set'] | undefined
    for (const match of this.matches) {
      const value = row[match.column]
      if (value && value.equals(match.value)) {
        this.seen.add(match.index)
        set = this.overrides[match.index]?.set
        if (set === null) return null
      }
    }
    const id = this.idIndex >= 0 ? (row[this.idIndex]?.toString('latin1') ?? '') : ''
    if (this.idIndex >= 0 && !/^\d{1,20}$/.test(id))
      throw new DatabaseCopyError('structure_unsupported')
    return tuple(
      row.map((value, index) => {
        const column = this.columns[index]!
        if (set && Object.hasOwn(set, column)) return setLiteral(set[column]!)
        switch (this.treatments[index]) {
          case 'empty':
            return EMPTY_LITERAL
          case 'null':
            return NULL_LITERAL
          case 'synthetic_email':
            return utf8Literal(`user${id}@preview.invalid`)
          case 'synthetic_login':
            return utf8Literal(`user${id}`)
          case 'synthetic_name':
            return utf8Literal(`Пользователь ${id}`)
          case 'random_password_hash':
            return utf8Literal(randomPasswordHash())
          case 'scrub_secrets':
            return value === null
              ? NULL_LITERAL
              : literal(this.kinds[index] ?? 'text', scrubNestedSecrets(value))
          default:
            return value === null ? NULL_LITERAL : literal(this.kinds[index] ?? 'text', value)
        }
      }),
    )
  }

  /** The key of a row for the next page: integers, exactly. */
  key(row: (Buffer | null)[]): bigint[] {
    return (this.keyset ?? []).map((column) => {
      const text = row[this.columns.indexOf(column)]?.toString('latin1') ?? ''
      if (!/^-?\d{1,20}$/.test(text)) throw new DatabaseCopyError('structure_unsupported')
      return BigInt(text)
    })
  }
}

async function copyRows(
  connection: Connection,
  guard: ReceiveGuard,
  writer: SeedWriter,
  table: {
    name: string
    rows: TableRows
    where: { sql: string; values: unknown[] }
    limit: number
    signal: AbortSignal
  },
): Promise<number> {
  const { rows, where, signal } = table
  const ids = (names: readonly string[]) => names.map(() => '??').join(', ')
  writer.begin(table.name, rows.columns)
  let copied = 0
  // The key of the last row read: the next page starts after it.
  const cursor: { last: bigint[] | null } = { last: null }
  for (;;) {
    let sql = `SELECT ${ids(rows.columns)} FROM ?? WHERE (${where.sql})`
    const values: unknown[] = [...rows.columns, table.name, ...where.values]
    if (rows.keyset) {
      if (cursor.last) {
        sql += ` AND (${ids(rows.keyset)}) > (${rows.keyset.map(() => '?').join(', ')})`
        values.push(...rows.keyset, ...cursor.last)
      }
      sql += ` ORDER BY ${ids(rows.keyset)} LIMIT ${databaseCopyLimits.batchRows}`
      values.push(...rows.keyset)
    }
    let page = 0
    await streamRows(
      connection,
      { sql, values, signal },
      (fields) => rows.fields(fields),
      (row) => {
        guard.rowDone()
        page += 1
        if (rows.keyset) cursor.last = rows.key(row)
        const values = rows.tuple(row)
        if (values === null) return null
        copied += 1
        if (copied > table.limit) throw new DatabaseCopyError('too_large')
        return writer.add(values)
      },
    )
    if (!rows.keyset || page < databaseCopyLimits.batchRows) break
  }
  await writer.flush()
  return copied
}

const connectionReasons: Readonly<Record<string, ConnectionCheckReason>> = {
  ER_ACCESS_DENIED_ERROR: 'auth_failed',
  ER_ACCESS_DENIED_NO_PASSWORD_ERROR: 'auth_failed',
  ER_DBACCESS_DENIED_ERROR: 'access_denied',
  ER_TABLEACCESS_DENIED_ERROR: 'access_denied',
  ER_COLUMNACCESS_DENIED_ERROR: 'access_denied',
  ER_SPECIFIC_ACCESS_DENIED_ERROR: 'access_denied',
  ER_BAD_DB_ERROR: 'not_found',
  ER_HOST_NOT_PRIVILEGED: 'host_not_allowed',
  ER_HOST_IS_BLOCKED: 'host_not_allowed',
  ER_NOT_SUPPORTED_AUTH_MODE: 'unsupported',
  HANDSHAKE_NO_SSL_SUPPORT: 'tls_unavailable',
  ECONNREFUSED: 'unreachable',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  ETIMEDOUT: 'unreachable',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certificate_untrusted',
  SELF_SIGNED_CERT_IN_CHAIN: 'certificate_untrusted',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate_untrusted',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'certificate_untrusted',
  CERT_HAS_EXPIRED: 'certificate_untrusted',
  CERT_NOT_YET_VALID: 'certificate_untrusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certificate_untrusted',
}
const copyReasons: Readonly<Record<string, DatabaseCopyError['reason']>> = {
  ER_NO_SUCH_TABLE: 'structure_unsupported',
  ER_BAD_FIELD_ERROR: 'structure_unsupported',
  ER_UNKNOWN_CHARACTER_SET: 'encoding_unsupported',
  ER_UNKNOWN_COLLATION: 'encoding_unsupported',
  ER_COLLATION_CHARSET_MISMATCH: 'encoding_unsupported',
  PROTOCOL_SEQUENCE_TIMEOUT: 'timed_out',
  ER_QUERY_TIMEOUT: 'timed_out',
  ER_STATEMENT_TIMEOUT: 'timed_out',
}

/** A reason, never the server's text: the copier's own errors stay, the writer's go back as they are. */
function copyFailure(error: unknown, guard: ReceiveGuard, access: DbAccess): unknown {
  if (guard.failure) return guard.failure
  if (error instanceof SinkFailure) return error.original
  if (isDatabaseCopyError(error) || isSiteConnectionError(error) || error instanceof DomainError)
    return error
  const code = (error as { code?: unknown } | null)?.code
  // mysql2 replaces the code of a failed TLS handshake: with a verified identity it is the
  // certificate, else the server speaks no TLS the platform accepts.
  if (code === 'HANDSHAKE_SSL_ERROR')
    return new SiteConnectionError(
      access.tls === 'verified' ? 'certificate_untrusted' : 'tls_unavailable',
    )
  if (typeof code === 'string') {
    const copy = copyReasons[code]
    if (copy) return new DatabaseCopyError(copy)
    const connection = connectionReasons[code]
    if (connection) return new SiteConnectionError(connection)
  }
  return new SiteConnectionError('transfer_failed')
}
