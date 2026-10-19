import 'server-only'

import type { SiteConnectionServices } from '@repo/domain'
import { connectableStacks, getSiteAdapter } from '@repo/site-adapters'
import { createSiteConnectionServices } from '@repo/site-connections/services'
import { createVaultSecretStore } from '@repo/vault'

import { env } from '@/env'

let services: { value: SiteConnectionServices | null } | undefined

/**
 * What the site connection wizard checks and writes through (spec §12): DNS, the adapters of the
 * file sources and the databases, and a Vault store of which only `kvWrite` and `kvMetadata` are
 * reachable — no procedure can read a secret back, as the `sites-writer` policy allows none.
 *
 * Built on first use, so neither the environment nor the drivers are touched when the module is
 * imported, and kept for the life of the process: the services hold the in-memory limits of the
 * checks. null — the `vault` or `web` section does not parse: projects cannot be created, every
 * other page and procedure works. That is said once, by the section's name only: a value or a
 * zod message could carry a secret.
 */
export function siteConnections(): SiteConnectionServices | null {
  if (services === undefined) {
    let config
    try {
      config = { vault: env.vault(), appEnv: env.web().appEnv }
    } catch {
      console.error('[web] site connections are off: the vault or web settings do not parse')
      services = { value: null }
      return null
    }
    const store = createVaultSecretStore(config.vault)
    services = {
      value: createSiteConnectionServices({
        appEnv: config.appEnv,
        // Two methods, not the store: nothing that holds this object can call `kvRead`.
        secrets: {
          kvWrite: (path, data, options) => store.kvWrite(path, data, options),
          kvMetadata: (path) => store.kvMetadata(path),
        },
        connectableStacks,
        rootMarkers: (stack) => getSiteAdapter(stack).rootMarkers(),
      }),
    }
  }
  return services.value
}
