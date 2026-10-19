import type { ConnectionOptions } from 'mysql2'
import mysql from 'mysql2'

import {
  SiteConnectionError,
  type ConnectionCheckReason,
  type ConnectionTls,
  type DatabaseInspector,
  type DbAccess,
} from '@repo/domain'

import { whenAborted } from '../abort.ts'
import { errorCode, isCertificateError, isTlsProtocolError, type TestTrust } from '../tls.ts'
import { BoundedSocket } from './bounded-socket.ts'
import {
  CHECK_RECEIVED_BYTES,
  createDatabaseInspector,
  type CatalogLogin,
  type CatalogSession,
} from './inspector.ts'

// MySQL and MariaDB through `mysql2`, over a socket the adapter dials itself (BoundedSocket). The
// host mysql2 is told is the TLS name (the name for a name, the literal for a literal); it never
// dials it, because it is handed the socket.
//
// The password never crosses the network in clear. Over TLS it goes as the server's plugin asks.
// Without TLS (the user's explicit choice), caching_sha2_password — the default of MySQL 8.4 — asks
// mysql2 for the password itself on the first login after a server restart: mysql2 then fetches the
// server's RSA key and sends the password encrypted with it (RSA-OAEP), and that cannot be switched
// off without making such logins impossible. An attacker on the path could hand over another key;
// that is what "without encryption" means, and the wizard says so. mysql_clear_password stays
// disabled (`enableCleartextPlugin` is not set), and LOAD DATA LOCAL is refused by the client flags.

