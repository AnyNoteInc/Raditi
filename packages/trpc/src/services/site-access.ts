import {
  DomainError,
  isDomainError,
  isSiteConnectionError,
  resolvePinnedAddress,
  siteAccessPath,
  siteConnectionLimits,
  type CodeSourceInput,
  type CodeSourceTarget,
  type ConnectionCheckReason,
  type DatabaseCheckOutcome,
  type DatabaseInput,
  type DatabaseTarget,
  type PreparedAccess,
  type SiteAccessKind,
  type SiteConnectionServices,
  type SiteSourceKind,
  type SiteStack,
  type SourceCheckOutcome,
} from '@repo/domain'

import { noteRefusedLogin, passSiteConnectionGate } from './site-connection-gate.ts'

// The network half of the wizard (docs/plan/39-site-connection-wizard.md): a real connection to the
// client's server or database under one deadline, and the secret of a checked access written to Vault
// with CAS. Nothing here logs, returns or throws a secret or what a server or a driver said: an outcome is
// one of connectionCheckReasons, a failure is SITE_CONNECTION_UNAVAILABLE, and a log line names an id, a
// kind and an error class.

export const siteConnectionUnavailable = () =>
  new DomainError('SITE_CONNECTION_UNAVAILABLE', 'Site connections are not available', 503)

/** The services of the wizard, or SITE_CONNECTION_UNAVAILABLE: web has no Vault for them. */
export function requireSiteConnections(
  services: SiteConnectionServices | null | undefined,
): SiteConnectionServices {
  if (!services) throw siteConnectionUnavailable()
  return services
}

/**
 * Whether the wizard offers this kind of source. The registry of the services says so: the transport
 * names no kind (CLAUDE.md, rule 8) — `git` is in the contracts and not offered today.
 */
export function offersSource(services: SiteConnectionServices, kind: SiteSourceKind): boolean {
  return services.sourceOptions.some((option) => option.kind === kind)
}

/** The class of a failure and its HTTP status when it has one: never its message. */
export function failureLabel(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error'
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && Number.isSafeInteger(status)
    ? `error=${name} status=${status}`
    : `error=${name}`
}

export interface Deadline {
  readonly signal: AbortSignal
  /** Clears the timer and aborts: whatever still holds a socket under this deadline lets it go. */
  end(): void
}

/** `ms` from now, and no later than `parent`. A timer of its own, so fake timers of a test drive it. */
export function deadline(ms: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, ms)
  timer.unref?.()
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    end() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
      abort()
    },
  }
}

/**
 * `work`, or what `onAbort` gives (or throws) as soon as the signal aborts: an adapter or a store that does
 * not honour the deadline must not hold the request past it. A late settlement of `work` is swallowed.
 */
async function settleBy<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
  work.catch(() => undefined)
  let stop: (() => void) | undefined
  const aborted = new Promise<T>((resolve, reject) => {
    stop = () => {
      try {
        resolve(onAbort())
      } catch (error) {
        reject(error)
      }
    }
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    if (stop) signal.removeEventListener('abort', stop)
  }
}

type Refused = { ok: false; reason: ConnectionCheckReason }

const unreachable = (): Refused => ({ ok: false, reason: 'unreachable' })

/** An adapter rejects with a reason; anything else is not the client's server answering. */
function refusalOf(error: unknown, signal: AbortSignal, kind: string): Refused {
  if (isSiteConnectionError(error)) return { ok: false, reason: error.reason }
  if (signal.aborted) return unreachable()
  console.warn(`site_connection_check_failed kind=${kind} ${failureLabel(error)}`)
  throw siteConnectionUnavailable()
}

/**
 * One check of the files of a site: the address resolved and pinned by the rule of spec §12, then the
 * adapter of the kind connects to that literal. `pinRequired`: false for the wizard's «Далее» (an sftp check
 * without a key answers `host_key_unknown` and logs in nowhere), true for create and replaceAccess.
 */
export async function checkSiteSource(
  services: SiteConnectionServices,
  request: { stack: SiteStack; source: CodeSourceInput; pinRequired: boolean; signal: AbortSignal },
): Promise<SourceCheckOutcome> {
  const { stack, source, pinRequired, signal } = request
  const adapter = services.sources(source.kind)
  const pinned = await resolvePinnedAddress(
    { lookup: services.lookup, appEnv: services.appEnv },
    adapter.endpoint(source).host,
    signal,
  )
  if (!pinned.ok) return { ok: false, reason: pinned.reason }
  try {
    return await settleBy(
      adapter.check(source, {
        address: pinned.address,
        signal,
        markers: services.rootMarkers(stack),
        pinRequired,
      }),
      signal,
      unreachable,
    )
  } catch (error) {
    return refusalOf(error, signal, source.kind)
  }
}

/** One check of a database: `SELECT 1` and the count of its tables, at the pinned address. */
export async function checkSiteDatabase(
  services: SiteConnectionServices,
  request: { database: DatabaseInput; signal: AbortSignal },
): Promise<DatabaseCheckOutcome> {
  const { database, signal } = request
  const inspector = services.databases(database.engine)
  const pinned = await resolvePinnedAddress(
    { lookup: services.lookup, appEnv: services.appEnv },
    inspector.endpoint(database).host,
    signal,
  )
  if (!pinned.ok) return { ok: false, reason: pinned.reason }
  try {
    return await settleBy(
      inspector.check(database, { address: pinned.address, signal }),
      signal,
      unreachable,
    )
  } catch (error) {
    return refusalOf(error, signal, database.engine)
  }
}

/**
 * The checks of one request inside the limits of the wizard (site-connection-gate.ts): the files and, when
 * given, the database, in parallel under one deadline of `ms` (and no later than `parent`). A refused login
 * is counted against its endpoint.
 */
