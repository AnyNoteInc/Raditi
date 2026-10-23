import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { SecretStore } from '@repo/domain'
import { databaseCheck, s3Check, vaultCheck, type HealthChecks } from '@repo/observability'
import { HealthModule, PRISMA, SECRET_STORE } from '@repo/service-runtime'

import { AccessModule } from '../access/access.module.ts'
import { MCP_ACCESS, MCP_ACCESS_PROBE_TOKEN, type McpAccessStore } from '../access/mcp-access.ts'
import { mcpErrorSummary } from '../common/mcp-http-error.ts'
import { MCP_CONTENT_STORAGE, type ContentStorage } from '../storage/content-storage.ts'

/** What GET /health of the role checks; the bucket only while a profile holds one. */
export function mcpHealthChecks(
  prisma: PrismaClient,
  secrets: SecretStore,
  access: McpAccessStore,
  storage?: ContentStorage,
): HealthChecks {
  return {
    database: databaseCheck(() => prisma),
    vault: vaultCheck(() => secrets),
    // The one bucket of the role: without it no snapshot, so no content change.
    ...(storage ? { s3: s3Check(() => storage, ['artifacts']) } : {}),
    // The admission query itself: a schema it no longer matches (a migration not
    // applied) turns every agent request into 503 while SELECT 1 still passes.
    access: async () => {
      try {
        return (await access.authenticate(MCP_ACCESS_PROBE_TOKEN)) === null
      } catch (error) {
        // Health logs the message only; the cause stays in memory.
        throw new Error(mcpErrorSummary(error), { cause: error })
      }
    },
  }
}

/**
 * GET /health of the role: status only, never the details (no operator token on the port the
 * sandboxes reach), and no /metrics beside it.
 */
@Module({
  imports: [
    HealthModule.forRootAsync({
      imports: [AccessModule],
      inject: [PRISMA, SECRET_STORE, MCP_ACCESS, { token: MCP_CONTENT_STORAGE, optional: true }],
      useFactory: mcpHealthChecks,
    }),
  ],
})
export class McpHealthModule {}
