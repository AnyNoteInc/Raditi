import type { PrismaClient } from '@repo/db'
import { withTimeout } from '@repo/domain'

/** Disconnects the one database pool of the role within `withinMs`. */
export type DatabaseShutdown = (withinMs: number) => Promise<void>

/**
 * Not PrismaLifecycle, whose disconnect has no bound: a query that stays stuck must not hold the
 * stop past the stop grace period of the service. It warns instead and lets the process exit.
 */
export function databaseShutdown(
  prisma: Pick<PrismaClient, '$disconnect'>,
  logger: { warn(message: string): void },
): DatabaseShutdown {
  return (withinMs) =>
    withTimeout(prisma.$disconnect(), withinMs, 'LLM database shutdown timed out').catch(() => {
      logger.warn(JSON.stringify({ event: 'llm_database_shutdown_timeout' }))
    })
}
