import { once } from 'node:events'
import { PassThrough, pipeline } from 'node:stream'
import { createGunzip } from 'node:zlib'

import type { PrismaClient } from '@repo/db'
import {
  databaseDumpLimits,
  databaseDumpLocation,
  databaseDumpPathSchema,
  dbAccessSchema,
  resolvePinnedAddress,
  siteAccessPath,
  type AppEnv,
  type CodeSourceTarget,
  type DatabaseEngine,
  type DatabaseInspector,
  type DatabaseTarget,
  type DbAccess,
  type FileSourceEntry,
  type FileSourceSession,
  type HostLookup,
  type SecretStore,
  type SiteAccessKind,
  type SiteSourceAdapter,
  type SiteSourceKind,
} from '@repo/domain'

import { readRootFile } from '../site-provisioning/tree-walk.ts'

// The site as the connection wizard recorded it (docs/plan/39-site-connection-wizard.md): where
// its files are (`site_code_sources`) and where its database is (`site_databases`), each with its
// one credential reference. A preview reads both the way the initial import does: the reference
// is of the adapter's kind, of the site and its workspace, at the one canonical path; the secret
// is read at the version the reference names — a newer one a request wrote before it failed to
// move the reference does not stand in for it — and agrees with the row on everything both hold.

/** A file of the site's document root on its hosting, as `SiteAdapter.databaseSettings` reads it. */
export type SiteRootRead = (path: string) => Promise<Uint8Array | null>

export type SiteDatabaseAccess =
  | { ok: true; access: DbAccess }
  /** `access_missing`: no reference or no secret; `access_mismatch`: they do not agree. */
  | { ok: false; code: 'access_missing' | 'access_mismatch' }

/** A dump read over the site's file source: the answer of `use`, or why there was none. */
export type SiteDumpRead<T> =
  | { ok: true; value: T }
  | {
      ok: false
      /**
       * `dump_source_missing`: no file source to read it through, or its access does not agree;
       * `dump_not_found`: no such file there; `dump_too_large`: the file is over
       * databaseDumpLimits.fileBytes; `dump_unreadable`: the server could not be reached or read.
       */
      code: 'dump_source_missing' | 'dump_not_found' | 'dump_too_large' | 'dump_unreadable'
    }

export interface PreviewSiteSources {
  /**
   * The access to the site's database: by its `site_databases` row and that row's reference, or —
   * for a site connected before the wizard, without the row — by its one reference of kind `db`.
   */
  databaseAccess(siteId: string): Promise<SiteDatabaseAccess>
  /**
   * `use` with a reader of the site's document root through its file source, the session closed
   * after. null — the site has no file source, or it could not be opened or read: the caller
   * decides without the configuration on the hosting.
   */
  withRoot<T>(
    siteId: string,
    signal: AbortSignal,
    use: (read: SiteRootRead) => Promise<T>,
  ): Promise<T | null>
  /**
   * `use` with the SQL dump at `path` (relative to the login folder of the site's file source,
   * databaseDumpPathSchema) as it streams from the server — gunzipped for `.sql.gz` —, the
   * session closed after. A failure of `use` itself is thrown as it is.
   */
  withDump<T>(
    siteId: string,
    path: string,
    signal: AbortSignal,
    use: (dump: AsyncIterable<Uint8Array>) => Promise<T>,
  ): Promise<SiteDumpRead<T>>
}

export interface PreviewSiteSourcesDeps {
  db: Pick<PrismaClient, 'site' | 'credentialRef'>
  secrets: Pick<SecretStore, 'kvRead'>
  /** The file sources of @repo/site-connections, by kind: no kind is compared here. */
  sources: (kind: SiteSourceKind) => SiteSourceAdapter
  /** The database inspectors of @repo/site-connections, by engine. */
  databases: (
    engine: DatabaseEngine,
  ) => Pick<DatabaseInspector, 'accessKind' | 'accessSchema' | 'matchesTarget'>
  lookup: HostLookup
  appEnv: AppEnv
  /** The longest a read of the configuration may take, the login included. */
  readMs?: number
}

/** One configuration file over a fresh session: a minute is plenty, a stuck server is not waited on. */
const ROOT_READ_MS = 60_000

const referenceSelect = {
  kind: true,
  siteId: true,
  workspaceId: true,
  vaultPath: true,
  keyVersion: true,
} as const

interface Reference {
  kind: string
  siteId: string | null
  workspaceId: string | null
  vaultPath: string
  keyVersion: number
}