export async function gatedChecks(
  services: SiteConnectionServices,
  request: {
    userId: string
    /** A check of «Далее» costs 1, create and replaceAccess cost 2. */
    units: number
    stack: SiteStack
    source: CodeSourceInput
    database: DatabaseInput | null
    pinRequired: boolean
    ms: number
    parent?: AbortSignal
  },
): Promise<{ source: SourceCheckOutcome; database: DatabaseCheckOutcome | null }> {
  const { userId, stack, source, database, pinRequired } = request
  const sourceEndpoint = services.sources(source.kind).endpoint(source)
  const databaseEndpoint = database ? services.databases(database.engine).endpoint(database) : null
  const outcomes = await passSiteConnectionGate(
    {
      userId,
      units: request.units,
      endpoints: databaseEndpoint ? [sourceEndpoint, databaseEndpoint] : [sourceEndpoint],
    },
    async () => {
      const checks = deadline(request.ms, request.parent)
      try {
        const [sourceOutcome, databaseOutcome] = await Promise.all([
          checkSiteSource(services, { stack, source, pinRequired, signal: checks.signal }),
          database ? checkSiteDatabase(services, { database, signal: checks.signal }) : null,
        ])
        return { source: sourceOutcome, database: databaseOutcome }
      } finally {
        checks.end()
      }
    },
  )
  if (!outcomes.source.ok && outcomes.source.reason === 'auth_failed')
    noteRefusedLogin(userId, sourceEndpoint)
  if (
    databaseEndpoint &&
    outcomes.database?.ok === false &&
    outcomes.database.reason === 'auth_failed'
  )
    noteRefusedLogin(userId, databaseEndpoint)
  return outcomes
}

/** The fields of a refused source check the wizard shows: the reason, and the folder or key it offers. */
export function sourceRefusal(outcome: Extract<SourceCheckOutcome, { ok: false }>) {
  return {
    reason: outcome.reason,
    ...(outcome.suggestedRoot === undefined ? {} : { suggestedRoot: outcome.suggestedRoot }),
    ...(outcome.hostKey === undefined ? {} : { hostKey: outcome.hostKey }),
  }
}

/** A prepared access no larger than one secret may be (it stays under the request limit of the KV adapter). */
export function boundedAccess<Target>(prepared: PreparedAccess<Target>): PreparedAccess<Target> {
  if (
    Buffer.byteLength(JSON.stringify(prepared.secret), 'utf8') > siteConnectionLimits.secretBytes
  ) {
    throw new DomainError('BAD_REQUEST', 'The access is larger than a site secret may be', 400)
  }
  return prepared
}

/**
 * Writes the next version of one secret with CAS: the version Vault holds now (0 for none, a deleted
 * version counts) is the one the write must find, and the written version must be the one after it — two
 * writers of one path cannot both believe they wrote it. Returns the written version, the `key_version` of
 * the reference. Any failure of the store, a refused CAS included, is SITE_CONNECTION_UNAVAILABLE.
 */
export async function writeSiteSecret(
  secrets: SiteConnectionServices['secrets'],
  request: { path: string; data: Record<string, string>; signal: AbortSignal },
): Promise<number> {
  const { path, data, signal } = request
  const late = () => {
    throw siteConnectionUnavailable()
  }
  try {
    const current = (await settleBy(secrets.kvMetadata(path), signal, late))?.currentVersion ?? 0
    const { version } = await settleBy(secrets.kvWrite(path, data, { cas: current }), signal, late)
    if (version !== current + 1) throw new Error('Unexpected secret version')
    return version
  } catch (error) {
    if (isDomainError(error)) throw error
    console.warn(`site_connection_secret_failed ${failureLabel(error)}`)
    throw siteConnectionUnavailable()
  }
}

/** The columns of site_code_sources from the public half of a checked access, besides the ids. */
export const codeSourceColumns = (target: CodeSourceTarget) => ({
  kind: target.kind,
  host: target.host,
  port: target.port,
  rootPath: target.rootPath,
  repositoryUrl: target.repositoryUrl,
  branch: target.branch,
  tls: target.tls,
  hostKey: target.hostKey,
})

/** The columns of site_databases, besides the ids. */
export const databaseColumns = (target: DatabaseTarget) => ({
  engine: target.engine,
  host: target.host,
  port: target.port,
  databaseName: target.databaseName,
  tls: target.tls,
})

/** A checked access stored: what its reference and its row are written from. */
export interface StoredAccess<Target> {
  accessKind: SiteAccessKind
  target: Target
  /** The canonical path `siteAccessPath(siteId, accessKind)`. */
  vaultPath: string
  /** The `key_version` of the reference. */
  version: number
}

/** The secret of a prepared access as the next version at the path of its kind of this site. */
export async function storeSiteAccess<Target>(
  secrets: SiteConnectionServices['secrets'],
  request: { siteId: string; prepared: PreparedAccess<Target>; signal: AbortSignal },
): Promise<StoredAccess<Target>> {
  const { accessKind, secret, target } = boundedAccess(request.prepared)
  const vaultPath = siteAccessPath(request.siteId, accessKind)
  const version = await writeSiteSecret(secrets, {
    path: vaultPath,
    data: secret,
    signal: request.signal,
  })
  return { accessKind, target, vaultPath, version }
}

/**
 * Secrets of a site were written and nothing in PostgreSQL refers to them now — the transaction after them
 * failed, or a replaced access left the secret of its old kind. One line, the site id only; the next
 * request with the same key writes a newer version over the same path, and only an operator deletes them.
 */
export function logOrphanedSecrets(siteId: string): void {
  console.warn(`site_connection_orphan site=${siteId}`)
}
