import { Module, type Logger } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { EgressHttp, LlmBackend, SecretStore } from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import { EgressHealth } from '../egress/egress-probe.ts'
import { EgressModule } from '../egress/egress.module.ts'
import { CONTROL_HTTP, REGION_HTTP } from '../egress/egress.tokens.ts'
import { LLM_BACKENDS, LLM_LOGGER } from '../infra/infra.tokens.ts'
import { createCredentialSource, type CredentialSource } from './credentials.ts'
import { SubscriptionPoolHealth } from './pool-health.ts'
import { CREDENTIAL_SOURCE } from './pool.tokens.ts'

/** The accounts of the pool: their keys and their health, probed through the gates of egress. */
@Module({
  imports: [EgressModule],
  providers: [
    {
      provide: CREDENTIAL_SOURCE,
      useFactory: (secrets: SecretStore) => createCredentialSource(secrets),
      inject: [SECRET_STORE],
    },
    {
      provide: SubscriptionPoolHealth,
      useFactory: (
        prisma: PrismaClient,
        credentials: CredentialSource,
        backends: readonly LlmBackend[],
        http: EgressHttp,
        regionHttp: EgressHttp,
        channel: EgressHealth,
        logger: Logger,
      ) =>
        new SubscriptionPoolHealth({
          prisma,
          credentials,
          backends,
          http,
          regionHttp,
          channelHealthy: () => channel.healthy(),
          onRegion: (accountId) => channel.blockRegion(accountId),
          logger,
        }),
      inject: [
        PRISMA,
        CREDENTIAL_SOURCE,
        LLM_BACKENDS,
        CONTROL_HTTP,
        REGION_HTTP,
        EgressHealth,
        LLM_LOGGER,
      ],
    },
  ],
  exports: [CREDENTIAL_SOURCE, SubscriptionPoolHealth],
})
export class PoolModule {}
