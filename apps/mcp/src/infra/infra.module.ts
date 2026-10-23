import { Global, Module } from '@nestjs/common'
import { createVaultSecretStore } from '@repo/vault'
import { SECRET_STORE } from '@repo/service-runtime'

import type { McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'

/**
 * Vault of the role, under its own AppRole in production (policy mcp-content). The database is
 * DatabaseModule of @repo/service-runtime, which AppModule imports with the role's settings
 * beside this one. Nothing connects here: Vault logs in on first use.
 */
@Global()
@Module({
  providers: [
    {
      provide: SECRET_STORE,
      inject: [MCP_CONFIG],
      useFactory: (config: McpConfig) => createVaultSecretStore(config.vault),
    },
  ],
  exports: [SECRET_STORE],
})
export class InfraModule {}