type Read = { ok: true; data: Record<string, string> } | Extract<SiteDatabaseAccess, { ok: false }>

/** The secret a reference names, read at that version; nothing about it is trusted unchecked. */
async function readReferenced(
  deps: PreviewSiteSourcesDeps,
  site: { id: string; workspaceId: string },
  reference: Reference | null,
  kind: SiteAccessKind,
): Promise<Read> {
  if (!reference) return { ok: false, code: 'access_missing' }
  if (
    reference.kind !== kind ||
    reference.siteId !== site.id ||
    reference.workspaceId !== site.workspaceId ||
    reference.vaultPath !== siteAccessPath(site.id, kind) ||
    !Number.isSafeInteger(reference.keyVersion) ||
    reference.keyVersion < 1
  )
    return { ok: false, code: 'access_mismatch' }
  const secret = await deps.secrets.kvRead(reference.vaultPath, { version: reference.keyVersion })
  if (!secret) return { ok: false, code: 'access_missing' }
  if (secret.version !== reference.keyVersion) return { ok: false, code: 'access_mismatch' }
  return { ok: true, data: secret.data }
}

export function createPreviewSiteSources(deps: PreviewSiteSourcesDeps): PreviewSiteSources {
  return {
    async databaseAccess(siteId) {
      const site = await deps.db.site.findUnique({
        where: { id: siteId },
        select: {
          id: true,
          workspaceId: true,
          database: {
            select: {
              engine: true,
              host: true,
              port: true,
              databaseName: true,
              tls: true,
              credentialRef: { select: referenceSelect },
            },
          },
        },
      })
      if (!site) return { ok: false, code: 'access_missing' }
      const row = site.database
      if (!row) {
        // A site from before the wizard: its one reference of kind `db`, at the one path.
        const references = await deps.db.credentialRef.findMany({
          where: { siteId, kind: 'db' },
          select: referenceSelect,
          take: 2,
        })
        if (references.length > 1) return { ok: false, code: 'access_mismatch' }
        const read = await readReferenced(deps, site, references[0] ?? null, 'db')
        if (!read.ok) return read
        const access = dbAccessSchema.safeParse(read.data)
        return access.success
          ? { ok: true, access: access.data }
          : { ok: false, code: 'access_mismatch' }
      }
      let inspector: ReturnType<PreviewSiteSourcesDeps['databases']>
      try {
        inspector = deps.databases(row.engine)
      } catch {
        return { ok: false, code: 'access_mismatch' }
      }
      const read = await readReferenced(deps, site, row.credentialRef, inspector.accessKind)
      if (!read.ok) return read
      const checked = inspector.accessSchema.safeParse(read.data)
      const access = dbAccessSchema.safeParse(read.data)
      const target: DatabaseTarget = {
        engine: row.engine,
        host: row.host,
        port: row.port,
        databaseName: row.databaseName,
        tls: row.tls,
      }
      if (!checked.success || !access.success || !inspector.matchesTarget(checked.data, target))
        return { ok: false, code: 'access_mismatch' }
      return { ok: true, access: access.data }
    },

    async withRoot(siteId, signal, use) {
      const source = await fileSource(deps, siteId)
      if (!source) return null
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(deps.readMs ?? ROOT_READ_MS)])
      let session: FileSourceSession | null = null
      try {
        const opened = await openSource(deps, source, source.access, bounded)
        if (!opened) return null
        session = opened
        return await use((path) => readRootFile(opened, path, bounded))
      } catch {
        signal.throwIfAborted()
        return null
      } finally {
        await session?.close().catch(() => {})
      }
    },

    async withDump(siteId, path, signal, use) {
      const parsed = databaseDumpPathSchema.safeParse(path)
      if (!parsed.success) return { ok: false, code: 'dump_not_found' }
      const location = databaseDumpLocation(parsed.data)
      const source = await fileSource(deps, siteId)
      if (!source) return { ok: false, code: 'dump_source_missing' }
      // The same access, opened at the dump's folder instead of the site's: below the login folder.
      const moved = source.adapter.accessSchema.safeParse({
        ...source.raw,
        rootPath: location.folder,
      })
      if (!moved.success) return { ok: false, code: 'dump_source_missing' }
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(databaseDumpLimits.loadMs)])
      let session: FileSourceSession | null = null
      let entry: FileSourceEntry | undefined
      try {
        session = await openSource(deps, source, moved.data, bounded)
        if (!session) return { ok: false, code: 'dump_unreadable' }
        const entries = await session.list([], DUMP_FOLDER_ENTRIES)
        entry = entries.find((item) => item.type === 'file' && item.name === location.file)
      } catch {
        signal.throwIfAborted()
        await session?.close().catch(() => {})
        // A folder that does not open is not there; the login folder always is.
        return { ok: false, code: location.folder === '.' ? 'dump_unreadable' : 'dump_not_found' }
      }
      const opened = session
      if (!entry || entry.size > databaseDumpLimits.fileBytes) {
        await opened.close().catch(() => {})
        return { ok: false, code: entry ? 'dump_too_large' : 'dump_not_found' }
      }
      const { ref } = entry
      try {
        const value = await streamDump(
          (sink) => opened.read([ref], sink, databaseDumpLimits.fileBytes),
          location.gzip,
          use,
        )
        return { ok: true, value }
      } finally {
        await opened.close().catch(() => {})
      }
    },
  }
}

