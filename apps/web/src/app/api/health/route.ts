import { createPrismaClient, dbConfigFromEnv, type PrismaClient } from '@repo/db'
import type { ObjectStorage } from '@repo/domain'
import { createS3ObjectStorage } from '@repo/storage'
import { createVaultSecretStore } from '@repo/vault'
import { Redis } from 'ioredis'

import { env } from '@/env'
import {
  cachedHealthProbe,
  databaseCheck,
  healthResponse,
  redisCheck,
  s3Check,
  throttledHealthLogger,
  vaultCheck,
  WEB_BUCKETS,
} from '@/server/health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEPENDENCY_TIMEOUT_MS = 1_500

// One S3 client per process: it keeps its own connection pool.
let storage: ObjectStorage | undefined
const getStorage = (): ObjectStorage =>
  (storage ??= createS3ObjectStorage(env.storage(), undefined, {
    healthTimeoutMs: DEPENDENCY_TIMEOUT_MS,
  }))

// Its own client with no prisma:error lines: probes run every few seconds, and an outage is
// already logged by the throttled [health] line. Kept on globalThis so dev reloads reuse it.
const globalForHealth = globalThis as typeof globalThis & { __raditiHealthDb?: PrismaClient }
const getHealthDb = (): PrismaClient =>
  (globalForHealth.__raditiHealthDb ??= createPrismaClient({
    ...dbConfigFromEnv(process.env),
    log: ['warn'],
  }))

const connectRedis = (url: string) => {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: DEPENDENCY_TIMEOUT_MS,
    commandTimeout: DEPENDENCY_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  })
  // Failures surface through connect() and ping(); without a listener ioredis logs them too.
  client.on('error', () => {})
  return client
}

// One probe per process: reports are reused for a few seconds and concurrent calls share a run.
const probe = cachedHealthProbe(
  {
    database: databaseCheck(getHealthDb),
    redis: redisCheck(() => env.web().redisUrl, connectRedis),
    s3: s3Check(getStorage, WEB_BUCKETS),
    vault: vaultCheck(() =>
      createVaultSecretStore({ ...env.vault(), timeoutMs: DEPENDENCY_TIMEOUT_MS }),
    ),
  },
  { onFailure: throttledHealthLogger() },
)

/** Broken web settings: nobody gets the details, and the Redis check reports the problem. */
function metricsToken(): string | undefined {
  try {
    return env.web().metricsToken
  } catch {
    return undefined
  }
}

/**
 * Database, Redis, web's S3 buckets and Vault; 200 when all are reachable, 503 otherwise.
 * The body names the dependencies only for `Authorization: Bearer $METRICS_TOKEN`.
 */
export function GET(request: Request): Promise<Response> {
  return healthResponse(request, { probe, token: metricsToken() })
}
