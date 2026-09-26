import 'server-only'

import { authConfigFromEnv, type AuthConfig } from '@repo/auth'
import { storageConfigFromEnv, type StorageConfig } from '@repo/storage'
import { vaultConfigFromEnv, type VaultConfig } from '@repo/vault'
import { yookassaConfigFromEnv, type YookassaConfig } from '@repo/yookassa'

import { webEnvFromEnv } from '@/server/web-env'

// DATABASE_URL is read by @repo/db itself on first use (dbConfigFromEnv).

export { DEV_METRICS_TOKEN, type WebEnv } from '@/server/web-env'

/** Parses on first use and remembers the result; a failure is retried next time. */
function lazy<T>(read: () => T): () => T {
  let parsed: { value: T } | undefined
  return () => {
    parsed ??= { value: read() }
    return parsed.value
  }
}

/**
 * Server configuration, section by section. Nothing is read at import time, so `next build`
 * needs no secrets, and a broken section (say, S3) fails only the code that uses it.
 */
export const env = {
  web: lazy(() => webEnvFromEnv(process.env)),
  auth: lazy((): AuthConfig => authConfigFromEnv(process.env)),
  storage: lazy((): StorageConfig => storageConfigFromEnv(process.env)),
  vault: lazy((): VaultConfig => vaultConfigFromEnv(process.env)),
  yookassa: lazy((): YookassaConfig | null => yookassaConfigFromEnv(process.env)),
}