/** Entries of the folder of a dump that are looked through for its name. */
const DUMP_FOLDER_ENTRIES = 10_000

interface FileSource {
  adapter: Extract<SiteSourceAdapter, { transfer: 'files' }>
  /** The secret as Vault holds it: what a moved root is made of. */
  raw: Record<string, string>
  access: unknown
}

/** The site's file source with its access, checked against the row; null — none to read. */
async function fileSource(
  deps: PreviewSiteSourcesDeps,
  siteId: string,
): Promise<FileSource | null> {
  const site = await deps.db.site.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      workspaceId: true,
      codeSource: {
        select: {
          kind: true,
          host: true,
          port: true,
          rootPath: true,
          repositoryUrl: true,
          branch: true,
          tls: true,
          hostKey: true,
          credentialRef: { select: referenceSelect },
        },
      },
    },
  })
  const source = site?.codeSource
  if (!site || !source) return null
  let adapter: SiteSourceAdapter
  try {
    adapter = deps.sources(source.kind)
  } catch {
    return null
  }
  // The adapter says how its tree is obtained: only a file source has a document root to read.
  if (adapter.transfer !== 'files') return null
  const read = await readReferenced(deps, site, source.credentialRef, adapter.accessKind)
  if (!read.ok) return null
  const access = adapter.accessSchema.safeParse(read.data)
  const target: CodeSourceTarget = {
    kind: source.kind,
    host: source.host,
    port: source.port,
    rootPath: source.rootPath,
    repositoryUrl: source.repositoryUrl,
    branch: source.branch,
    tls: source.tls,
    hostKey: source.hostKey,
  }
  if (!access.success || !adapter.matchesTarget(access.data, target)) return null
  return { adapter, raw: read.data, access: access.data }
}

/** A session of the source at `access`, dialled at the pinned address; null — not allowed. */
async function openSource(
  deps: PreviewSiteSourcesDeps,
  source: FileSource,
  access: unknown,
  signal: AbortSignal,
): Promise<FileSourceSession | null> {
  // The address the secret names, by the rule of the wizard: the one literal every socket dials.
  const pinned = await resolvePinnedAddress(
    { lookup: deps.lookup, appEnv: deps.appEnv },
    source.adapter.endpointOf(access).host,
    signal,
  )
  if (!pinned.ok) return null
  return source.adapter.open(access, { address: pinned.address, signal })
}

/**
 * `use` with the bytes `read` pushes as they come, gunzipped when asked: the read waits while
 * `use` is behind (backpressure), and stops when `use` is done or failed. A failed read is the
 * failure of the stream `use` reads.
 */
export async function streamDump<T>(
  read: (sink: (chunk: Uint8Array) => Promise<void>) => Promise<number>,
  gzip: boolean,
  use: (dump: AsyncIterable<Uint8Array>) => Promise<T>,
): Promise<T> {
  const raw = new PassThrough({ highWaterMark: 1024 * 1024 })
  const out = gzip ? createGunzip() : raw
  if (gzip) pipeline(raw, out, () => {})
  const sink = async (chunk: Uint8Array) => {
    if (raw.destroyed) throw new Error('The dump is no longer read')
    if (!raw.write(chunk)) await Promise.race([once(raw, 'drain'), once(raw, 'close')])
  }
  const reading = read(sink).then(
    () => {
      raw.end()
    },
    (error: unknown) => {
      raw.destroy(error instanceof Error ? error : new Error('The dump could not be read'))
    },
  )
  try {
    return await use(out)
  } finally {
    raw.destroy()
    out.destroy()
    await reading
  }
}
