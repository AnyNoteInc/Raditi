import { PrismaPg } from '@prisma/adapter-pg'
import { parseEnv, type Env } from '@repo/domain'
import { z } from 'zod'

import { PrismaClient, type Prisma } from './generated/prisma/client.ts'

export interface DbConfig {
  databaseUrl: string
}

export interface CreatePrismaClientOptions extends DbConfig {
  /**
   * Levels Prisma prints to the console; defaults to warn and error. Pass fewer to keep
   * prisma:error quiet while a health check already reports the database as down.
   */
  log?: readonly Prisma.LogLevel[]
  /**
   * How long to wait for a pool connection. The pg default is 0 (forever): with the database
   * unreachable every health probe and relay pass would pile up waiters.
   */
  connectionTimeoutMs?: number
}

const DEFAULT_LOG_LEVELS: readonly Prisma.LogLevel[] = ['warn', 'error']
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000

const dbEnvSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'is not set' })
    .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// connection string'),
})

export function dbConfigFromEnv(env: Env): DbConfig {
  return { databaseUrl: parseEnv('db', dbEnvSchema, env).DATABASE_URL }
}

export function createPrismaClient({
  databaseUrl,
  log = DEFAULT_LOG_LEVELS,
  connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
}: CreatePrismaClientOptions): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseUrl,
      connectionTimeoutMillis: connectionTimeoutMs,
    }),
    log: [...log],
  })
}

// Survives module reloads in dev (Next.js HMR) so connections are not leaked.
const globalForPrisma = globalThis as typeof globalThis & { __raditiPrisma?: PrismaClient }

/** The process-wide client; reads DATABASE_URL on first use, not on import. */
export function getPrisma(): PrismaClient {
  globalForPrisma.__raditiPrisma ??= createPrismaClient(dbConfigFromEnv(process.env))
  return globalForPrisma.__raditiPrisma
}

/**
 * Lazy handle to the process-wide client: importing @repo/db in unit tests or during
 * a build does not need DATABASE_URL; the first property access creates the client.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    // Not a thenable: `await` or a logger probing `then` must not open a connection.
    if (property === 'then') return undefined
    const client = getPrisma()
    const value: unknown = Reflect.get(client, property, client)
    return typeof value === 'function' ? value.bind(client) : value
  },
  has(_target, property) {
    return Reflect.has(getPrisma(), property)
  },
})
