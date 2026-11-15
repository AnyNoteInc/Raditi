import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { SecretStore } from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import { AccessModule } from '../access/access.module.ts'
import { MCP_ACCESS, type McpAccessStore } from '../access/mcp-access.ts'
import { MCP_SECURITY, type McpSecurity } from '../access/mcp-policy.ts'
import type { McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'
import { SkillRelay } from './skill-relay.ts'
import { MCP_SKILL_RELAY } from './skill-relay.tokens.ts'
import { SkillSecrets } from './skill-secrets.ts'
import { PostgresSkillServers } from './skill-servers.ts'
import { upstreamResolver } from './upstream.ts'

/**
 * The relay of MCP servers with authorization (docs/plan/80-mcp-server-credentials.md): no
 * profile, a product path of every composition. It has nothing to relay until an owner adds a
 * server with a key or a sign-in; the key stays in this role, the sandbox gets only the relay's
 * path and the turn's MCP token.
 */
@Module({
  imports: [AccessModule],
  providers: [
    {
      provide: MCP_SKILL_RELAY,
      inject: [MCP_CONFIG, PRISMA, SECRET_STORE, MCP_ACCESS, MCP_SECURITY],
      useFactory: (
        config: McpConfig,
        prisma: PrismaClient,
        secrets: SecretStore,
        access: McpAccessStore,
        security: McpSecurity,
      ) =>
        new SkillRelay({
          access,
          security,
          servers: new PostgresSkillServers(prisma),
          secrets: new SkillSecrets(secrets),
          resolve: upstreamResolver({
            refusedSubnets: config.skillRelay?.refusedSubnets ?? [],
            allowLoopback: config.skillRelay?.allowLoopback ?? false,
          }),
        }),
    },
  ],
  exports: [MCP_SKILL_RELAY],
})
export class SkillRelayModule {}
