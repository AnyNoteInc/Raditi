import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { MCP_CONFIG } from '../config/config.module.ts'
import { MCP_ACCESS, PostgresMcpAccess } from './mcp-access.ts'
import { MCP_SECURITY, mcpSecurityOf } from './mcp-policy.ts'

/**
 * Who may call the role: the admission of a turn token (the paired hash, its assignment and the
 * site lease) and the security of the endpoint — the exact upstream hosts and the tool families
 * the profiles open. The guard of /mcp and the health probe both use this one store.
 */
@Module({
  providers: [
    {
      provide: MCP_ACCESS,
      inject: [PRISMA],
      useFactory: (prisma: PrismaClient) => new PostgresMcpAccess(prisma),
    },
    { provide: MCP_SECURITY, inject: [MCP_CONFIG], useFactory: mcpSecurityOf },
  ],
  exports: [MCP_ACCESS, MCP_SECURITY],
})
export class AccessModule {}
