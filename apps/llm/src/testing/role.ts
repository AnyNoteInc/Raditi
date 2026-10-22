import type { ModuleMetadata } from '@nestjs/common'
import { Test, type TestingModuleBuilder } from '@nestjs/testing'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { LlmRoleConfig } from '../config/config.ts'
import { llmConfigFromEnv } from '../config/llm-config.ts'

/** The configuration of a test role; with `withEgress`, the proxy of egress-1 (files unread). */
export const testRoleConfig = (withEgress = false): LlmRoleConfig => ({
  ...llmConfigFromEnv(
    {
      ...(withEgress
        ? {
            LLM_EGRESS_PROXY_URL: 'https://127.0.0.1:8443',
            LLM_EGRESS_CA_FILE: '/test/ca.pem',
            LLM_EGRESS_CLIENT_CERT_FILE: '/test/client.pem',
            LLM_EGRESS_CLIENT_KEY_FILE: '/test/client.key',
          }
        : {}),
    },
    'test',
  ),
  db: { databaseUrl: 'postgresql://unused' },
  vault: { addr: 'http://unused' },
  metricsToken: 'test',
})

/**
 * Modules of the role over fakes of its two clients: no database and no Vault. `imports` names
 * the root — AppModule.forRoot(config), or the configuration, InfraModule and the modules under
 * test.
 */
export function testRole(
  imports: NonNullable<ModuleMetadata['imports']>,
  {
    prisma = { $disconnect: async () => {} },
    secrets = {},
  }: { prisma?: object; secrets?: object } = {},
): TestingModuleBuilder {
  return Test.createTestingModule({ imports })
    .overrideProvider(PRISMA)
    .useValue(prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(secrets)
}
