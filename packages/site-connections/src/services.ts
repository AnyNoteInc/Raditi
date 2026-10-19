import type {
  AppEnv,
  DatabaseEngine,
  HostLookup,
  SecretStore,
  SiteConnectionServices,
  SiteStack,
} from '@repo/domain'

import { databaseInspector } from './databases/index.ts'
import { createHostLookup } from './lookup.ts'
import { offeredSourceKinds, siteSource } from './sources/registry.ts'

export interface SiteConnectionServicesDeps {
  appEnv: AppEnv
  /** The store of the caller; only its two write-side methods are kept. */
  secrets: Pick<SecretStore, 'kvWrite' | 'kvMetadata'>
  connectableStacks: readonly SiteStack[]
  rootMarkers: (stack: SiteStack) => readonly string[]
  /** The resolver of every check; a fresh c-ares lookup by default. */
  lookup?: HostLookup
}

/** What the wizard offers, in its order: «PostgreSQL», «MySQL». */
const offeredDatabaseEngines = ['postgres', 'mysql'] as const satisfies readonly DatabaseEngine[]

/**
 * What `apps/web` puts into the tRPC context. The secrets object is a new one with two methods bound
 * to the store, never the store itself: a procedure cannot reach `kvRead` (or anything else the store
 * has) through it, its prototype or a cast — the `sites-writer` policy says the same in Vault.
 */
export function createSiteConnectionServices(
  deps: SiteConnectionServicesDeps,
): SiteConnectionServices {
  const { secrets } = deps
  const writeOnly: SiteConnectionServices['secrets'] = Object.freeze(
    Object.assign(Object.create(null) as object, {
      kvWrite: (...args: Parameters<SecretStore['kvWrite']>) => secrets.kvWrite(...args),
      kvMetadata: (path: string) => secrets.kvMetadata(path),
    }),
  )
  return Object.freeze({
    appEnv: deps.appEnv,
    secrets: writeOnly,
    lookup: deps.lookup ?? createHostLookup(),
    connectableStacks: Object.freeze([...deps.connectableStacks]),
    rootMarkers: (stack: SiteStack) => deps.rootMarkers(stack),
    sources: siteSource,
    databases: databaseInspector,
    sourceOptions: Object.freeze(
      offeredSourceKinds.map((kind) =>
        Object.freeze({ kind, defaultPort: siteSource(kind).defaultPort }),
      ),
    ),
    databaseOptions: Object.freeze(
      offeredDatabaseEngines.map((engine) =>
        Object.freeze({ engine, defaultPort: databaseInspector(engine).defaultPort }),
      ),
    ),
  })
}