/** What the inspector takes of a mysql2 connection; a test hands in a scripted one. */
export interface MysqlConnectionLike {
  connect(callback: (error: Error | null) => void): void
  query(sql: string, callback: (error: Error | null, result: unknown) => void): void
  end(callback: (error?: Error | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export type MysqlConnectionFactory = (config: ConnectionOptions) => MysqlConnectionLike

/** The code Node gave a TLS handshake that failed, kept on the error before mysql2 overwrites it. */
const HANDSHAKE_CODE = Symbol('raditi.tlsHandshakeCode')

type StartTls = (onSecure: (error?: Error | null) => void) => void

/**
 * mysql2 reports every failed TLS handshake as HANDSHAKE_SSL_ERROR, overwriting the code Node gave it
 * (client_handshake.js): a certificate that does not verify and a server that cut the handshake read
 * alike. `startTLS` of the connection is wrapped so that the code reaches its callback first and is kept.
 */
function keepHandshakeCode(connection: object): void {
  const target = connection as { startTLS?: StartTls }
  const startTLS = target.startTLS
  if (typeof startTLS !== 'function') return
  target.startTLS = function (this: unknown, onSecure) {
    startTLS.call(this, (error) => {
      if (error) Object.defineProperty(error, HANDSHAKE_CODE, { value: errorCode(error) ?? null })
      onSecure(error)
    })
  }
}

function defaultFactory(config: ConnectionOptions): MysqlConnectionLike {
  const connection = mysql.createConnection(config)
  keepHandshakeCode(connection)
  return {
    connect: (callback) => connection.connect((error) => callback(error)),
    query: (sql, callback) => {
      connection.query(sql, (error, result) => callback(error, result))
    },
    end: (callback) => connection.end((error) => callback(error)),
    on: (event, listener) => {
      connection.on(event, listener)
    },
  }
}

/** A server error carries its number and SQLSTATE; a socket error has neither. */
function serverErrno(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('sqlState' in error) || !('errno' in error))
    return null
  const { errno } = error as { errno: unknown }
  return typeof errno === 'number' ? errno : null
}

/**
 * A HANDSHAKE_SSL_ERROR is a certificate failure only on a positive sign: the certificate that Node's
 * identity check adds (`cert`), or a certificate code Node gave before mysql2 overwrote it
 * (keepHandshakeCode). Anything else — a server or a network that cut the handshake (ECONNRESET with
 * nothing else on it), OpenSSL refusing the protocol — is a server that did not complete TLS.
 */
function isCertificateHandshakeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ('cert' in error) return true
  const original = (error as { [HANDSHAKE_CODE]?: unknown })[HANDSHAKE_CODE]
  return typeof original === 'string' && isCertificateError({ code: original })
}

/** By server error number and the client's own codes — never by the server's or the driver's text. */
export function mysqlFailure(
  error: unknown,
  socket: Pick<BoundedSocket, 'exceeded'> | null,
  tls: ConnectionTls,
  phase: 'connect' | 'query',
): ConnectionCheckReason {
  if (socket?.exceeded) return 'transfer_failed'
  const code = errorCode(error)
  if (code === 'HANDSHAKE_NO_SSL_SUPPORT') return 'tls_unavailable'
  if (code === 'HANDSHAKE_SSL_ERROR')
    return tls === 'verified' && isCertificateHandshakeError(error)
      ? 'certificate_untrusted'
      : 'tls_unavailable'
  const errno = serverErrno(error)
  if (errno !== null) {
    switch (errno) {
      case 1045: // ER_ACCESS_DENIED_ERROR
        return 'auth_failed'
      case 1044: // ER_DBACCESS_DENIED_ERROR
      case 1142: // ER_TABLEACCESS_DENIED_ERROR
      case 1143: // ER_COLUMNACCESS_DENIED_ERROR
      case 1227: // ER_SPECIFIC_ACCESS_DENIED_ERROR
        return 'access_denied'
      // ER_SECURE_TRANSPORT_REQUIRED (require_secure_transport): no connection without TLS — not a
      // refused login. An account of its own with REQUIRE SSL answers 1045, as any refused login.
      case 3159:
        return 'tls_required'
      case 1049: // ER_BAD_DB_ERROR
        return 'not_found'
      case 1129: // ER_HOST_IS_BLOCKED
      case 1130: // ER_HOST_NOT_PRIVILEGED
        return 'host_not_allowed'
      case 1040: // ER_CON_COUNT_ERROR
      case 1203: // ER_TOO_MANY_USER_CONNECTIONS
        return 'unreachable'
      case 1251: // ER_NOT_SUPPORTED_AUTH_MODE
      case 1524: // ER_PLUGIN_IS_NOT_LOADED
        return 'unsupported'
      default:
        return phase === 'connect' ? 'unsupported' : 'transfer_failed'
    }
  }
  // A plugin the platform does not speak (or does not allow: the cleartext one).
  if (code === 'MYSQL_CLEAR_PASSWORD_NOT_ENABLED' || code === 'AUTH_SWITCH_PLUGIN_ERROR')
    return 'unsupported'
  if (isCertificateError(error)) return 'certificate_untrusted'
  if (tls !== 'plain' && isTlsProtocolError(error)) return 'tls_unavailable'
  return phase === 'connect' ? 'unreachable' : 'transfer_failed'
}

export const mysqlStatements = {
  begin: 'START TRANSACTION READ ONLY',
  probe: 'SELECT 1',
  count:
    "SELECT COUNT(*) AS `tables` FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  end: 'ROLLBACK',
} as const

export interface MysqlInspectorOptions {
  createConnection?: MysqlConnectionFactory
  trust?: TestTrust
}

export function createMysqlInspector(
  options: MysqlInspectorOptions = {},
): DatabaseInspector<DbAccess> {
  const createConnection = options.createConnection ?? defaultFactory
  const trust = options.trust ?? {}

  async function open(login: CatalogLogin): Promise<CatalogSession> {
    if (login.signal.aborted) throw new SiteConnectionError('unreachable')
    const socket = new BoundedSocket({
      address: login.address,
      port: login.port,
      maxReceivedBytes: CHECK_RECEIVED_BYTES,
      connectNow: true,
    })
    const stop = whenAborted(login.signal, () => socket.destroy())
    const verified = login.tls === 'verified'
    const connection = createConnection({
      host: login.address.isName ? login.address.host : login.address.address,
      port: login.port,
      user: login.username,
      password: login.password,
      database: login.database,
      stream: socket,
      ssl:
        login.tls === 'plain'
          ? undefined
          : {
              rejectUnauthorized: verified,
              verifyIdentity: verified,
              ...(verified && trust.ca ? { ca: trust.ca } : {}),
            },
      flags: ['-LOCAL_FILES'],
      multipleStatements: false,
      // The signal of the check is the deadline; this only keeps mysql2's own timer out of its way.
      connectTimeout: 60_000,
    })
    connection.on('error', () => {})
    try {
      await new Promise<void>((resolve, reject) =>
        connection.connect((error) => (error ? reject(error) : resolve())),
      )
    } catch (error) {
      stop()
      socket.destroy()
      throw new SiteConnectionError(mysqlFailure(error, socket, login.tls, 'connect'))
    }
    return {
      query: (sql) =>
        new Promise<Record<string, unknown>[]>((resolve, reject) =>
          connection.query(sql, (error, result) => {
            if (error)
              reject(new SiteConnectionError(mysqlFailure(error, socket, login.tls, 'query')))
            else resolve(Array.isArray(result) ? (result as Record<string, unknown>[]) : [])
          }),
        ),
      close() {
        stop()
        connection.end(() => {})
        setTimeout(() => socket.destroy(), 1_000).unref()
      },
    }
  }

  return createDatabaseInspector({
    engine: 'mysql',
    defaultPort: 3306,
    statements: mysqlStatements,
    open,
  })
}

export const mysqlInspector: DatabaseInspector<DbAccess> = createMysqlInspector()
