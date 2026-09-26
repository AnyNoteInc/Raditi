import { createPrismaClient, type DbConfig, type PrismaClient } from '@repo/db'

/**
 * No prisma:error lines: failures reach the callers, which log them (the outbox relay
 * throttled), and /health reports the database as down. Otherwise every relay pass and
 * every probe prints one while PostgreSQL is away.
 */
export const PRISMA_LOG_LEVELS = ['warn'] as const

/** A relay pass or query waits this long for a pool connection while PostgreSQL is away. */
export const PRISMA_CONNECTION_TIMEOUT_MS = 3_000

/** The one client of a role process; connects on first use. */
export function createOrchestratorPrisma(db: DbConfig): PrismaClient {
  return createPrismaClient({
    ...db,
    log: PRISMA_LOG_LEVELS,
    connectionTimeoutMs: PRISMA_CONNECTION_TIMEOUT_MS,
  })
}
