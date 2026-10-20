import type { PrismaClient } from '@repo/db'
import {
  dbAccessSchema,
  resolvePinnedAddress,
  siteAccessPath,
  type AppEnv,
  type CodeSourceTarget,
  type DatabaseEngine,
  type DatabaseInspector,
  type DatabaseTarget,
  type DbAccess,
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

      const bounded = AbortSignal.any([signal, AbortSignal.timeout(deps.readMs ?? ROOT_READ_MS)])
      let session: FileSourceSession | null = null
      try {
        // The address the secret names, by the rule of the wizard: the one literal every socket dials.
        const pinned = await resolvePinnedAddress(
          { lookup: deps.lookup, appEnv: deps.appEnv },
          adapter.endpointOf(access.data).host,
          bounded,
        )
        if (!pinned.ok) return null
        const opened = await adapter.open(access.data, { address: pinned.address, signal: bounded })
        session = opened
        return await use((path) => readRootFile(opened, path, bounded))
      } catch {
        signal.throwIfAborted()
        return null
      } finally {
        await session?.close().catch(() => {})
      }
    },
  }
}
